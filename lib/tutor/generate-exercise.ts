import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getTracedStructuredCompletion } from "@/lib/llm/tracing";
import {
  buildDiagnosticPrompt,
  buildDiagnosticRetryPrompt,
} from "@/lib/llm/prompts/diagnostic-exercise";
import {
  buildAdaptivePrompt,
  buildAdaptiveRetryPrompt,
} from "@/lib/llm/prompts/adaptive-exercise";
import {
  GeneratedExerciseSchema,
  EXERCISE_DIFFICULTY_LEVELS,
  type ConceptTag,
  type ExerciseVariant,
  type ExerciseDifficultyLevel,
  type GeneratedExercise,
} from "@/lib/schemas/exercise";
import { insertExercise } from "@/lib/db/queries/exercises";
import {
  getCompanyLedgerRegistry,
  getRecentCompanyTransactionLog,
  getCompanyName,
  getExpectedCashPosition,
  getExpectedOpeningBalances,
  registerCompanyLedgers,
  appendCompanyTransactionLog,
} from "@/lib/db/queries/company";
import { insertSourceDocument } from "@/lib/db/queries/source-documents";
import {
  generateVendorInvoiceDocument,
  generateBankStatementDocument,
} from "@/lib/documents/generate-source-document";
import { renderSourceDocumentPdf } from "@/lib/documents/render-source-document";
import type {
  BankStatementLineInput,
  VendorInvoiceInput,
} from "@/lib/llm/prompts/source-document";
import type { GeneratedSourceDocument } from "@/lib/schemas/source-document";
import type { WeakConceptTarget } from "@/lib/tutor/mastery";
import type { LicenseMode } from "@/lib/schemas/onboarding";

const MAX_ATTEMPTS = 3;

// Voucher types whose "document" in real life is a line on the bank
// statement, never a vendor invoice — a contra transfer, a customer receipt,
// or a payment cannot arrive as a bill. The LLM sometimes marks these
// vendor_invoice anyway (observed live 2026-09-01 as "Invoice — HDFC
// Bank.pdf" and "Invoice — TDS Payable.pdf" cards), so the doc type is
// normalized deterministically here rather than trusted.
const BANK_SIDE_VOUCHER_TYPES = new Set(["contra", "receipt", "payment"]);

export type SourceDocumentPlan = {
  // One vendor invoice per transaction (each real bill IS its own document),
  // carrying the transaction's COMPLETE leg set + description so the invoice
  // generator can pin base/tax/total/date to the answer key exactly
  // (2026-09-01: single-leg grounding let every delivered invoice contradict
  // its key).
  invoices: VendorInvoiceInput[];
  // ALL bank-side transactions of the batch, destined for ONE combined
  // statement — a real statement lists every movement of the period.
  bankLines: BankStatementLineInput[];
};

// Pure planner for which documents an exercise gets — exported for tests.
// Dedupes by sequence (the answer key is one entry PER LEG, so a two-leg
// transaction flagged on both legs previously produced two identical PDFs),
// normalizes bank-side voucher types to bank_statement, and splits into
// per-bill invoices vs. the single combined statement's lines.
export function planSourceDocuments(
  generated: GeneratedExercise,
): SourceDocumentPlan {
  const descriptionBySequence = new Map<number, string>();
  for (const transaction of generated.transactions) {
    descriptionBySequence.set(transaction.sequence, transaction.description);
  }

  const seenSequences = new Set<number>();
  const plan: SourceDocumentPlan = { invoices: [], bankLines: [] };

  for (const entry of generated.answer_key.entries) {
    if (
      !entry.requires_source_document ||
      entry.source_document_type === null
    ) {
      continue;
    }
    if (seenSequences.has(entry.sequence)) {
      continue;
    }
    seenSequences.add(entry.sequence);

    const legs = generated.answer_key.entries.filter(
      (sibling) => sibling.sequence === entry.sequence,
    );

    const bankSide = BANK_SIDE_VOUCHER_TYPES.has(
      entry.voucher_type.trim().toLowerCase(),
    );
    const docType = bankSide ? "bank_statement" : entry.source_document_type;
    const transactionDescription =
      descriptionBySequence.get(entry.sequence) ?? "(no description available)";

    if (docType === "bank_statement") {
      plan.bankLines.push({
        entry,
        partyAccounts: legs.map((leg) => leg.correct_account),
        transactionDescription,
      });
    } else {
      plan.invoices.push({ legs, transactionDescription });
    }
  }

  return plan;
}

type PreparedSourceDocument = {
  docType: "vendor_invoice" | "bank_statement";
  storagePath: string;
  content: unknown;
};

// Generates, renders, and uploads the exercise's source-document PDFs: one
// vendor invoice per billed transaction, plus AT MOST ONE combined bank
// statement carrying every bank-side transaction as a line. Runs BEFORE the
// exercise row is inserted — the chat's next-exercise poll delivers an
// exercise the moment its row exists, and the ~30-60s of LLM + render +
// upload after insertion meant the learner received the batch with no PDF
// cards (observed live 2026-09-01: exercise row at 07:00:10, last document
// at 07:00:42, 5s poll landed in between). All slow work happens here
// against a storage folder keyed by a pre-generated batch id (the bucket's
// RLS is scoped to the learnerId folder segment only); the caller inserts
// the exercise row and then the document rows — milliseconds, closing the
// race. A generation/render/upload failure propagates and fails the whole
// call before any exercise row exists, so a docless batch is never
// delivered. The LLM calls only produce validated structured content;
// rendering to PDF and upload are fully deterministic from there, per this
// unit's "code renders, LLM never touches the PDF" boundary.
async function prepareSourceDocuments(
  supabase: SupabaseClient,
  learnerId: string,
  generatedExercise: GeneratedExercise,
  // Pins the bank statement's account holder — without it the statement
  // invented a company ("Bank Statement — ABC Trading Co.", observed live
  // 2026-09-01).
  companyName: string,
): Promise<PreparedSourceDocument[]> {
  const plan = planSourceDocuments(generatedExercise);
  // Storage folder + format-rotation seed base. Pre-generated (not the
  // exercise id) so uploads can happen before the exercise row exists;
  // rotation stays deterministic per batch.
  const batchId = crypto.randomUUID();

  async function renderAndUpload(
    generated: GeneratedSourceDocument,
    docType: "vendor_invoice" | "bank_statement",
    formatSeed: string,
  ): Promise<PreparedSourceDocument> {
    const pdfBuffer = await renderSourceDocumentPdf(generated, formatSeed);

    const docId = crypto.randomUUID();
    const storagePath = `${learnerId}/${batchId}/${docId}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from("exercise-documents")
      .upload(storagePath, pdfBuffer, { contentType: "application/pdf" });

    if (uploadError) {
      throw uploadError;
    }

    return { docType, storagePath, content: generated.content };
  }

  // All documents generate CONCURRENTLY — they are independent LLM calls, and
  // running them one-by-one made the post-scoring tail take minutes (observed
  // live 2026-09-01 on the production trace: 5 sequential document calls
  // dominating the next-batch step). Promise.all keeps result order
  // deterministic (invoices by plan order, statement last).
  const invoicePromises = plan.invoices.map((invoice) =>
    generateVendorInvoiceDocument(learnerId, invoice).then((generated) =>
      renderAndUpload(
        generated,
        "vendor_invoice",
        `${batchId}:${invoice.legs[0].sequence}`,
      ),
    ),
  );

  const statementPromise =
    plan.bankLines.length > 0
      ? generateBankStatementDocument(learnerId, plan.bankLines, companyName).then(
          (generated) =>
            renderAndUpload(generated, "bank_statement", `${batchId}:bank-statement`),
        )
      : null;

  const prepared = await Promise.all(
    statementPromise ? [...invoicePromises, statementPromise] : invoicePromises,
  );

  return prepared;
}

// Fast DB-row companion to prepareSourceDocuments — runs immediately after
// insertExercise (the FK requires the exercise row), keeping the visible
// exercise-without-documents window to milliseconds instead of the full
// document-generation time.
async function attachSourceDocuments(
  supabase: SupabaseClient,
  exerciseId: string,
  documents: PreparedSourceDocument[],
): Promise<void> {
  for (const doc of documents) {
    await insertSourceDocument(
      supabase,
      exerciseId,
      doc.docType,
      doc.storagePath,
      doc.content,
    );
  }
}

// Deterministic, not random, so the same learner always gets the same variant
// if regeneration is ever re-triggered in testing.
export function selectDiagnosticVariant(learnerId: string): ExerciseVariant {
  const hash = createHash("sha256").update(learnerId).digest();
  return hash[0] % 2 === 0 ? "A" : "B";
}

export async function generateDiagnosticExercise(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<{ id: string }> {
  const variant = selectDiagnosticVariant(learnerId);

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildDiagnosticPrompt(variant)
        : buildDiagnosticRetryPrompt(variant, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: "diagnostic-generation",
      learnerId,
      callType: "diagnostic-generation",
    });

    const parsed = GeneratedExerciseSchema.safeParse(raw);

    if (parsed.success) {
      // Documents first, exercise row last — see prepareSourceDocuments'
      // race note. The legacy generated diagnostic has no company registry
      // yet, so the product's one live company is pinned directly.
      const documents = await prepareSourceDocuments(
        supabase,
        learnerId,
        parsed.data,
        "Blossom Retail Pvt Ltd",
      );
      const { id } = await insertExercise(
        supabase,
        learnerId,
        "diagnostic",
        parsed.data,
      );
      await attachSourceDocuments(supabase, id, documents);
      return { id };
    }

    lastError = parsed.error.message;
  }

  throw new Error(
    `Diagnostic exercise generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

// Phase 2 live-fix (2026-08-27): the model can ignore the 50/50 batch
// instruction and produce a single-concept drill (observed live: 10
// contra-only cash-bank transfers). This is a deterministic composition
// check over the answer key's own concept_tags — a violating batch
// re-enters the generation retry loop with the violation as the error, so
// the model gets told exactly what to fix. Returns null when compliant.
const MIN_TRANSACTIONS_PER_BATCH = 10;
const MAX_TRANSACTIONS_PER_BATCH = 12;
const MIN_TRANSACTIONS_PER_SIDE = 4;
// Trading-mix floor (2026-09-01, user's 5-point batch review #2): the
// learner's company is a GST-registered trading business, so a real month
// ALWAYS has trading activity — a batch that is pure bank movement (the
// observed live Module-2 batch: contra/receipt/payment only) is unrealistic
// and quietly stops drilling GST classification, which lives on
// sales/purchases. Two of each, not one: a single rep can't vary the
// judgment (e.g. one intra-state + one inter-state sale).
const MIN_SALES_TRANSACTIONS = 2;
const MIN_PURCHASE_TRANSACTIONS = 2;

export function checkBatchComposition(
  generated: GeneratedExercise,
  batchPlan: { strengths: ConceptTag[]; weaknesses: ConceptTag[] } | null,
  escalationActive: boolean,
): string | null {
  // Escalation batches are deliberately narrow (2-4 single-concept
  // transactions); no plan means the caller didn't want composition.
  if (escalationActive || !batchPlan) {
    return null;
  }

  const transactionCount = generated.transactions.length;
  if (
    transactionCount < MIN_TRANSACTIONS_PER_BATCH ||
    transactionCount > MAX_TRANSACTIONS_PER_BATCH
  ) {
    return `The batch has ${transactionCount} transactions; the composition rules require ${MIN_TRANSACTIONS_PER_BATCH} to ${MAX_TRANSACTIONS_PER_BATCH}.`;
  }

  // All remaining violations are collected into ONE message so a retry can
  // fix everything in a single pass — sequential single-violation errors
  // would burn the bounded retry budget one rule at a time.
  const violations: string[] = [];

  // Trading mix, counted per transaction (sequence) off the answer key's own
  // voucher types — enforced for EVERY non-escalation batch, including the
  // no-strengths-yet case below, since a trading month needs trading
  // activity regardless of the concept plan.
  const voucherTypeBySequence = new Map<number, string>();
  for (const entry of generated.answer_key.entries) {
    if (!voucherTypeBySequence.has(entry.sequence)) {
      voucherTypeBySequence.set(
        entry.sequence,
        entry.voucher_type.trim().toLowerCase(),
      );
    }
  }
  let salesCount = 0;
  let purchaseCount = 0;
  for (const voucherType of voucherTypeBySequence.values()) {
    if (voucherType === "sales") {
      salesCount++;
    }
    if (voucherType === "purchase") {
      purchaseCount++;
    }
  }
  if (
    salesCount < MIN_SALES_TRANSACTIONS ||
    purchaseCount < MIN_PURCHASE_TRANSACTIONS
  ) {
    violations.push(
      `Trading-mix violated: the batch has ${salesCount} Sales and ${purchaseCount} Purchase transactions, but every batch needs at least ${MIN_SALES_TRANSACTIONS} Sales and ${MIN_PURCHASE_TRANSACTIONS} Purchase transactions — this is a GST-registered trading business, so a month of only bank movements is unrealistic. Keep the concept targeting, but weave it through a month that includes real trading activity (with GST treatment appropriate to each party's state).`,
    );
  }

  // A learner with no established strengths legitimately gets a one-sided
  // batch (the prompt fills the step-up half with the target concept) — the
  // side split is skipped, but the trading mix above still applies.
  if (batchPlan.strengths.length > 0) {
    const strengthSet = new Set<ConceptTag>(batchPlan.strengths);
    const weaknessSet = new Set<ConceptTag>(batchPlan.weaknesses);
    const perSequence = new Map<
      number,
      { strength: boolean; weakness: boolean }
    >();
    for (const entry of generated.answer_key.entries) {
      const slot = perSequence.get(entry.sequence) ?? {
        strength: false,
        weakness: false,
      };
      for (const tag of entry.concept_tags) {
        if (strengthSet.has(tag)) {
          slot.strength = true;
        }
        if (weaknessSet.has(tag)) {
          slot.weakness = true;
        }
      }
      perSequence.set(entry.sequence, slot);
    }

    let strengthCount = 0;
    let weaknessCount = 0;
    for (const slot of perSequence.values()) {
      if (slot.strength) {
        strengthCount++;
      }
      if (slot.weakness) {
        weaknessCount++;
      }
    }

    if (
      strengthCount < MIN_TRANSACTIONS_PER_SIDE ||
      weaknessCount < MIN_TRANSACTIONS_PER_SIDE
    ) {
      violations.push(
        `Batch composition violated: only ${strengthCount} transactions carry a strength concept (${batchPlan.strengths.join(", ")}) and ${weaknessCount} carry a weakness concept (${batchPlan.weaknesses.join(", ")}). At least ${MIN_TRANSACTIONS_PER_SIDE} transactions per side are required — rebuild the batch so roughly half step up the strength concepts and half reinforce the weakness concepts, with concept_tags attributing each transaction.`,
      );
    }
  }

  return violations.length > 0 ? violations.join(" ") : null;
}

// Month-per-batch progression (2026-09-01, user's 5-point batch review #3):
// the company's timeline is computed in code, never guessed by the LLM (the
// company log stores no dates, so "use the month following the latest
// transaction" had nothing to anchor on — observed live as one batch mixing
// May and June). Ordinal 1 is the diagnostic pack's April 2026; every
// exercise after advances one calendar month.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;
const BOOKS_BEGIN_MONTH_INDEX = 3; // April
const BOOKS_BEGIN_YEAR = 2026;

export type ExerciseMonth = { label: string; monthIndex: number; year: number };

export function exerciseMonthForModule(moduleNumber: number): ExerciseMonth {
  const offset = BOOKS_BEGIN_MONTH_INDEX + Math.max(moduleNumber, 1) - 1;
  const monthIndex = offset % 12;
  const year = BOOKS_BEGIN_YEAR + Math.floor(offset / 12);
  return { label: `${MONTH_NAMES[monthIndex]} ${year}`, monthIndex, year };
}

// Scans the generated transactions' own descriptions for date tokens and
// rejects any dated outside the assigned month — the same feed-the-retry
// mechanism as checkBatchComposition. Only POSITIVE mismatches fail: a
// description with no parseable date is left to the prompt (failing on
// absence would reject legitimate phrasings), and a bare month mention with
// no day number ("settling the March invoice") is not a transaction date.
const MONTH_ABBREVS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
];

export function checkBatchMonth(
  generated: GeneratedExercise,
  month: ExerciseMonth,
): string | null {
  const offenders: string[] = [];

  for (const transaction of generated.transactions) {
    // "01-May-2026", "1 May 2026", "01/May/2026" style.
    for (const match of transaction.description.matchAll(
      /\b\d{1,2}[-\s/]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/]*(\d{4})\b/gi,
    )) {
      const monthIndex = MONTH_ABBREVS.indexOf(match[1].toLowerCase());
      if (monthIndex !== month.monthIndex || Number(match[2]) !== month.year) {
        offenders.push(
          `transaction ${transaction.sequence} is dated "${match[0]}"`,
        );
      }
    }
    // "01-05-2026" / "01/05/2026" numeric style (Indian DD-MM-YYYY).
    for (const match of transaction.description.matchAll(
      /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/g,
    )) {
      const monthIndex = Number(match[2]) - 1;
      if (monthIndex !== month.monthIndex || Number(match[3]) !== month.year) {
        offenders.push(
          `transaction ${transaction.sequence} is dated "${match[0]}"`,
        );
      }
    }
  }

  if (offenders.length === 0) {
    return null;
  }
  return `Month violated: every transaction must be dated inside ${month.label}, but ${[...new Set(offenders)].join("; ")}. Redate those transactions into ${month.label} — the company's timeline advances exactly one month per module and never mixes months in a batch.`;
}

// Document-backed transactions must be POINTERS (2026-09-01, user's 5-point
// batch review #4): when a transaction ships as a PDF, its text line must
// not restate the figures — the learner reads them from the document, like
// real work. Observed live: every doc-backed line spelled out the full
// amount and GST, making the PDFs decorative. This scans doc-flagged
// transactions' descriptions for figure leaks (a rupee amount, or a
// percentage — a GST rate) and feeds violations into the same retry
// message. Dates ("01-May-2026") and identifiers ("HDFC Bank — 1234",
// invoice #DT2026) deliberately don't match these patterns.
const RUPEE_AMOUNT_PATTERN = /(?:₹|\bRs\.?\s?)\s*[\d,]+/i;
const PERCENTAGE_PATTERN = /\d+(?:\.\d+)?\s*%/;

// The chat renders an exercise as the scenario text followed by the
// structured transactions as a numbered list. When the model ALSO writes the
// numbered list inside the scenario text, the learner sees the same 10-12
// items twice (Praveen, Level 3, 2026-09-02: "post all twelve… then again 12
// entries"). Numbered lines in the scenario that restate a transaction are
// removed deterministically; prose and unrelated numbered lines stay.
const NUMBERED_LINE_PATTERN = /^\s*\d{1,2}[.)]\s+(.*)$/;

function normalizeForCompare(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function stripDuplicateTransactionList(
  generated: GeneratedExercise,
): GeneratedExercise {
  const descriptions = generated.transactions.map((transaction) =>
    normalizeForCompare(transaction.description),
  );
  const restatesTransaction = (text: string): boolean => {
    const normalized = normalizeForCompare(text);
    if (normalized.length === 0) {
      return false;
    }
    const probe = normalized.slice(0, 60);
    return descriptions.some(
      (description) =>
        description === normalized ||
        description.startsWith(probe) ||
        normalized.startsWith(description.slice(0, 60)),
    );
  };

  const kept = generated.scenario.split(/\r?\n/).filter((line) => {
    const match = NUMBERED_LINE_PATTERN.exec(line);
    return !(match && restatesTransaction(match[1]));
  });
  const scenario = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  return scenario === generated.scenario ? generated : { ...generated, scenario };
}

export function checkDocumentBackedDescriptions(
  generated: GeneratedExercise,
): string | null {
  const documentBackedSequences = new Set(
    generated.answer_key.entries
      .filter(
        (entry) =>
          entry.requires_source_document && entry.source_document_type !== null,
      )
      .map((entry) => entry.sequence),
  );
  if (documentBackedSequences.size === 0) {
    return null;
  }

  const offenders: number[] = [];
  for (const transaction of generated.transactions) {
    if (!documentBackedSequences.has(transaction.sequence)) {
      continue;
    }
    if (
      RUPEE_AMOUNT_PATTERN.test(transaction.description) ||
      PERCENTAGE_PATTERN.test(transaction.description)
    ) {
      offenders.push(transaction.sequence);
    }
  }

  if (offenders.length === 0) {
    return null;
  }
  return `Document-backed text violated: transaction(s) ${offenders.join(", ")} have requires_source_document true but their text states an amount or a GST rate. A document-backed transaction's line is a short pointer (date, party, what happened, which document to read) with NO figures — the learner reads the figures from the document itself. Rewrite those lines as pointers, keeping the exact figures only in the hidden answer key.`;
}

// Double-entry integrity (2026-09-02): every transaction's answer key must
// carry BOTH sides. A live batch was delivered with 12 of 12 transactions
// holding a single leg ("Dr HDFC Bank 90,000" with no matching credit),
// which silently broke three things at once: the missing side was never
// scored, the Trial Balance maths counted half of each transaction, and the
// cash-feasibility walk could not see the cash legs at all — so an
// unpostable ₹90,000 deposit sailed through.
//
// The amount comparison deliberately runs ONLY on transactions with no tax
// component. The answer-key model carries GST and TDS as voucher-level
// METADATA rather than ledger legs (see score-submission.ts's tie-out
// exemption), so a taxed sale legitimately shows Dr 118,000 against Cr
// 100,000. Contra, receipt, payment and journal transactions carry no such
// metadata, and those are exactly where an imbalance corrupts cash.
const TAX_LEG_PATTERN = /\b(cgst|sgst|igst|gst|tds)\b/i;
const DOUBLE_ENTRY_TOLERANCE = 0.01;

export function checkDoubleEntry(generated: GeneratedExercise): string | null {
  const bySequence = new Map<number, GeneratedExercise["answer_key"]["entries"]>();
  for (const entry of generated.answer_key.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }

  const missingSide: number[] = [];
  const unbalanced: string[] = [];

  for (const [sequence, legs] of [...bySequence.entries()].sort((a, b) => a[0] - b[0])) {
    const debits = legs.filter((leg) => leg.dr_cr === "Dr");
    const credits = legs.filter((leg) => leg.dr_cr === "Cr");

    if (debits.length === 0 || credits.length === 0) {
      missingSide.push(sequence);
      continue;
    }

    const carriesTaxMetadata = legs.some((leg) => leg.gst_head !== null || leg.tds_section !== null);
    const hasExplicitTaxLeg = legs.some((leg) => TAX_LEG_PATTERN.test(leg.correct_account));
    if (carriesTaxMetadata && !hasExplicitTaxLeg) {
      continue; // GST/TDS held as metadata — an imbalance here is by design.
    }

    const drTotal = debits.reduce((sum, leg) => sum + leg.amount, 0);
    const crTotal = credits.reduce((sum, leg) => sum + leg.amount, 0);
    if (Math.abs(drTotal - crTotal) > DOUBLE_ENTRY_TOLERANCE) {
      unbalanced.push(`transaction ${sequence} (Dr ${Math.round(drTotal)} vs Cr ${Math.round(crTotal)})`);
    }
  }

  const problems: string[] = [];
  if (missingSide.length > 0) {
    problems.push(
      `transaction(s) ${missingSide.join(", ")} have only one side. EVERY transaction's answer key needs at least one Dr leg AND at least one Cr leg: a contra deposit is Dr the bank and Cr Cash, a payment is Dr the party and Cr the bank, a sale is Dr the customer and Cr Sales.`,
    );
  }
  if (unbalanced.length > 0) {
    problems.push(`${unbalanced.join("; ")} do not balance: total debits must equal total credits.`);
  }

  return problems.length > 0 ? `Double-entry violated: ${problems.join(" ")}` : null;
}

// Cash/bank feasibility (2026-09-02): a generated batch must be POSTABLE
// from the company's actual position — a learner cannot deposit cash she
// does not hold. Reported live: a batch opened with a ₹45,000 cash deposit
// against a correct cash balance of ₹19,900, driving Cash to -₹20,100.
// Batch generation had no balance visibility at all, so it invented
// plausible-sounding figures. This walks the batch in sequence order,
// applying each transaction's cash and bank movements to the opening
// position, and rejects the batch naming the first transaction that would
// overdraw either. Bank is checked too (an overdraft is equally
// unpostable), with a small tolerance so a to-the-rupee zero doesn't trip.
const CASH_LEDGER_PATTERN = /^cash\b|cash-in-hand/i;
const BANK_LEDGER_PATTERN = /\bbank\b|hdfc/i;
const OVERDRAW_TOLERANCE = 0.005;

export function checkCashFeasibility(
  generated: GeneratedExercise,
  opening: { cash: number; bank: number },
): string | null {
  const bySequence = new Map<number, GeneratedExercise["answer_key"]["entries"]>();
  for (const entry of generated.answer_key.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }

  let cash = opening.cash;
  let bank = opening.bank;

  for (const [sequence, legs] of [...bySequence.entries()].sort((a, b) => a[0] - b[0])) {
    for (const leg of legs) {
      const signed = leg.dr_cr === "Dr" ? leg.amount : -leg.amount;
      if (CASH_LEDGER_PATTERN.test(leg.correct_account)) {
        cash += signed;
      } else if (BANK_LEDGER_PATTERN.test(leg.correct_account)) {
        bank += signed;
      }
    }
    if (cash < -OVERDRAW_TOLERANCE) {
      // A till that is ALREADY overdrawn on entry (an earlier batch's fault,
      // not this one's) needs a different instruction: replenish first.
      if (opening.cash < -OVERDRAW_TOLERANCE) {
        return `Cash feasibility violated: the till opens this batch overdrawn at ${Math.round(opening.cash)}, and transaction ${sequence} leaves it at ${Math.round(cash)}. Transaction 1 must be a Contra withdrawal from the bank to Cash large enough to clear the shortfall (at least ${Math.abs(Math.round(opening.cash))}) before any other cash movement; every transaction after it must then keep cash non-negative.`;
      }
      return `Cash feasibility violated: transaction ${sequence} drives Cash-in-Hand to ${Math.round(cash)}, but cash can never go negative. The company holds ${Math.round(opening.cash)} in cash at the start of this batch, so every cash payment or cash-to-bank deposit across the batch must stay within that plus whatever cash the batch itself brings in. Rescale or reorder the cash movements to fit.`;
    }
    if (bank < -OVERDRAW_TOLERANCE) {
      return `Bank feasibility violated: transaction ${sequence} drives the bank account to ${Math.round(bank)}, an overdraft the learner cannot post. The company holds ${Math.round(opening.bank)} in the bank at the start of this batch; keep every payment and bank-to-cash withdrawal within the running balance.`;
    }
  }

  return null;
}

// One level down from currentLevel, floored at L0 — used when reinforcement
// is active, per the spec's "drops one difficulty level and re-targets"
// rule. Never below the lowest defined level.
function dropOneLevel(
  currentLevel: ExerciseDifficultyLevel,
): ExerciseDifficultyLevel {
  const index = EXERCISE_DIFFICULTY_LEVELS.indexOf(currentLevel);
  const droppedIndex = Math.max(index - 1, 0);
  return EXERCISE_DIFFICULTY_LEVELS[droppedIndex];
}

// Generates an adaptive exercise targeting the given weak concept, aware of
// everything already posted in the learner's single persistent Tally
// company (company_ledger_registry + a recent slice of
// company_transaction_log), so the LLM reuses or safely introduces
// ledger/party names rather than colliding with prior exercises. Persists
// the exercise, then registers any new ledgers and appends the transaction
// summary to the company log — this is what keeps the registry accurate for
// the *next* generation call.
export async function generateAdaptiveExercise(
  supabase: SupabaseClient,
  learnerId: string,
  target: WeakConceptTarget,
  baseDifficultyLevel: ExerciseDifficultyLevel,
  // Unit 14R wiring: an 'explain' exercise is the same generated posting
  // batch plus an explain-the-entry text part — the kind drives
  // required_parts (REQUIRED_PARTS_BY_KIND) and nothing else about
  // generation. Scheduled by select-exercise-kind.ts.
  kind: "adaptive" | "explain" = "adaptive",
  recentStrengthDescriptions: string[] = [],
  // Phase 2: the 50/50 composition plan. Ignored (forced empty) in
  // escalation mode, which narrows to the single target concept.
  batchPlan: {
    strengths: ConceptTag[];
    weaknesses: ConceptTag[];
  } | null = null,
  // Phase 3 (spec 15): educational-mode learners can only post on the 1st,
  // 2nd, or last day of a month — the generation prompt enforces the dates.
  licenseMode: LicenseMode = "licensed",
  // Month-per-batch (2026-09-01): this exercise's ordinal in the learner's
  // journey — 1 is the diagnostic pack (April 2026), 2 the first adaptive
  // batch (May 2026), and so on, one calendar month per exercise. Computed
  // in code by the caller (run-scoring passes priorExerciseCount + 1),
  // stated to the prompt as a hard rule, and enforced by checkBatchMonth in
  // the retry loop below.
  exerciseOrdinal = 2,
): Promise<{ id: string }> {
  const difficultyLevel = target.reinforcementActive
    ? dropOneLevel(baseDifficultyLevel)
    : baseDifficultyLevel;
  const exerciseMonth = exerciseMonthForModule(exerciseOrdinal);

  const [companyLedgerRegistry, recentCompanyTransactionLog, companyName, cashPosition, openingBalances] =
    await Promise.all([
      getCompanyLedgerRegistry(supabase, learnerId),
      getRecentCompanyTransactionLog(supabase, learnerId),
      getCompanyName(supabase, learnerId),
      getExpectedCashPosition(supabase, learnerId),
      getExpectedOpeningBalances(supabase, learnerId),
    ]);

  const promptParams = {
    targetConceptTag: target.conceptTag,
    batchStrengthConcepts:
      target.escalationActive || !batchPlan ? [] : batchPlan.strengths,
    batchWeaknessConcepts:
      target.escalationActive || !batchPlan ? [] : batchPlan.weaknesses,
    recentStrengthDescriptions,
    difficultyLevel,
    licenseMode,
    escalationActive: target.escalationActive,
    companyLedgerRegistry,
    recentCompanyTransactionLog,
    exerciseMonthLabel: exerciseMonth.label,
    // Fallback covers a learner whose pack-assignment log row predates the
    // company field (or test paths with no pack) — the product's one live
    // company is Blossom Retail.
    companyName: companyName ?? "Blossom Retail Pvt Ltd",
    cashPosition,
  };

  let lastError: string | null = null;
  let generated: GeneratedExercise | null = null;
  // Schema-valid but composition-violating batches are kept as a fallback:
  // if the model never complies within MAX_ATTEMPTS, an unbalanced batch
  // still beats delivering nothing (same philosophy as the review-kind
  // fallback in run-scoring).
  let unbalancedFallback: GeneratedExercise | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildAdaptivePrompt(promptParams)
        : buildAdaptiveRetryPrompt(promptParams, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: "adaptive-generation",
      learnerId,
      callType: "adaptive-generation",
      extraMetadata: {
        targetConceptTag: target.conceptTag,
        reason: target.reason,
      },
    });

    const parsed = GeneratedExerciseSchema.safeParse(raw);

    if (parsed.success) {
      // Composition, month, document-pointer, and cash-feasibility
      // violations are combined into one retry message so a single retry can
      // fix everything at once.
      const compositionError = checkBatchComposition(
        parsed.data,
        batchPlan,
        target.escalationActive,
      );
      const monthError = checkBatchMonth(parsed.data, exerciseMonth);
      const documentTextError = checkDocumentBackedDescriptions(parsed.data);
      // Double-entry runs BEFORE cash feasibility in the message order
      // because a single-leg key makes the cash walk blind — fixing the legs
      // is what lets the cash check see the movements at all.
      const doubleEntryError = checkDoubleEntry(parsed.data);
      const cashError = checkCashFeasibility(parsed.data, cashPosition);
      const batchError = [
        compositionError,
        monthError,
        documentTextError,
        doubleEntryError,
        cashError,
      ]
        .filter(Boolean)
        .join(" ");
      if (batchError === "") {
        generated = parsed.data;
        break;
      }
      unbalancedFallback = parsed.data;
      lastError = batchError;
      continue;
    }

    lastError = parsed.error.message;
  }

  if (!generated && unbalancedFallback) {
    generated = unbalancedFallback;
  }

  if (!generated) {
    throw new Error(
      `Adaptive exercise generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    );
  }

  generated = stripDuplicateTransactionList(generated);

  // Slow work (LLM + PDF render + upload) BEFORE the exercise row exists —
  // the chat's poll delivers the exercise as soon as the row appears, so
  // documents must already be uploaded by then (2026-09-01 race fix).
  // The learner keeps ONE continuous set of books, so this batch's answer
  // key must describe the company's cumulative position, not just its own
  // movements: expected closing = carried-forward opening + this batch.
  // Without it checkTrialBalanceTieOut compared batch-only movements against
  // the learner's cumulative Tally export and failed a flawless submission,
  // capping every adaptive result at 'partial' (2026-09-02).
  const generatedWithOpenings: GeneratedExercise = {
    ...generated,
    answer_key: { ...generated.answer_key, opening_balances: openingBalances },
  };

  const documents = await prepareSourceDocuments(
    supabase,
    learnerId,
    generatedWithOpenings,
    companyName ?? "Blossom Retail Pvt Ltd",
  );

  const { id } = await insertExercise(supabase, learnerId, kind, generatedWithOpenings);

  await attachSourceDocuments(supabase, id, documents);

  const newLedgers = generated.answer_key.entries.map((entry) => ({
    ledgerName: entry.correct_account,
    ledgerType: entry.voucher_type,
  }));
  await registerCompanyLedgers(supabase, learnerId, id, newLedgers);

  await appendCompanyTransactionLog(supabase, learnerId, id, {
    voucherType: generated.answer_key.entries[0]?.voucher_type ?? null,
    ledgers: newLedgers.map((ledger) => ledger.ledgerName),
    transactionCount: generated.transactions.length,
    difficultyLevel: generated.difficulty_level,
  });

  return { id };
}

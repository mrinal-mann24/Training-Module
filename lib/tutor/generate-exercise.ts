import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
  getCompanyState,
  isBankLedger,
  registerCompanyLedgers,
  appendCompanyTransactionLog,
  parseBillReferences,
  partyLegOf,
  type OpenBill,
  type PartyTaxClass,
  loadAnswerKeys,
} from "@/lib/db/queries/company";
import { buildBankStatementContent, applyBankReferences } from "@/lib/documents/build-bank-statement";
import type { BankStatementContent } from "@/lib/schemas/source-document";
import { insertSourceDocument } from "@/lib/db/queries/source-documents";
import { BOOKS_BEGIN_MONTH_INDEX, BOOKS_BEGIN_YEAR } from "@/lib/tutor/timeline";
import {
  generateVendorInvoiceDocument,
} from "@/lib/documents/generate-source-document";
import { renderSourceDocument } from "@/lib/documents/render-source-document";
import type {
  BankStatementLineInput,
  VendorInvoiceInput,
} from "@/lib/llm/prompts/source-document";
import type { GeneratedSourceDocument, SourceDocumentType } from "@/lib/schemas/source-document";
import { applyDocumentsMode, checkMonthEndNoteDetails, checkSalesInvoicesBuildable } from "@/lib/tutor/documents-mode";
import { adjustOpenAdvances, advancesToAdjust } from "@/lib/tutor/advance-adjustment";
import {
  billTokensIn,
  checkBillNumberUniqueness,
  checkConceptTagsMatchContent,
  checkGstArithmetic,
  checkGstHeadMetadata,
  checkPlaceOfSupply,
  checkReverseCharge,
  checkTdsArithmetic,
  checkTdsThresholds,
  checkTextMatchesKey,
  normalizeDocumentNumber,
  priorBillReferences,
  priorDocumentNumbers,
  tdsHistoryFromKeys,
  transactionDateOf,
  type PayeeTypeOf,
  type StateCodeOf,
  type TdsHistory,
} from "@/lib/tutor/generation-checks";
import { appendMonthEndJournals, type MonthEndParams } from "@/lib/tutor/month-end-journals";
import { checkCanonicalDateFormat, checkDatesExist, enforceEducationalDates } from "@/lib/tutor/educational-dates";
import { partyIdentityFor } from "@/lib/documents/party-directory";
import { extractTransactionDate } from "@/lib/llm/prompts/source-document";
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
    } else if (docType === "vendor_invoice") {
      plan.invoices.push({ legs, transactionDescription });
    }
    // sales_invoice / month_end_note are built by code in documents mode
    // (lib/tutor/documents-mode.ts), never by the invoice generator.
  }

  return plan;
}

type PreparedSourceDocument = {
  docType: SourceDocumentType;
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
export async function prepareSourceDocuments(
  supabase: SupabaseClient,
  learnerId: string,
  generatedExercise: GeneratedExercise,
  // Pins the bank statement's account holder — without it the statement
  // invented a company ("Bank Statement — ABC Trading Co.", observed live
  // 2026-09-01).
  companyName: string,
  // The bank statement is built by code from the answer key (see
  // build-bank-statement.ts); null when the batch has no statement-backed
  // bank lines. companyName is still used for the invoices' buyer block.
  statement: BankStatementContent | null,
  // Documents-mode extras already built by code (sales invoices, the
  // month-end notes sheet): render + upload only, no LLM call.
  codeBuiltDocuments: { document: GeneratedSourceDocument; seed: string }[] = [],
): Promise<PreparedSourceDocument[]> {
  const plan = planSourceDocuments(generatedExercise);
  // Storage folder + format-rotation seed base. Pre-generated (not the
  // exercise id) so uploads can happen before the exercise row exists;
  // rotation stays deterministic per batch.
  const batchId = crypto.randomUUID();

  async function renderAndUpload(
    generated: GeneratedSourceDocument,
    docType: SourceDocumentType,
    formatSeed: string,
  ): Promise<PreparedSourceDocument> {
    // PDF for every type except the sales register, which is a CSV
    // (2026-09-09): the renderer says which, and the path/upload follow it.
    const rendered = await renderSourceDocument(generated, formatSeed);

    const docId = crypto.randomUUID();
    const storagePath = `${learnerId}/${batchId}/${docId}.${rendered.extension}`;

    const { error: uploadError } = await supabase.storage
      .from("exercise-documents")
      .upload(storagePath, rendered.bytes, { contentType: rendered.contentType });

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
    plan.bankLines.length > 0 && statement
      ? renderAndUpload({ doc_type: "bank_statement", content: statement }, "bank_statement", `${batchId}:bank-statement`)
      : null;

  const codeBuiltPromises = codeBuiltDocuments.map(({ document, seed }) =>
    renderAndUpload(document, document.doc_type, `${batchId}:${seed}`),
  );

  const prepared = await Promise.all([
    ...invoicePromises,
    ...(statementPromise ? [statementPromise] : []),
    ...codeBuiltPromises,
  ]);

  return prepared;
}

// Fast DB-row companion to prepareSourceDocuments — runs immediately after
// insertExercise (the FK requires the exercise row), keeping the visible
// exercise-without-documents window to milliseconds instead of the full
// document-generation time.
export async function attachSourceDocuments(
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

// Opening Cash and Bank from a key's own opening balances.
function openingCashPosition(generated: GeneratedExercise): { cash: number; bank: number } {
  const signed = (opening: { dr_cr: "Dr" | "Cr"; amount: number }) => (opening.dr_cr === "Dr" ? opening.amount : -opening.amount);
  const openings = generated.answer_key.opening_balances ?? [];
  return {
    cash: openings.filter((opening) => CASH_LEDGER_PATTERN.test(opening.account)).reduce((sum, opening) => sum + signed(opening), 0),
    bank: openings.filter((opening) => isBankLedger(opening.account)).reduce((sum, opening) => sum + signed(opening), 0),
  };
}

// Party identity for the checks (2026-09-17): the fixed state and
// constitution the documents print (party-directory.ts), never adjusted to
// fit the GST the model chose.
const stateCodeFromIdentity: StateCodeOf = (party) => partyIdentityFor(party).stateCode;
const payeeTypeFromIdentity: PayeeTypeOf = (party) => (partyIdentityFor(party).entityType === "P" ? "individual_huf" : "other");

export type DiagnosticGenerationDeps = {
  complete?: typeof getTracedStructuredCompletion;
  // Builds documents and inserts the exercise; returns its id.
  persist?: (supabase: SupabaseClient, learnerId: string, exercise: GeneratedExercise) => Promise<{ id: string }>;
};

async function persistDiagnosticExercise(
  supabase: SupabaseClient,
  learnerId: string,
  dated: GeneratedExercise,
): Promise<{ id: string }> {
  // Documents first, exercise row last — see prepareSourceDocuments'
  // race note. The legacy generated diagnostic has no company registry
  // yet, so the product's one live company is pinned directly.
  // Statement built by code from the key; the legacy diagnostic's bank
  // opening is whatever its own opening_balances say (0 if none).
  const openingBank = openingCashPosition(dated).bank;
  const diagnosticStatement =
    planSourceDocuments(dated).bankLines.length > 0
      ? buildBankStatementContent({
          companyName: "Blossom Retail Pvt Ltd",
          openingBankBalance: openingBank,
          generated: dated,
        })
      : null;
  const diagnosticExercise = diagnosticStatement
    ? applyBankReferences(dated, diagnosticStatement.referenceBySequence)
    : dated;
  const documents = await prepareSourceDocuments(
    supabase,
    learnerId,
    diagnosticExercise,
    "Blossom Retail Pvt Ltd",
    diagnosticStatement?.content ?? null,
  );
  const { id } = await insertExercise(supabase, learnerId, "diagnostic", diagnosticExercise);
  await attachSourceDocuments(supabase, id, documents);
  return { id };
}

export async function generateDiagnosticExercise(
  supabase: SupabaseClient,
  learnerId: string,
  // Educational Mode dates (2026-09-16): this fallback runs when no pack is
  // seeded, and its batch has no assigned month, so each date token is
  // redated within its own month (educational-dates.ts).
  licenseMode: LicenseMode = "licensed",
  deps: DiagnosticGenerationDeps = {},
): Promise<{ id: string }> {
  const complete = deps.complete ?? getTracedStructuredCompletion;
  const persist = deps.persist ?? persistDiagnosticExercise;
  const variant = selectDiagnosticVariant(learnerId);
  // The diagnostic stands for the books' first month (April 2024).
  const month = exerciseMonthForModule(1);

  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const base =
      lastError === null
        ? buildDiagnosticPrompt(variant)
        : buildDiagnosticRetryPrompt(variant, lastError);
    // The same hard checks as an adaptive batch (2026-09-17 audit: this
    // fallback delivered whatever parsed). The diagnostic prompt says
    // nothing about dates, so the rule the checks enforce is stated here.
    const messages = [
      ...base.messages,
      {
        role: "user" as const,
        content: `Date every transaction explicitly inside ${month.label} in the DD-Mon-YYYY format (e.g. "On 03-${month.label.slice(0, 3)}-${month.year}, ..."), keep every rupee figure and bill number in a line identical to its answer key, and state answer_key.opening_balances for Cash and the bank large enough that neither ever goes negative.`,
      },
    ];

    const raw = await complete({
      messages,
      jsonSchema: base.jsonSchema,
      traceName: "diagnostic-generation",
      learnerId,
      callType: "diagnostic-generation",
    });

    const parsed = GeneratedExerciseSchema.safeParse(raw);

    if (!parsed.success) {
      lastError = parsed.error.message;
      continue;
    }
    const candidate = fillBillReferencesFromText(parsed.data);
    const cashPosition = openingCashPosition(candidate);
    const { hard } = runGenerationChecks(candidate, {
      month,
      cashPosition,
      // Settlements here are against the diagnostic's own opening balances,
      // which carry no bill numbers; there is no open-bills list to check.
      openBills: null,
      partyTaxClasses: new Map(),
      priorRefs: new Set(),
      tdsHistory: new Map(),
      documentsMode: false,
      companyName: "Blossom Retail Pvt Ltd",
    });
    // Redated before the statement is built, since the statement's rows
    // and references read their dates from the transaction text.
    const finalized = hard.length === 0 ? finalizeBatch(candidate, { licenseMode, month: null, cashPosition, monthEnd: null }) : null;
    const errors = [...hard, ...(finalized?.errors ?? [])];
    if (errors.length > 0 || !finalized) {
      lastError = errors.join(" ");
      dumpFailedAttempt(learnerId, attempt, lastError, candidate);
      continue;
    }
    return persist(supabase, learnerId, finalized.generated);
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
const MIN_ESCALATION_TRANSACTIONS = 8;
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
  // Escalation batches are narrow, not small (2026-09-10): at least
  // MIN_ESCALATION_TRANSACTIONS, most of them on the target concept. The
  // 50/50 split and the trading mix are not enforced on them. No plan means
  // the caller didn't want composition.
  if (escalationActive) {
    const count = generated.transactions.length;
    if (count < MIN_ESCALATION_TRANSACTIONS || count > MAX_TRANSACTIONS_PER_BATCH) {
      return `The escalation batch has ${count} transactions; it needs ${MIN_ESCALATION_TRANSACTIONS} to ${MAX_TRANSACTIONS_PER_BATCH}, at least half of them on the primary target concept.`;
    }
    return null;
  }
  if (!batchPlan) {
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
    // A line with no date at all cannot be placed on the bank statement
    // or dated on an invoice (documents mode drops it silently), so it is
    // an offender too.
    if (!/\b\d{1,2}[-\s/]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/]*\d{4}\b/i.test(transaction.description) && !/\b\d{1,2}[-/]\d{1,2}[-/]\d{4}\b/.test(transaction.description)) {
      offenders.push(`transaction ${transaction.sequence} carries no date`);
    }
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
const OVERDRAW_TOLERANCE = 0.005;

// The scenario prose may mention the company's opening Cash/Bank position,
// and the model can mistype it: Yeshas's Level 2 said "Rs 8,67,186 in HDFC
// Bank" when the carried-forward balance was 8,66,116 (2026-09-02). Scoring
// never reads the prose, but the learner does. Three deterministic layers:
// checkOpeningFigures feeds a retry when a figure in an opening-context
// sentence isn't the real cash/bank figure; scrubOpeningFigureSentences
// drops any such sentence that survives (the fallback path keeps the last
// attempt); stampOpeningPosition appends the true position, written by code.
const OPENING_CONTEXT_PATTERN = /cash|bank|till|hdfc|holding|opening|overdrawn|float/i;
const RUPEE_FIGURE_PATTERN = /(?:₹|\bRs\.?\s?)\s*([\d,]+(?:\.\d+)?)/gi;

function allowedOpeningFigures(cashPosition: { cash: number; bank: number }): Set<number> {
  return new Set([Math.abs(Math.round(cashPosition.cash)), Math.abs(Math.round(cashPosition.bank))]);
}

function splitSentences(prose: string): string[] {
  return prose.split(/(?<=[.!?])\s+|\n+/);
}

function wrongOpeningFigures(sentence: string, allowed: Set<number>): string[] {
  if (!OPENING_CONTEXT_PATTERN.test(sentence)) {
    return [];
  }
  const wrong: string[] = [];
  for (const match of sentence.matchAll(RUPEE_FIGURE_PATTERN)) {
    const value = Math.round(Number(match[1].replace(/,/g, "")));
    if (Number.isFinite(value) && !allowed.has(value)) {
      wrong.push(match[0].trim());
    }
  }
  return wrong;
}

export function checkOpeningFigures(
  generated: GeneratedExercise,
  cashPosition: { cash: number; bank: number },
): string | null {
  const allowed = allowedOpeningFigures(cashPosition);
  const offenders = splitSentences(generated.scenario).flatMap((sentence) =>
    wrongOpeningFigures(sentence, allowed),
  );
  if (offenders.length === 0) {
    return null;
  }
  return `Opening figures violated: the scenario prose states ${offenders.join(", ")} in a sentence about cash, bank or the till, but the company's real position is Cash ${formatRupees(cashPosition.cash)} and Bank ${formatRupees(cashPosition.bank)}. Do not quote opening figures in the prose at all (the system prints the opening position itself); transaction amounts belong only in the numbered transaction lines.`;
}

export function scrubOpeningFigureSentences(
  generated: GeneratedExercise,
  cashPosition: { cash: number; bank: number },
): GeneratedExercise {
  const allowed = allowedOpeningFigures(cashPosition);
  const scenario = generated.scenario
    .split(/\n/)
    .map((line) =>
      line
        .split(/(?<=[.!?])\s+/)
        .filter((sentence) => wrongOpeningFigures(sentence, allowed).length === 0)
        .join(" "),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return scenario === generated.scenario ? generated : { ...generated, scenario };
}

function formatRupees(value: number): string {
  const rounded = Math.round(value);
  return `Rs ${Math.abs(rounded).toLocaleString("en-IN")}${rounded < 0 ? " (overdrawn)" : ""}`;
}

export function stampOpeningPosition(
  generated: GeneratedExercise,
  cashPosition: { cash: number; bank: number },
  openingBalances: { account: string }[],
): GeneratedExercise {
  const bankLabel =
    openingBalances.find((opening) => /\bbank\b|hdfc/i.test(opening.account))?.account ?? "Bank";
  // "For reference only" (2026-09-09): Garima read this line as a task and
  // posted adjustments every month to force her Tally balances onto these
  // figures, which drifted her books further and risks an extra voucher
  // failing the exact count gate. The figures are the platform's running
  // balance from the correct postings; nothing is to be posted from them.
  const line = `Opening position for this batch (the platform's running balance from the correct postings so far, for reference only; do not post anything to match these figures): Cash-in-Hand ${formatRupees(cashPosition.cash)}; ${bankLabel} ${formatRupees(cashPosition.bank)}.`;
  return { ...generated, scenario: `${generated.scenario.trim()}\n\n${line}` };
}

// A receipt/payment "against" a bill must settle a bill that exists: one
// open in the books (from the answer keys) or one raised earlier in this
// batch, for the same party, within its balance — and "full settlement"
// only when the amount equals it. The model invented DT-2216 / BR/S/098 /
// CS/612 (2026-09-03); a learner cannot allocate against a bill Tally has
// never seen, so the retry lists the party's real open bills.
const FULL_SETTLEMENT_PATTERN = /full (?:and final )?(?:settlement|payment)|settl(?:es|ed|ing) in full|in full settlement|clears? the (?:bill|invoice) in full/i;
// The model sometimes names a bill in the transaction text ("bill DT-2301",
// "against bill INV-016") but leaves bill_reference null in the key
// (Garima's Level 4, 2026-09-03: five purchases and one receipt). Then the
// scorer never checks the allocation, the open-bills state never learns
// the bill exists, and the settlement check never sees the reference. The
// key is filled from the text BEFORE the checks run, so what the learner is
// told and what the books track are the same thing.
// 2026-09-17 audit: the keyword needs a word boundary ("billboard-advertising"
// was read as bill "board-advertising", "inventory-related" as
// "entory-related"), the number must be bill-shaped with a digit
// (billTokensIn), and every bill a line names is kept, not only the first.
const BILL_IN_TEXT_PATTERN =
  /\b(?:bills?|invoices?|inv)\b\.?\s*(?:(?:ref(?:erence)?|no|number)\b\.?\s*)?(?:#\s*)?((?:[A-Z][A-Z0-9]*(?:[-\/][A-Z0-9]+)+)(?:\s*(?:,|and|&)\s*[A-Z][A-Z0-9]*(?:[-\/][A-Z0-9]+)+)*)/gi;

export function billReferencesInText(text: string): string[] {
  const refs: string[] = [];
  for (const match of text.matchAll(BILL_IN_TEXT_PATTERN)) {
    for (const token of billTokensIn(match[1])) {
      if (!refs.some((ref) => normalizeDocumentNumber(ref) === normalizeDocumentNumber(token))) refs.push(token);
    }
  }
  return refs;
}

export function fillBillReferencesFromText(generated: GeneratedExercise): GeneratedExercise {
  const descriptionBySequence = new Map<number, string>();
  for (const transaction of generated.transactions) {
    descriptionBySequence.set(transaction.sequence, transaction.description);
  }
  const bySequence = new Map<number, GeneratedExercise["answer_key"]["entries"]>();
  for (const entry of generated.answer_key.entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }
  const fill = new Map<number, string>();
  for (const [sequence, legs] of bySequence) {
    // A reference already on ANY leg is propagated to every leg of the
    // sequence, so no reader has to guess which leg carries it.
    const existing = legs.find((leg) => leg.bill_reference)?.bill_reference;
    if (existing) {
      if (legs.some((leg) => leg.bill_reference !== existing)) fill.set(sequence, existing);
      continue;
    }
    if (!/^(sales|purchase|receipt|payment)$/i.test(legs[0].voucher_type)) continue;
    const refs = billReferencesInText(descriptionBySequence.get(sequence) ?? "");
    if (refs.length > 0) fill.set(sequence, refs.join(", "));
  }
  if (fill.size === 0) return generated;
  return {
    ...generated,
    answer_key: {
      ...generated.answer_key,
      entries: generated.answer_key.entries.map((entry) =>
        fill.has(entry.sequence) ? { ...entry, bill_reference: fill.get(entry.sequence) ?? null } : entry,
      ),
    },
  };
}

// A known party keeps its GST treatment: CGST+SGST parties stay intra-state,
// IGST parties stay inter-state. The model relocated Deccan Traders
// (Karnataka in three earlier batches) to "Telangana" with IGST in Yeshas's
// Level 3 (2026-09-03) — consistent inside the batch, contradicting the books
// the learner has been keeping.
export function checkPartyTaxConsistency(
  generated: GeneratedExercise,
  partyTaxClasses: Map<string, PartyTaxClass>,
): string | null {
  if (partyTaxClasses.size === 0) return null;
  const bySequence = new Map<number, GeneratedExercise["answer_key"]["entries"]>();
  for (const entry of generated.answer_key.entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }
  const violations: string[] = [];
  for (const [sequence, legs] of bySequence) {
    if (!/^(sales|purchase)$/i.test(legs[0].voucher_type)) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    if (!party) continue;
    const known = partyTaxClasses.get(party.correct_account);
    if (!known) continue;
    const heads = new Set(legs.map((leg) => leg.gst_head).filter((head): head is 'CGST' | 'SGST' | 'IGST' => head !== null));
    const actual: PartyTaxClass | null = heads.has("IGST") ? "inter" : heads.has("CGST") || heads.has("SGST") ? "intra" : null;
    if (actual && actual !== known) {
      violations.push(
        `transaction ${sequence} taxes ${party.correct_account} as ${actual === "inter" ? "inter-state (IGST)" : "intra-state (CGST+SGST)"}, but this party is already ${known === "inter" ? "outside Karnataka (IGST)" : "in Karnataka (CGST+SGST)"} in the books`,
      );
    }
  }
  if (violations.length === 0) return null;
  return `Party states violated: ${violations.join("; ")}. A party's state never changes — keep the GST treatment the books already use for that party, or use a different party.`;
}

// 2026-09-17 audit: an "advance" or "new ref" anywhere in the reference no
// longer skips the whole check; each reference is checked on its own.
// Credit notes, debit notes and journals that settle bills are checked
// too, and a bill raised earlier in the batch has its real balance (the
// party total, less what the batch already settled), not an unlimited one.
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isNewReference(reference: string, ref: string): boolean {
  const escaped = escapeRegExp(ref);
  return new RegExp(`new\\s+ref(?:erence)?\\s*[:-]?\\s*${escaped}|${escaped}\\s*\\([^)]*new\\s+ref`, "i").test(reference);
}

export function checkSettlementReferences(
  generated: GeneratedExercise,
  openBills: OpenBill[],
): string | null {
  const bySequence = new Map<number, GeneratedExercise["answer_key"]["entries"]>();
  for (const entry of generated.answer_key.entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }
  const ordered = [...bySequence.entries()].sort((a, b) => a[0] - b[0]);
  const billId = (party: string, ref: string) => `${party}|${normalizeDocumentNumber(ref)}`;
  const balances = new Map<string, { party: string; ref: string; open: number }>();
  for (const bill of openBills) {
    balances.set(billId(bill.party, bill.ref), { party: bill.party, ref: bill.ref, open: Math.abs(bill.open) });
  }
  // Bills this batch raises, at their invoice total.
  for (const [, legs] of ordered) {
    if (!/^(sales|purchase)$/i.test(legs[0].voucher_type)) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    const reference = legs.find((leg) => leg.bill_reference)?.bill_reference;
    if (!party || !reference) continue;
    const own = parseBillReferences(reference).filter((parsed) => parsed.kind === "bill");
    for (const parsed of own) {
      balances.set(billId(party.correct_account, parsed.ref), { party: party.correct_account, ref: parsed.ref, open: party.amount / own.length });
    }
  }

  const listFor = (party: string) => {
    const open = [...balances.values()].filter((bill) => bill.party === party && bill.open >= 0.5);
    return open.length === 0
      ? "no open bills at all"
      : open.map((bill) => `${bill.ref} (Rs ${Math.round(bill.open).toLocaleString("en-IN")} outstanding)`).join(", ");
  };

  const violations: string[] = [];
  for (const [sequence, legs] of ordered) {
    const type = legs[0].voucher_type.trim().toLowerCase();
    const reference = legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
    if (!reference) continue;
    const parsedRefs = parseBillReferences(reference);

    if (type === "journal") {
      // A journal allocated against a bill (the 9B advance-GST reversal, a
      // write-off) moves it; a bill it names must exist for one of its legs.
      for (const parsed of parsedRefs.filter((item) => item.kind === "against" || item.kind === "bill")) {
        const owner = legs.find((leg) => balances.has(billId(leg.correct_account, parsed.ref)));
        if (!owner) {
          violations.push(`transaction ${sequence} allocates a journal against "${parsed.ref}", but no party on it has that bill open.`);
          continue;
        }
        const bill = balances.get(billId(owner.correct_account, parsed.ref));
        if (bill) bill.open -= legs.filter((leg) => leg.correct_account === owner.correct_account).reduce((sum, leg) => sum + leg.amount, 0);
      }
      continue;
    }
    if (!/^(receipt|payment|credit note|debit note)$/.test(type)) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    if (!party) continue;
    const note = type === "credit note" || type === "debit note";
    const amount = legs
      .filter((leg) => leg.correct_account === party.correct_account)
      .reduce((sum, leg) => sum + leg.amount, 0);
    const description = generated.transactions.find((t) => t.sequence === sequence)?.description ?? "";

    const settled: { parsedRef: string; bill: { party: string; ref: string; open: number } }[] = [];
    for (const parsed of parsedRefs) {
      // An advance ("ADV-C01 (Advance)"), a New Ref or an On Account
      // allocation (rulebook 4, 9, 10) opens a reference instead of settling
      // one, so there is no bill to look up and no balance to stay within.
      if (parsed.kind === "advance" || parsed.kind === "on_account" || isNewReference(reference, parsed.ref)) continue;
      const bill = balances.get(billId(party.correct_account, parsed.ref));
      if (!bill) {
        // A note's own number is not a settlement.
        if (note && parsed.kind === "bill") continue;
        violations.push(`transaction ${sequence} settles "${parsed.ref}" for ${party.correct_account}, but that bill does not exist — ${party.correct_account} has ${listFor(party.correct_account)}. Either reference one of those (amount within its balance) or make the transaction an advance recorded as a New Ref and say so in its text.`);
        continue;
      }
      settled.push({ parsedRef: parsed.ref, bill });
    }
    if (settled.length === 0) continue;
    const openTotal = settled.reduce((sum, item) => sum + Math.max(item.bill.open, 0), 0);
    const named = settled.map((item) => item.parsedRef).join(", ");
    if (amount > openTotal + 0.5) {
      violations.push(`transaction ${sequence} pays/receives ${Math.round(amount)} against ${named} for ${party.correct_account}, but only ${Math.round(openTotal)} is outstanding on it.`);
    } else if (FULL_SETTLEMENT_PATTERN.test(description) && Math.abs(amount - openTotal) > 0.5) {
      violations.push(`transaction ${sequence} is described as a full settlement of ${named} for ${party.correct_account}, but ${Math.round(openTotal)} is outstanding and the amount is ${Math.round(amount)}. Either settle the exact balance or call it a part payment.`);
    }
    // Several bills clear in order, the last taking what is left.
    let left = amount;
    settled.forEach((item, index) => {
      const applied = index === settled.length - 1 ? left : Math.min(left, Math.max(item.bill.open, 0));
      item.bill.open -= applied;
      left -= applied;
    });
  }
  if (violations.length === 0) return null;
  return `Bill references violated: ${violations.join(" ")}`;
}

// Cash/bank walked in the order the books and the statement see the
// movements: by date, then sequence (2026-09-17 audit, replacing the
// sequence-order walk of 2026-09-16). The walk runs on the model's batch
// and again after the month-end journals and Educational Mode redating, so
// the appended GST payment is checked against the balance on its own date
// and a receipt dated after a payment can no longer fund it. Sequences are
// never renumbered to match dates: the answer key, scoring and coaching all
// refer to them. A transaction with no date sorts after the dated ones.
export function checkCashFeasibility(
  generated: GeneratedExercise,
  opening: { cash: number; bank: number },
  options: { overdraftAllowed?: boolean } = {},
): string | null {
  const bySequence = new Map<number, GeneratedExercise["answer_key"]["entries"]>();
  for (const entry of generated.answer_key.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  const dates = new Map<number, { day: number; monthIndex: number; year: number }>();
  for (const transaction of generated.transactions) {
    const date = extractTransactionDate(transaction.description);
    if (date) dates.set(transaction.sequence, date);
  }
  const timeOf = (sequence: number) => {
    const date = dates.get(sequence);
    return date ? Date.UTC(date.year, date.monthIndex, date.day) : Number.POSITIVE_INFINITY;
  };
  const labelOf = (sequence: number) => {
    const date = dates.get(sequence);
    return date ? ` (dated ${String(date.day).padStart(2, "0")}-${MONTH_NAMES[date.monthIndex].slice(0, 3)}-${date.year})` : "";
  };

  let cash = opening.cash;
  let bank = opening.bank;

  const ordered = [...bySequence.entries()].sort((a, b) => timeOf(a[0]) - timeOf(b[0]) || a[0] - b[0]);
  for (const [sequence, legs] of ordered) {
    for (const leg of legs) {
      const signed = leg.dr_cr === "Dr" ? leg.amount : -leg.amount;
      if (CASH_LEDGER_PATTERN.test(leg.correct_account)) {
        cash += signed;
      } else if (isBankLedger(leg.correct_account)) {
        bank += signed;
      }
    }
    if (cash < -OVERDRAW_TOLERANCE) {
      // A till that is ALREADY overdrawn on entry (an earlier batch's fault,
      // not this one's) needs a different instruction: replenish first.
      if (opening.cash < -OVERDRAW_TOLERANCE) {
        return `Cash feasibility violated: the till opens this batch overdrawn at ${Math.round(opening.cash)}, and transaction ${sequence}${labelOf(sequence)} leaves it at ${Math.round(cash)}. Transaction 1 must be a Contra withdrawal from the bank to Cash, dated first, large enough to clear the shortfall (at least ${Math.abs(Math.round(opening.cash))}) before any other cash movement; every transaction after it must then keep cash non-negative.`;
      }
      return `Cash feasibility violated: transaction ${sequence}${labelOf(sequence)} drives Cash-in-Hand to ${Math.round(cash)}, but cash can never go negative on any date. The company holds ${Math.round(opening.cash)} in cash at the start of this batch, so every cash payment or cash-to-bank deposit must stay within that plus whatever cash came in on or before its date. Rescale or redate the cash movements to fit.`;
    }
    if (!options.overdraftAllowed && bank < -OVERDRAW_TOLERANCE) {
      return `Bank feasibility violated: transaction ${sequence}${labelOf(sequence)} drives the bank account to ${Math.round(bank)}, an overdraft the learner cannot post and the bank statement cannot show. The company holds ${Math.round(opening.bank)} in the bank at the start of this batch; keep every payment and bank-to-cash withdrawal within the balance on its own date (receipts dated later do not count).`;
    }
  }

  return null;
}

// Every hard and soft check a generated batch passes before anything is
// built from it, shared by the adaptive loop and the diagnostic fallback
// (2026-09-17 audit: the diagnostic ran none). Batch composition is the
// caller's (it needs the concept plan). Returns messages for the retry.
export type GenerationCheckContext = {
  month: ExerciseMonth;
  cashPosition: { cash: number; bank: number };
  // null skips the settlement check (the diagnostic has no open-bills list).
  openBills: OpenBill[] | null;
  partyTaxClasses: Map<string, PartyTaxClass>;
  priorRefs: Set<string>;
  tdsHistory: TdsHistory;
  documentsMode: boolean;
  companyName: string;
  stateCodeOf?: StateCodeOf;
  payeeTypeOf?: PayeeTypeOf;
  overdraftAllowed?: boolean;
};

export function runGenerationChecks(
  generated: GeneratedExercise,
  context: GenerationCheckContext,
): { hard: string[]; soft: string[] } {
  const dateOf = transactionDateOf(generated, { day: 1, monthIndex: context.month.monthIndex, year: context.month.year });
  const hard = [
    checkBatchMonth(generated, context.month),
    // 31-Jun or 30-Feb (2026-09-16): no Tally edition saves a date that
    // does not exist, for any learner.
    checkDatesExist(generated),
    // DD-Mon-YYYY only, and no dates inside document numbers (2026-09-17).
    checkCanonicalDateFormat(generated),
    checkDocumentBackedDescriptions(generated),
    // Double-entry runs BEFORE cash feasibility in the message order
    // because a single-leg key makes the cash walk blind — fixing the legs
    // is what lets the cash check see the movements at all.
    checkDoubleEntry(generated),
    checkCashFeasibility(generated, context.cashPosition, { overdraftAllowed: context.overdraftAllowed }),
    context.openBills ? checkSettlementReferences(generated, context.openBills) : null,
    checkPartyTaxConsistency(generated, context.partyTaxClasses),
    checkPlaceOfSupply(generated, context.stateCodeOf ?? stateCodeFromIdentity),
    checkReverseCharge(generated),
    // Documents mode: journal-type lines must keep their figures — that
    // text becomes the month-end notes sheet (documents-mode.ts).
    context.documentsMode ? checkMonthEndNoteDetails(generated) : null,
    // Generation hygiene (2026-09-10 audits, tightened 2026-09-17): reused
    // or missing document numbers, GST legs off the rate, TDS off the
    // section's rate or threshold for the voucher's financial year.
    checkBillNumberUniqueness(generated, context.priorRefs),
    checkGstArithmetic(generated, { dateOf }),
    checkTdsThresholds(generated, context.tdsHistory, { dateOf }),
    // 2026-09-11 audit: gst_head must state the head the leg names (the
    // invoice address and GSTIN are derived from it), and every sale must be
    // printable as our invoice before the batch leaves the loop.
    checkGstHeadMetadata(generated),
    checkTdsArithmetic(generated, { dateOf, payeeTypeOf: context.payeeTypeOf ?? payeeTypeFromIdentity }),
    // 2026-09-17 audit: the line the learner reads and the key agree on
    // every bill number and figure, and every concept tag is earned.
    checkTextMatchesKey(generated, context.openBills ?? []),
    checkConceptTagsMatchContent(generated),
    context.documentsMode ? checkSalesInvoicesBuildable(generated, context.companyName) : null,
  ].filter((message): message is string => message !== null);
  const soft = [checkOpeningFigures(generated, context.cashPosition)].filter((message): message is string => message !== null);
  return { hard, soft };
}

// The code-owned steps that change a checked batch before it is built:
// the month-end GST journals, then Educational Mode redating. Their result
// is checked again (2026-09-17 audit): the appended GST payment against the
// bank on its own date, and the redated batch in (date, sequence) order,
// which is the order the bank statement prints.
export function finalizeBatch(
  generated: GeneratedExercise,
  params: {
    licenseMode: LicenseMode;
    // The batch month for redating; null maps each date within its own month.
    month: { monthIndex: number; year: number } | null;
    cashPosition: { cash: number; bank: number };
    monthEnd: MonthEndParams | null;
    overdraftAllowed?: boolean;
  },
): { generated: GeneratedExercise; errors: string[] } {
  const errors: string[] = [];
  let result = generated;
  if (params.monthEnd) {
    const monthEnd = appendMonthEndJournals(result, params.monthEnd);
    result = monthEnd.generated;
    if (monthEnd.paymentShortfall) {
      errors.push(
        `GST payment infeasible: the system pays last month's GST liability of Rs ${Math.round(monthEnd.paymentShortfall.payable).toLocaleString("en-IN")} from the bank this month, but the batch leaves only Rs ${Math.round(monthEnd.paymentShortfall.bank).toLocaleString("en-IN")} there. Keep at least that much in the bank (fewer or smaller payments, or receipts dated before the 20th).`,
      );
    }
  }
  // Educational Mode dates, guaranteed in code (2026-09-16): every date
  // token of this month is mapped to 1, 2 or 31 HERE, before the cleanups,
  // documents mode, the bank statement and the sales documents, because
  // each of those reads its dates from the transaction text. The assertion
  // inside enforceEducationalDates throws if anything unpostable is left.
  if (params.licenseMode === "educational") {
    try {
      result = enforceEducationalDates(result, params.month);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      return { generated: result, errors };
    }
  }
  const cashError = checkCashFeasibility(result, params.cashPosition, { overdraftAllowed: params.overdraftAllowed });
  if (cashError) {
    errors.push(`After the month-end journals and final dating: ${cashError}`);
  }
  return { generated: result, errors };
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
// Diagnostics for a generation that keeps failing validation: with
// DEBUG_GENERATION set, every rejected attempt (the model's output plus the
// violation text) is written under the OS temp dir so the actual output can
// be inspected instead of guessed at (2026-09-03: three consecutive
// single-leg batches for Praveen's Level 6 regeneration).
function dumpFailedAttempt(learnerId: string, attempt: number, error: string, output: unknown): void {
  if (!process.env.DEBUG_GENERATION) return;
  try {
    const dir = path.join(os.tmpdir(), "aia-generation-debug");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${learnerId.slice(0, 8)}-${Date.now()}-attempt${attempt}.json`);
    fs.writeFileSync(file, JSON.stringify({ error, output }, null, 2));
    console.error(`[generation] attempt ${attempt} rejected — dumped to ${file}`);
  } catch {
    // diagnostics must never break generation
  }
}

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
  // 2nd, or 31st of a month. The prompt lists the dates and, since
  // 2026-09-16, the batch is redated in code after generation.
  licenseMode: LicenseMode = "licensed",
  // Month-per-batch (2026-09-01): this exercise's ordinal in the learner's
  // journey — 1 is the diagnostic pack (April 2026), 2 the first adaptive
  // batch (May 2026), and so on, one calendar month per exercise. Computed
  // in code by the caller (run-scoring passes priorExerciseCount + 1),
  // stated to the prompt as a hard rule, and enforced by checkBatchMonth in
  // the retry loop below.
  exerciseOrdinal = 2,
  // Documents mode (2026-09-09): every transaction is delivered as
  // paperwork — see lib/tutor/documents-mode.ts. Decided by the caller from
  // the learner's mastery.
  documentsMode = false,
): Promise<{ id: string }> {
  const difficultyLevel = target.reinforcementActive
    ? dropOneLevel(baseDifficultyLevel)
    : baseDifficultyLevel;
  const exerciseMonth = exerciseMonthForModule(exerciseOrdinal);

  // One read of the company's state feeds BOTH the prompt and every
  // deterministic check below (getCompanyState, 2026-09-03).
  const {
    ledgerRegistry: companyLedgerRegistry,
    recentTransactionLog: recentCompanyTransactionLog,
    companyName,
    cashPosition,
    openingBalances,
    openBills,
    partyTaxClasses,
  } = await getCompanyState(supabase, learnerId);

  // Every answer key so far (2026-09-10): bill numbers already used, this
  // year's TDS totals per payee, and the GST position the month-end
  // journals are computed from. exerciseOrdinal is 1-based (1 = the April
  // pack), the keys 0-based, so this financial year's keys start at index
  // floor((ordinal - 1) / 12) * 12.
  const priorKeys = await loadAnswerKeys(supabase, learnerId);
  const yearStartIndex = Math.floor((exerciseOrdinal - 1) / 12) * 12;
  const priorRefs = priorBillReferences(priorKeys);
  const tdsHistory = tdsHistoryFromKeys(priorKeys.slice(yearStartIndex));

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
    openBills,
    partyTaxClasses,
    documentsMode,
    usedBillNumbers: priorDocumentNumbers(priorKeys),
  };

  let lastError: string | null = null;
  let generated: GeneratedExercise | null = null;
  // Only SOFT violations (batch composition, an opening figure quoted in
  // the prose) may fall back to the last attempt when the model never
  // complies within MAX_ATTEMPTS. HARD violations — wrong month, figures in
  // document-backed lines, single-leg entries, cash going negative, a
  // settlement against a bill that does not exist — are never delivered:
  // a wrong batch costs the learner far more than a delayed one (the job
  // step retries), and a delivered fallback silently defeats every guard.
  let unbalancedFallback: GeneratedExercise | null = null;

  // Month-end GST journals with figures from the ledger (2026-09-10): the
  // set-off and the payment to the government are appended when the
  // batch's concepts call for them, replacing anything the model wrote.
  // Since 2026-09-17 they are appended INSIDE the loop, so a payment the
  // bank cannot fund on its date sends the batch back for a retry instead
  // of being silently skipped or overdrawing the statement.
  const batchConcepts: ConceptTag[] = [
    target.conceptTag,
    ...(target.escalationActive || !batchPlan ? [] : [...batchPlan.strengths, ...batchPlan.weaknesses]),
  ];
  const bankAccount = openingBalances.find((opening) => isBankLedger(opening.account))?.account ?? "HDFC Bank — 1234";
  const checkContext: GenerationCheckContext = {
    month: exerciseMonth,
    cashPosition,
    openBills,
    partyTaxClasses,
    priorRefs,
    tdsHistory,
    documentsMode,
    companyName: companyName ?? "Blossom Retail Pvt Ltd",
  };

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

    const parsedRaw = GeneratedExerciseSchema.safeParse(raw);
    const parsed = parsedRaw.success
      ? { success: true as const, data: fillBillReferencesFromText(parsedRaw.data) }
      : parsedRaw;

    if (parsed.success) {
      // Every violation is combined into one retry message so a single
      // retry can fix everything at once.
      const compositionError = checkBatchComposition(
        parsed.data,
        batchPlan,
        target.escalationActive,
      );
      const { hard, soft } = runGenerationChecks(parsed.data, checkContext);
      let finalized: GeneratedExercise | null = null;
      if (hard.length === 0) {
        const bankAfterBatch =
          cashPosition.bank +
          parsed.data.answer_key.entries
            .filter((entry) => isBankLedger(entry.correct_account))
            .reduce((sum, entry) => sum + (entry.dr_cr === "Dr" ? entry.amount : -entry.amount), 0);
        const outcome = finalizeBatch(parsed.data, {
          licenseMode,
          month: exerciseMonth,
          cashPosition,
          monthEnd: {
            priorKeys,
            concepts: batchConcepts,
            month: exerciseMonth,
            licenseMode,
            bankAccount,
            bankAfterBatch,
            ledgerNames: companyLedgerRegistry.map((entry) => entry.ledger_name),
          },
        });
        hard.push(...outcome.errors);
        finalized = outcome.generated;
      }
      const batchError = [compositionError, ...hard, ...soft].filter(Boolean).join(" ");
      if (batchError === "" && finalized) {
        generated = finalized;
        break;
      }
      if (hard.length === 0 && finalized) {
        unbalancedFallback = finalized;
      }
      lastError = batchError;
      dumpFailedAttempt(learnerId, attempt, batchError, parsed.data);
      continue;
    }

    lastError = parsed.error.message;
    dumpFailedAttempt(learnerId, attempt, lastError, raw);
  }

  if (!generated && unbalancedFallback) {
    generated = unbalancedFallback;
  }

  if (!generated) {
    throw new Error(
      `Adaptive exercise generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
    );
  }

  // Advances from earlier months (2026-09-21): the next bill or invoice of
  // the same party names the advance it adjusts ("ADV-02 (Advance),
  // BM/2025-06"), so a learner who adjusts it is scored correct and one who
  // books the whole bill as new is not. Done in code, after validation, so
  // it never depends on the model remembering an April advance.
  generated = adjustOpenAdvances(generated, advancesToAdjust(priorKeys, openingBalances));

  generated = stampOpeningPosition(
    scrubOpeningFigureSentences(stripDuplicateTransactionList(generated), cashPosition),
    cashPosition,
    openingBalances,
  );

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

  // Documents mode: every transaction becomes document-backed, the brief
  // lines become pointers, and the sales invoices / month-end notes are
  // built here by code from the key. Applied AFTER every validation and
  // stamp above so the checks saw the model's full-detail text, and BEFORE
  // the statement so the pointers and narrations line up.
  const documentsPlan = documentsMode
    ? applyDocumentsMode(generatedWithOpenings, {
        companyName: companyName ?? "Blossom Retail Pvt Ltd",
        monthLabel: exerciseMonth.label,
        priorKeys,
      })
    : null;
  const modeApplied = documentsPlan ? documentsPlan.generated : generatedWithOpenings;

  // Statement lines, running balance and reference numbers come from the
  // key and the real opening bank balance; the same references are written
  // into the key's narrations so "copy the bank reference verbatim" is
  // satisfiable (2026-09-03).
  const statement =
    planSourceDocuments(modeApplied).bankLines.length > 0
      ? buildBankStatementContent({
          companyName: companyName ?? "Blossom Retail Pvt Ltd",
          openingBankBalance: cashPosition.bank,
          generated: modeApplied,
        })
      : null;
  const finalExercise = statement
    ? applyBankReferences(modeApplied, statement.referenceBySequence)
    : modeApplied;

  const codeBuiltDocuments = documentsPlan
    ? [
        ...documentsPlan.salesInvoices.map(({ sequence, content }) => ({
          document: { doc_type: "sales_invoice" as const, content },
          seed: `sales:${sequence}`,
        })),
        ...(documentsPlan.monthEndNotes
          ? [{ document: { doc_type: "month_end_note" as const, content: documentsPlan.monthEndNotes }, seed: "month-end-notes" }]
          : []),
        // Sales register CSV for AI Accountant's sales upload (2026-09-09):
        // same figures as the sales invoices, one file per batch.
        ...(documentsPlan.salesRegister
          ? [{ document: { doc_type: "sales_register" as const, content: documentsPlan.salesRegister }, seed: "sales-register" }]
          : []),
      ]
    : [];

  const documents = await prepareSourceDocuments(
    supabase,
    learnerId,
    finalExercise,
    companyName ?? "Blossom Retail Pvt Ltd",
    statement?.content ?? null,
    codeBuiltDocuments,
  );

  const { id } = await insertExercise(supabase, learnerId, kind, finalExercise);

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

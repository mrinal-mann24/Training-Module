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

  const [companyLedgerRegistry, recentCompanyTransactionLog, companyName] =
    await Promise.all([
      getCompanyLedgerRegistry(supabase, learnerId),
      getRecentCompanyTransactionLog(supabase, learnerId),
      getCompanyName(supabase, learnerId),
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
      // Composition, month, and document-pointer violations are combined
      // into one retry message so a single retry can fix everything at once.
      const compositionError = checkBatchComposition(
        parsed.data,
        batchPlan,
        target.escalationActive,
      );
      const monthError = checkBatchMonth(parsed.data, exerciseMonth);
      const documentTextError = checkDocumentBackedDescriptions(parsed.data);
      const batchError = [compositionError, monthError, documentTextError]
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

  // Slow work (LLM + PDF render + upload) BEFORE the exercise row exists —
  // the chat's poll delivers the exercise as soon as the row appears, so
  // documents must already be uploaded by then (2026-09-01 race fix).
  const documents = await prepareSourceDocuments(
    supabase,
    learnerId,
    generated,
    companyName ?? "Blossom Retail Pvt Ltd",
  );

  const { id } = await insertExercise(supabase, learnerId, kind, generated);

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

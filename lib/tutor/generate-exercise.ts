import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import { buildDiagnosticPrompt, buildDiagnosticRetryPrompt } from '@/lib/llm/prompts/diagnostic-exercise';
import { buildAdaptivePrompt, buildAdaptiveRetryPrompt } from '@/lib/llm/prompts/adaptive-exercise';
import {
  GeneratedExerciseSchema,
  EXERCISE_DIFFICULTY_LEVELS,
  type ConceptTag,
  type ExerciseVariant,
  type ExerciseDifficultyLevel,
  type GeneratedExercise,
} from '@/lib/schemas/exercise';
import { insertExercise } from '@/lib/db/queries/exercises';
import { getCompanyLedgerRegistry, getRecentCompanyTransactionLog, registerCompanyLedgers, appendCompanyTransactionLog } from '@/lib/db/queries/company';
import { insertSourceDocument } from '@/lib/db/queries/source-documents';
import { generateSourceDocument, generateBankStatementDocument } from '@/lib/documents/generate-source-document';
import { renderSourceDocumentPdf } from '@/lib/documents/render-source-document';
import type { BankStatementLineInput } from '@/lib/llm/prompts/source-document';
import type { WeakConceptTarget } from '@/lib/tutor/mastery';
import type { LicenseMode } from '@/lib/schemas/onboarding';

const MAX_ATTEMPTS = 3;

// Voucher types whose "document" in real life is a line on the bank
// statement, never a vendor invoice — a contra transfer, a customer receipt,
// or a payment cannot arrive as a bill. The LLM sometimes marks these
// vendor_invoice anyway (observed live 2026-09-01 as "Invoice — HDFC
// Bank.pdf" and "Invoice — TDS Payable.pdf" cards), so the doc type is
// normalized deterministically here rather than trusted.
const BANK_SIDE_VOUCHER_TYPES = new Set(['contra', 'receipt', 'payment']);

export type SourceDocumentPlan = {
  // One vendor invoice per transaction (each real bill IS its own document).
  invoices: { entry: GeneratedExercise['answer_key']['entries'][number]; partyAccounts: string[] }[];
  // ALL bank-side transactions of the batch, destined for ONE combined
  // statement — a real statement lists every movement of the period.
  bankLines: BankStatementLineInput[];
};

// Pure planner for which documents an exercise gets — exported for tests.
// Dedupes by sequence (the answer key is one entry PER LEG, so a two-leg
// transaction flagged on both legs previously produced two identical PDFs),
// normalizes bank-side voucher types to bank_statement, and splits into
// per-bill invoices vs. the single combined statement's lines.
export function planSourceDocuments(generated: GeneratedExercise): SourceDocumentPlan {
  const descriptionBySequence = new Map<number, string>();
  for (const transaction of generated.transactions) {
    descriptionBySequence.set(transaction.sequence, transaction.description);
  }

  const seenSequences = new Set<number>();
  const plan: SourceDocumentPlan = { invoices: [], bankLines: [] };

  for (const entry of generated.answer_key.entries) {
    if (!entry.requires_source_document || entry.source_document_type === null) {
      continue;
    }
    if (seenSequences.has(entry.sequence)) {
      continue;
    }
    seenSequences.add(entry.sequence);

    const partyAccounts = generated.answer_key.entries
      .filter((sibling) => sibling.sequence === entry.sequence)
      .map((sibling) => sibling.correct_account);

    const bankSide = BANK_SIDE_VOUCHER_TYPES.has(entry.voucher_type.trim().toLowerCase());
    const docType = bankSide ? 'bank_statement' : entry.source_document_type;

    if (docType === 'bank_statement') {
      plan.bankLines.push({
        entry,
        partyAccounts,
        transactionDescription: descriptionBySequence.get(entry.sequence) ?? '(no description available)',
      });
    } else {
      plan.invoices.push({ entry, partyAccounts });
    }
  }

  return plan;
}

// Generates, renders, and uploads the exercise's source-document PDFs, then
// persists the exercise_source_documents rows: one vendor invoice per billed
// transaction, plus AT MOST ONE combined bank statement carrying every
// bank-side transaction as a line. Runs after the exercise itself is
// persisted (so its answer_key already exists to ground each document's
// figures against), and is awaited by the caller — a document
// generation/render/upload failure propagates and fails the whole
// exercise-generation call, rather than silently delivering an exercise
// whose promised source document never arrives. The LLM calls only produce
// validated structured content; rendering to PDF and upload are fully
// deterministic from there, per this unit's "code renders, LLM never
// touches the PDF" boundary.
async function generateAndAttachSourceDocuments(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  generatedExercise: GeneratedExercise,
): Promise<void> {
  const plan = planSourceDocuments(generatedExercise);

  async function renderAndPersist(
    generated: Awaited<ReturnType<typeof generateSourceDocument>>,
    docType: 'vendor_invoice' | 'bank_statement',
    formatSeed: string,
  ): Promise<void> {
    // Phase 4 (spec 16): format rotation seed — deterministic per
    // exercise + transaction, so a re-render picks the same format while
    // documents across a batch vary.
    const pdfBuffer = await renderSourceDocumentPdf(generated, formatSeed);

    const docId = crypto.randomUUID();
    const storagePath = `${learnerId}/${exerciseId}/${docId}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from('exercise-documents')
      .upload(storagePath, pdfBuffer, { contentType: 'application/pdf' });

    if (uploadError) {
      throw uploadError;
    }

    await insertSourceDocument(supabase, exerciseId, docType, storagePath, generated.content);
  }

  for (const invoice of plan.invoices) {
    const generated = await generateSourceDocument(
      learnerId,
      'vendor_invoice',
      invoice.entry,
      invoice.partyAccounts,
    );
    await renderAndPersist(generated, 'vendor_invoice', `${exerciseId}:${invoice.entry.sequence}`);
  }

  if (plan.bankLines.length > 0) {
    const generated = await generateBankStatementDocument(learnerId, plan.bankLines);
    await renderAndPersist(generated, 'bank_statement', `${exerciseId}:bank-statement`);
  }
}

// Deterministic, not random, so the same learner always gets the same variant
// if regeneration is ever re-triggered in testing.
export function selectDiagnosticVariant(learnerId: string): ExerciseVariant {
  const hash = createHash('sha256').update(learnerId).digest();
  return hash[0] % 2 === 0 ? 'A' : 'B';
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
      traceName: 'diagnostic-generation',
      learnerId,
      callType: 'diagnostic-generation',
    });

    const parsed = GeneratedExerciseSchema.safeParse(raw);

    if (parsed.success) {
      const { id } = await insertExercise(supabase, learnerId, 'diagnostic', parsed.data);
      await generateAndAttachSourceDocuments(supabase, learnerId, id, parsed.data);
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
  if (transactionCount < MIN_TRANSACTIONS_PER_BATCH || transactionCount > MAX_TRANSACTIONS_PER_BATCH) {
    return `The batch has ${transactionCount} transactions; the composition rules require ${MIN_TRANSACTIONS_PER_BATCH} to ${MAX_TRANSACTIONS_PER_BATCH}.`;
  }

  // A learner with no established strengths legitimately gets a one-sided
  // batch (the prompt fills the step-up half with the target concept).
  if (batchPlan.strengths.length === 0) {
    return null;
  }

  const strengthSet = new Set<ConceptTag>(batchPlan.strengths);
  const weaknessSet = new Set<ConceptTag>(batchPlan.weaknesses);
  const perSequence = new Map<number, { strength: boolean; weakness: boolean }>();
  for (const entry of generated.answer_key.entries) {
    const slot = perSequence.get(entry.sequence) ?? { strength: false, weakness: false };
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

  if (strengthCount < MIN_TRANSACTIONS_PER_SIDE || weaknessCount < MIN_TRANSACTIONS_PER_SIDE) {
    return `Batch composition violated: only ${strengthCount} transactions carry a strength concept (${batchPlan.strengths.join(', ')}) and ${weaknessCount} carry a weakness concept (${batchPlan.weaknesses.join(', ')}). At least ${MIN_TRANSACTIONS_PER_SIDE} transactions per side are required — rebuild the batch so roughly half step up the strength concepts and half reinforce the weakness concepts, with concept_tags attributing each transaction.`;
  }

  return null;
}

// One level down from currentLevel, floored at L0 — used when reinforcement
// is active, per the spec's "drops one difficulty level and re-targets"
// rule. Never below the lowest defined level.
function dropOneLevel(currentLevel: ExerciseDifficultyLevel): ExerciseDifficultyLevel {
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
  kind: 'adaptive' | 'explain' = 'adaptive',
  recentStrengthDescriptions: string[] = [],
  // Phase 2: the 50/50 composition plan. Ignored (forced empty) in
  // escalation mode, which narrows to the single target concept.
  batchPlan: { strengths: ConceptTag[]; weaknesses: ConceptTag[] } | null = null,
  // Phase 3 (spec 15): educational-mode learners can only post on the 1st,
  // 2nd, or last day of a month — the generation prompt enforces the dates.
  licenseMode: LicenseMode = 'licensed',
): Promise<{ id: string }> {
  const difficultyLevel = target.reinforcementActive ? dropOneLevel(baseDifficultyLevel) : baseDifficultyLevel;

  const [companyLedgerRegistry, recentCompanyTransactionLog] = await Promise.all([
    getCompanyLedgerRegistry(supabase, learnerId),
    getRecentCompanyTransactionLog(supabase, learnerId),
  ]);

  const promptParams = {
    targetConceptTag: target.conceptTag,
    batchStrengthConcepts: target.escalationActive || !batchPlan ? [] : batchPlan.strengths,
    batchWeaknessConcepts: target.escalationActive || !batchPlan ? [] : batchPlan.weaknesses,
    recentStrengthDescriptions,
    difficultyLevel,
    licenseMode,
    escalationActive: target.escalationActive,
    companyLedgerRegistry,
    recentCompanyTransactionLog,
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
      lastError === null ? buildAdaptivePrompt(promptParams) : buildAdaptiveRetryPrompt(promptParams, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'adaptive-generation',
      learnerId,
      callType: 'adaptive-generation',
      extraMetadata: { targetConceptTag: target.conceptTag, reason: target.reason },
    });

    const parsed = GeneratedExerciseSchema.safeParse(raw);

    if (parsed.success) {
      const compositionError = checkBatchComposition(parsed.data, batchPlan, target.escalationActive);
      if (compositionError === null) {
        generated = parsed.data;
        break;
      }
      unbalancedFallback = parsed.data;
      lastError = compositionError;
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

  const { id } = await insertExercise(supabase, learnerId, kind, generated);

  await generateAndAttachSourceDocuments(supabase, learnerId, id, generated);

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

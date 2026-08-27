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
import { generateSourceDocument } from '@/lib/documents/generate-source-document';
import { renderSourceDocumentPdf } from '@/lib/documents/render-source-document';
import type { WeakConceptTarget } from '@/lib/tutor/mastery';
import type { LicenseMode } from '@/lib/schemas/onboarding';

const MAX_ATTEMPTS = 3;

// Generates, renders, and uploads a PDF for every answer-key entry flagged
// requires_source_document: true, then persists the exercise_source_documents
// row. Runs after the exercise itself is persisted (so its answer_key already
// exists to ground each document's figures against), and is awaited by the
// caller — a document generation/render/upload failure propagates and fails
// the whole exercise-generation call, rather than silently delivering an
// exercise whose promised source document never arrives. The LLM call
// (generateSourceDocument) only produces validated structured content;
// rendering to PDF and upload are fully deterministic from there, per this
// unit's "code renders, LLM never touches the PDF" boundary.
async function generateAndAttachSourceDocuments(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  answerKey: GeneratedExercise['answer_key'],
): Promise<void> {
  const flaggedEntries = answerKey.entries.filter(
    (entry) => entry.requires_source_document && entry.source_document_type !== null,
  );

  for (const entry of flaggedEntries) {
    const docType = entry.source_document_type;
    if (!docType) {
      continue;
    }

    const partyAccounts = answerKey.entries
      .filter((sibling) => sibling.sequence === entry.sequence)
      .map((sibling) => sibling.correct_account);
    const generated = await generateSourceDocument(learnerId, docType, entry, partyAccounts);
    // Phase 4 (spec 16): format rotation seed — deterministic per
    // exercise + transaction, so a re-render picks the same format while
    // documents across a batch vary.
    const pdfBuffer = await renderSourceDocumentPdf(generated, `${exerciseId}:${entry.sequence}`);

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
      await generateAndAttachSourceDocuments(supabase, learnerId, id, parsed.data.answer_key);
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

  await generateAndAttachSourceDocuments(supabase, learnerId, id, generated.answer_key);

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

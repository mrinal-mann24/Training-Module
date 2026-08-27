import type { SupabaseClient } from '@supabase/supabase-js';
import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildReviewExercisePrompt,
  buildReviewExerciseRetryPrompt,
  type ReviewSourceItem,
} from '@/lib/llm/prompts/review-exercise';
import { ReviewExerciseScenarioSchema, type ReviewExerciseScenario, type ExerciseDifficultyLevel } from '@/lib/schemas/exercise';
import { insertReviewExercise } from '@/lib/db/queries/exercises';
import { insertLedgerReviewItems, type NewLedgerReviewItem } from '@/lib/db/queries/ledger-review-items';
import { getAnomalyTemplates, type AnomalyTemplate } from '@/lib/db/queries/anomaly-templates';
import { getRecentCompanyTransactionLog, type CompanyTransactionLogEntry } from '@/lib/db/queries/company';
import { selectDiagnosticVariant } from '@/lib/tutor/generate-exercise';

const MAX_ATTEMPTS = 3;

// How many real entries + distractors make up one review packet. Named
// constants per code-standards, not magic numbers scattered inline.
const REAL_ENTRY_COUNT = 4;
const DISTRACTOR_COUNT = 3;

function summarizeTransactionLogEntry(entry: CompanyTransactionLogEntry): string {
  const summary = entry.voucher_summary as {
    voucherType?: string | null;
    ledgers?: string[];
    transactionCount?: number;
    difficultyLevel?: string;
  };
  const ledgers = summary.ledgers?.join(', ') ?? 'unknown ledgers';
  return `A ${summary.voucherType ?? 'unspecified'}-type entry from a prior exercise, involving ${ledgers}.`;
}

// ASSUMPTION: this codebase has no "uncorrected past error" tracking on
// company_transaction_log entries (nothing marks a prior transaction as
// having gone out wrong and never fixed) — so real entries pulled from the
// log are always presented as clean (is_anomaly: false, source:
// 'real_transaction'). The spec's "some genuinely fine, some — if an
// uncorrected past error exists — genuinely anomalous" is honored as written
// (an uncorrected-error case would be included if one existed to find); this
// just documents that none currently can. Revisit if a later unit adds error
// tracking to company_transaction_log.
function selectRealEntries(log: CompanyTransactionLogEntry[]): ReviewSourceItem[] {
  return log.slice(0, REAL_ENTRY_COUNT).map((entry, index) => ({
    sequence: index + 1,
    isAnomaly: false,
    sourceDescription: summarizeTransactionLogEntry(entry),
  }));
}

function selectDistractors(templates: AnomalyTemplate[], startSequence: number): {
  items: ReviewSourceItem[];
  templateBySequence: Map<number, AnomalyTemplate>;
} {
  // Half anomalies, half clean distractors (a "looks similar to a real
  // anomaly pattern but is actually fine" item) — so the learner has to
  // genuinely discriminate, not just flag everything from this half of the
  // packet. Deterministic slice, not random — same "no Math.random in
  // generation" posture as selectDiagnosticVariant.
  const items: ReviewSourceItem[] = [];
  const templateBySequence = new Map<number, AnomalyTemplate>();

  templates.slice(0, DISTRACTOR_COUNT).forEach((template, index) => {
    const sequence = startSequence + index;
    const isAnomaly = index % 2 === 0;
    items.push({
      sequence,
      isAnomaly,
      sourceDescription: isAnomaly ? template.anomaly_description : template.clean_distractor_description,
    });
    templateBySequence.set(sequence, template);
  });

  return { items, templateBySequence };
}

// Selects a mix of real entries from company_transaction_log (Unit 09) and
// library-seeded distractors (anomaly_templates), assembles the learner-facing
// review packet via the LLM (phrasing only — which items are anomalies is
// decided here in code, deterministically, never left to the LLM), and
// persists ledger_review_items as this exercise's server-only answer key.
export async function generateReviewExercise(
  supabase: SupabaseClient,
  learnerId: string,
  difficultyLevel: ExerciseDifficultyLevel,
): Promise<{ id: string }> {
  const [recentLog, anomalyTemplates] = await Promise.all([
    getRecentCompanyTransactionLog(supabase, learnerId),
    getAnomalyTemplates(supabase, difficultyLevel),
  ]);

  const realItems = selectRealEntries(recentLog);
  const { items: distractorItems, templateBySequence } = selectDistractors(
    anomalyTemplates,
    realItems.length + 1,
  );
  const sourceItems = [...realItems, ...distractorItems];

  if (sourceItems.length === 0) {
    throw new Error('Cannot generate a review exercise: no transaction history or anomaly templates available yet.');
  }

  const variant = selectDiagnosticVariant(learnerId);
  const promptParams = { difficultyLevel, variant, items: sourceItems };

  let lastError: string | null = null;
  let generated: ReviewExerciseScenario | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildReviewExercisePrompt(promptParams)
        : buildReviewExerciseRetryPrompt(promptParams, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'review-exercise-generation',
      learnerId,
      callType: 'review-exercise-generation',
    });

    const parsed = ReviewExerciseScenarioSchema.safeParse(raw);

    if (parsed.success && parsed.data.packet_items.length === sourceItems.length) {
      generated = parsed.data;
      break;
    }

    lastError = parsed.success
      ? `Expected ${sourceItems.length} packet items, got ${parsed.data.packet_items.length}.`
      : parsed.error.message;
  }

  if (!generated) {
    throw new Error(`Review exercise generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  }

  const { id } = await insertReviewExercise(supabase, learnerId, generated);

  const presentedTextBySequence = new Map(generated.packet_items.map((item) => [item.sequence, item.presented_text]));
  const realSequences = new Set(realItems.map((item) => item.sequence));

  const reviewItems: NewLedgerReviewItem[] = sourceItems.map((sourceItem) => {
    const presentedText = presentedTextBySequence.get(sourceItem.sequence) ?? sourceItem.sourceDescription;
    if (realSequences.has(sourceItem.sequence)) {
      return {
        source: 'real_transaction',
        companyTransactionLogId: recentLog[sourceItem.sequence - 1]?.id ?? null,
        anomalyTemplateId: null,
        isAnomaly: sourceItem.isAnomaly,
        presentedText,
      };
    }
    const template = templateBySequence.get(sourceItem.sequence) ?? null;
    return {
      source: 'generated_distractor',
      companyTransactionLogId: null,
      anomalyTemplateId: template?.id ?? null,
      isAnomaly: sourceItem.isAnomaly,
      presentedText,
    };
  });

  await insertLedgerReviewItems(supabase, id, reviewItems);

  return { id };
}

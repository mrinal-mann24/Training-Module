import { z } from 'zod';
import { SOURCE_DOCUMENT_TYPES } from '@/lib/schemas/source-document';

export const EXERCISE_VARIANTS = ['A', 'B'] as const;
export type ExerciseVariant = (typeof EXERCISE_VARIANTS)[number];

// Unit 11: 'explain' is a direct-entry exercise (same Tally posting +
// answer_key as diagnostic/adaptive) plus a free-text explanation part.
// 'review' has no Tally posting at all — its answer-key equivalent is
// ledger_review_items, not answer_key (see GeneratedReviewExerciseSchema
// below), so a 'review' exercise's answer_key.entries is always empty.
export const EXERCISE_KINDS = ['diagnostic', 'adaptive', 'explain', 'review'] as const;
export type ExerciseKind = (typeof EXERCISE_KINDS)[number];

export const SUBMISSION_PART_TYPES = ['daybook_xml', 'trialbalance_xml', 'explain_text', 'review_text'] as const;
export type SubmissionPartType = (typeof SUBMISSION_PART_TYPES)[number];

// Which submission_parts a submission for each exercise kind must have
// before it's "complete" (submission-parts.ts). Set on exercises.required_parts
// at generation time. Direct-entry exercises (diagnostic/adaptive) keep the
// original two-file requirement, unchanged from Units 05-07 — they're never
// routed through the wait-for-submission job (lib/jobs/wait-for-submission.ts
// only triggers for exercises with more than one required part).
export const REQUIRED_PARTS_BY_KIND: Record<ExerciseKind, readonly SubmissionPartType[]> = {
  diagnostic: ['daybook_xml', 'trialbalance_xml'],
  adaptive: ['daybook_xml', 'trialbalance_xml'],
  explain: ['daybook_xml', 'trialbalance_xml', 'explain_text'],
  review: ['review_text'],
};

export const EXERCISE_DIFFICULTY_LEVELS = ['L0', 'L1', 'L2', 'L3', 'L4'] as const;
export type ExerciseDifficultyLevel = (typeof EXERCISE_DIFFICULTY_LEVELS)[number];

// Fixed vocabulary of accounting concepts this product teaches, per
// project-overview.md's Tally-only module sequence (0-12). Unit 09 needs a
// real "concept," not the generic scored field names in scoring.ts (account,
// gst, tds, etc.) — the LLM tags each answer-key entry with the concept it's
// actually drilling, and score-submission.ts rolls per-entry correctness up
// to a per-concept result for concept_attempts. Extend this list only when a
// later unit's spec introduces a new concept area — do not build ahead.
export const CONCEPT_TAGS = [
  'sales_voucher_basics',
  'purchase_voucher_basics',
  'payment_voucher_basics',
  'receipt_voucher_basics',
  'contra_voucher_basics',
  'journal_voucher_basics',
  'gst_classification',
  'tds_classification',
  'bill_by_bill_referencing',
  'narration_discipline',
  'trial_balance_tie_out',
] as const;
export type ConceptTag = (typeof CONCEPT_TAGS)[number];

// Unit 12: concept-to-module lookup for module_progress advancement and the
// /progress page's grouped-by-module display. No prior unit defined a
// module-numbering/grouping scheme beyond Unit 09's *derived* progress-label
// number (mastered-concept count + 1) — this is a distinct, stored concept
// (module_progress.current_module), so it needs its own explicit mapping.
// One concept per module, in CONCEPT_TAGS declaration order — confirmed with
// the user rather than inventing a thematic grouping the spec doesn't define.
export const CONCEPT_TO_MODULE: Record<ConceptTag, number> = Object.fromEntries(
  CONCEPT_TAGS.map((tag, index) => [tag, index + 1]),
) as Record<ConceptTag, number>;

// Learner-facing: a single posted transaction, prose only, no correct-answer hints.
const TransactionSchema = z.object({
  sequence: z.number().int().positive(),
  description: z.string(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

// Learner-facing scenario shown in chat.
export const ExerciseScenarioSchema = z.object({
  scenario: z.string(),
  transactions: z.array(TransactionSchema),
  difficulty_level: z.enum(EXERCISE_DIFFICULTY_LEVELS),
  variant: z.enum(EXERCISE_VARIANTS),
});
export type ExerciseScenario = z.infer<typeof ExerciseScenarioSchema>;

export const GST_HEADS = ['CGST', 'SGST', 'IGST'] as const;
export type GstHead = (typeof GST_HEADS)[number];

// Server-only: the answer key. Never included in any client-facing type or response.
// GST/TDS/voucher_type/bill_reference/narration are nullable, not optional: the LLM
// must state explicitly that a transaction has no GST/TDS/bill reference rather than
// omitting the field, since score-submission.ts treats a present-but-null field as
// "this transaction has none" and an entry missing the field entirely as a schema error.
const AnswerKeyEntrySchema = z.object({
  sequence: z.number().int().positive(),
  correct_account: z.string(),
  // Alternate acceptable ledger names for this leg. Learners legitimately
  // name the same ledger differently ("Purchases" vs "Trading goods" copied
  // from a register's nature column, "Sales" vs "Credit Sales A/c") and the
  // pilot reviewer accepted those — exact-name scoring flagged 169 false
  // ACCOUNT_WRONGs on a real submission. Optional; empty for generated
  // exercises whose scenario prose dictates the ledger name.
  account_aliases: z.array(z.string()).optional(),
  dr_cr: z.enum(['Dr', 'Cr']),
  amount: z.number(),
  voucher_type: z.string(),
  gst_head: z.enum(GST_HEADS).nullable(),
  gst_rate: z.number().nullable(),
  tds_section: z.string().nullable(),
  tds_rate: z.number().nullable(),
  tds_base: z.number().nullable(),
  bill_reference: z.string().nullable(),
  narration: z.string().nullable(),
  // The concept(s) this transaction is drilling, from the fixed CONCEPT_TAGS
  // vocabulary. Non-empty: every transaction must be attributable to at
  // least one concept for concept_attempts logging (mastery.ts). Most
  // transactions carry one tag; a trap/multi-concept transaction (later
  // modules) can carry more than one.
  concept_tags: z.array(z.enum(CONCEPT_TAGS)).min(1),
  // Unit 10: whether this transaction should be delivered to the learner
  // backed by a generated source document (PDF invoice/bill or bank
  // statement) instead of a plain-text description alone. The LLM decides
  // per transaction, matching the product's rising-realism progression —
  // there's no separate module/difficulty config table driving this.
  // requires_source_document is the gate; source_document_type is null
  // whenever it's false, and one of SOURCE_DOCUMENT_TYPES whenever it's true
  // (the LLM must choose the type that actually fits the transaction, e.g. a
  // vendor purchase gets a vendor_invoice, a bank-recorded receipt/payment
  // gets a bank_statement).
  requires_source_document: z.boolean(),
  source_document_type: z.enum(SOURCE_DOCUMENT_TYPES).nullable(),
});
export type AnswerKeyEntry = z.infer<typeof AnswerKeyEntrySchema>;

const AnswerKeySchema = z.object({
  entries: z.array(AnswerKeyEntrySchema),
  // Unit 14R: authored pack companies start with opening balances (the pack's
  // Opening TB). Trial Balance tie-out must include them — closing = opening
  // + movements — or every pack submission fails tie-out regardless of
  // correctness. Absent/empty for generated exercises (fresh companies).
  opening_balances: z
    .array(
      z.object({
        account: z.string(),
        dr_cr: z.enum(['Dr', 'Cr']),
        amount: z.number(),
      }),
    )
    .optional(),
});
export type AnswerKey = z.infer<typeof AnswerKeySchema>;

// Full shape validated against the raw LLM response. answer_key must never be
// spread into a client-facing shape — callers should destructure ExerciseScenarioSchema
// fields explicitly rather than passing this type through to the client.
export const GeneratedExerciseSchema = ExerciseScenarioSchema.extend({
  answer_key: AnswerKeySchema,
});
export type GeneratedExercise = z.infer<typeof GeneratedExerciseSchema>;

// Unit 11: a 'review' exercise's learner-facing packet — a numbered list of
// line items to review (mix of real entries and seeded distractors, per
// generate-review-exercise.ts), presented as plain text in chat. No Tally
// posting, no answer_key.entries — this schema's item order is what
// ledger_review_items.presented_text/is_anomaly (the server-only answer key)
// is keyed against by sequence.
const ReviewPacketItemSchema = z.object({
  sequence: z.number().int().positive(),
  presented_text: z.string(),
});
export type ReviewPacketItem = z.infer<typeof ReviewPacketItemSchema>;

export const ReviewExerciseScenarioSchema = z.object({
  scenario: z.string(),
  packet_items: z.array(ReviewPacketItemSchema),
  difficulty_level: z.enum(EXERCISE_DIFFICULTY_LEVELS),
  variant: z.enum(EXERCISE_VARIANTS),
});
export type ReviewExerciseScenario = z.infer<typeof ReviewExerciseScenarioSchema>;

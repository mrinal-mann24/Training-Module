import { z } from 'zod';
import { CONCEPT_TAGS } from './exercise';

// Internal error codes tagging what specifically mismatched on a voucher field.
// Never surfaced to the client — see architecture.md's hidden-answer-key invariant.
export const SCORING_ERROR_CODES = [
  'ACCOUNT_WRONG',
  'DR_CR_REVERSED',
  'AMOUNT_WRONG',
  'VOUCHER_TYPE_WRONG',
  'GST_HEAD_WRONG',
  'GST_RATE_WRONG',
  'GST_MISSING',
  'GST_UNEXPECTED',
  'TDS_SECTION_WRONG',
  'TDS_RATE_WRONG',
  'TDS_BASE_WRONG',
  'TDS_MISSING',
  'TDS_UNEXPECTED',
  'BILL_REFERENCE_WRONG',
  'BILL_REFERENCE_MISSING',
  'NARRATION_MISSING',
  'NARRATION_WEAK',
  'VOUCHER_MISSING',
] as const;
export type ScoringErrorCode = (typeof SCORING_ERROR_CODES)[number];

// Phase 3 (spec 15): alignment with the build spec's Appendix A taxonomy,
// quoted verbatim from the manager's document — "Accounting: E01 wrong
// account classification; E02 Dr/Cr direction wrong; E03 GST intra vs inter
// wrong; E04 GST rate wrong; E05 GST head omitted (CGST/SGST split missed);
// E06 TDS section wrong; E07 TDS rate wrong; E08 TDS threshold ignored
// (deducted below or missed above); E09 narration weak; E10 bill-by-bill
// Against Ref missing; E11 amount/rounding error; E12 voucher type wrong;
// E13 period recognition wrong (accrual/prepaid missed); E14 ITC
// eligibility wrong; E15 parent group wrong at ledger creation" plus
// R01-R05 (reconciliation), O01-O03 (opening balance), C (communication).
//
// Internal codes stay the storage vocabulary (stored results, adjudication,
// and the coaching signal all speak them); this mapping is the documented
// bridge to the spec's codes. null = engine-specific, finer-grained than
// the spec's set (TDS base-not-gross has no Appendix A code; GST charged
// where none applies has none; a wholly missing voucher has none).
export const SPEC_CODE_BY_ERROR_CODE: Record<ScoringErrorCode, string | null> = {
  ACCOUNT_WRONG: 'E01',
  DR_CR_REVERSED: 'E02',
  AMOUNT_WRONG: 'E11',
  VOUCHER_TYPE_WRONG: 'E12',
  GST_HEAD_WRONG: 'E03',
  GST_RATE_WRONG: 'E04',
  GST_MISSING: 'E05',
  GST_UNEXPECTED: null,
  TDS_SECTION_WRONG: 'E06',
  TDS_RATE_WRONG: 'E07',
  TDS_BASE_WRONG: null,
  // E08 is "TDS threshold ignored (deducted below or missed above)" — the
  // engine detects the OUTCOME (TDS absent where expected / present where
  // not), not the threshold reasoning behind it, but the outcome codes are
  // exactly E08's two halves.
  TDS_MISSING: 'E08',
  TDS_UNEXPECTED: 'E08',
  BILL_REFERENCE_WRONG: 'E10',
  BILL_REFERENCE_MISSING: 'E10',
  NARRATION_MISSING: 'E09',
  NARRATION_WEAK: 'E09',
  VOUCHER_MISSING: null,
};

// Appendix A codes with NO deterministic detector, documented rather than
// pretended (spec 15's explicit instruction): E13 period recognition
// (prepaid/accrual mistakes surface as ACCOUNT_WRONG or VOUCHER_MISSING
// against the key's month-end adjustment JVs, never as their own code),
// E14 ITC eligibility (the answer-key model carries no blocked-credit
// data), E15 parent group at ledger creation (the Day Book XML carries no
// group hierarchy), R01-R05 reconciliation-judgement and O01-O03
// opening-balance codes (their outcomes fold into account, bill-reference,
// and TB tie-out diffs), and the C communication codes (the qualitative
// scorer's domain, not this engine's).
export const SPEC_CODES_WITHOUT_DETECTOR = [
  'E13',
  'E14',
  'E15',
  'R01',
  'R02',
  'R03',
  'R04',
  'R05',
  'O01',
  'O02',
  'O03',
] as const;

export const SCORED_FIELDS = [
  'account',
  'dr_cr',
  'amount',
  'voucher_type',
  'gst',
  'tds',
  'bill_reference',
  'narration',
] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

// expected_masked is always true, never the literal expected value — this field
// exists so the client can render "this was wrong" without the schema shape ever
// carrying a value that could leak the answer key.
// vacuously_correct marks a diff that is correct only because the exercise
// never required this field at all (e.g. no GST applies and the learner
// posted none). It still counts toward the weighted score exactly as before —
// a learner must not be penalized for a field the exercise didn't exercise —
// but it is not an achievement worth praising, so coaching filters these out
// of the "correctly handled" signal. Without this distinction the tutor
// congratulates learners for GST/TDS handling on exercises containing
// neither. Always false for an incorrect diff.
const VoucherDiffSchema = z.object({
  voucherRef: z.union([z.number().int().positive(), z.null()]),
  field: z.enum(SCORED_FIELDS),
  expected_masked: z.literal(true),
  is_correct: z.boolean(),
  vacuously_correct: z.boolean().optional(),
  error_code: z.enum(SCORING_ERROR_CODES).nullable(),
});
export type VoucherDiff = z.infer<typeof VoucherDiffSchema>;

export const OVERALL_RESULTS = ['pass', 'partial', 'fail'] as const;
export type OverallResult = (typeof OVERALL_RESULTS)[number];

export const ScoringResultSchema = z.object({
  per_voucher_diffs: z.array(VoucherDiffSchema),
  tb_tie_out: z.boolean(),
  weighted_score: z.number(),
  overall_result: z.enum(OVERALL_RESULTS),
  // Per-concept roll-up (Unit 09): whether every scored field belonging to a
  // transaction tagged with this concept was correct. Derived deterministically
  // in score-submission.ts from per_voucher_diffs + the answer key's
  // concept_tags — never judged by an LLM, same determinism boundary as the
  // rest of this file. This is the input concept_attempts logging reads.
  concept_results: z.array(
    z.object({
      concept_tag: z.enum(CONCEPT_TAGS),
      result: z.enum(['pass', 'fail']),
    }),
  ),
});
export type ScoringResult = z.infer<typeof ScoringResultSchema>;
export type ConceptResult = ScoringResult['concept_results'][number];

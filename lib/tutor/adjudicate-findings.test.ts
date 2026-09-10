import { describe, expect, it } from 'vitest';
import type { AnswerKey } from '@/lib/schemas/exercise';
import type { ScoringResult } from '@/lib/schemas/scoring';
import { applyAdjudicationVerdicts } from './adjudicate-findings';

// One transaction, two findings (account + gst wrong). The judge's verdicts
// must apply per (sequence, field) exactly, and the result must be rebuilt —
// score/overall/concepts all recomputed from the adjusted diffs.
function answerKey(): AnswerKey {
  return {
    entries: [
      {
        sequence: 1,
        correct_account: 'Purchases',
        dr_cr: 'Dr',
        amount: 100,
        voucher_type: 'Purchase',
        gst_head: 'IGST',
        gst_rate: 18,
        tds_section: null,
        tds_rate: null,
        tds_base: null,
        bill_reference: null,
        narration: null,
        concept_tags: ['purchase_voucher_basics'],
        requires_source_document: false,
        source_document_type: null,
      },
    ],
  };
}

function engineResult(): ScoringResult {
  return {
    per_voucher_diffs: [
      { voucherRef: 1, field: 'account', expected_masked: true, is_correct: false, error_code: 'ACCOUNT_WRONG' },
      { voucherRef: 1, field: 'gst', expected_masked: true, is_correct: false, error_code: 'GST_HEAD_WRONG' },
      { voucherRef: 1, field: 'amount', expected_masked: true, is_correct: true, error_code: null },
    ],
    tb_tie_out: true,
    weighted_score: 0.25,
    overall_result: 'fail',
    concept_results: [{ concept_tag: 'purchase_voucher_basics', result: 'fail' }],
  };
}

describe('applyAdjudicationVerdicts', () => {
  it('flips only explicitly-dismissed findings and rebuilds the result', () => {
    const adjusted = applyAdjudicationVerdicts(
      engineResult(),
      [
        { sequence: 1, field: 'account', verdict: 'dismiss', reason: 'alternate but valid ledger naming' },
        { sequence: 1, field: 'gst', verdict: 'uphold', reason: 'genuinely the wrong regime' },
      ],
      answerKey(),
    );

    const accountDiff = adjusted.per_voucher_diffs.find((d) => d.field === 'account');
    expect(accountDiff?.is_correct).toBe(true);
    expect(accountDiff?.error_code).toBeNull();

    const gstDiff = adjusted.per_voucher_diffs.find((d) => d.field === 'gst');
    expect(gstDiff?.is_correct).toBe(false);
    expect(gstDiff?.error_code).toBe('GST_HEAD_WRONG');

    // Rebuilt: account (1) + amount (1) earned of account 1 + gst 2 + amount 1.
    expect(adjusted.weighted_score).toBeCloseTo(2 / 4, 5);
  });

  it('a missing verdict leaves the engine finding standing (fail-safe)', () => {
    const adjusted = applyAdjudicationVerdicts(
      engineResult(),
      [{ sequence: 1, field: 'account', verdict: 'dismiss', reason: 'naming' }],
      answerKey(),
    );
    // gst had no verdict at all — must remain flagged.
    expect(adjusted.per_voucher_diffs.find((d) => d.field === 'gst')?.is_correct).toBe(false);
  });

  it('a dismiss on a GST finding is ignored: only naming and reference findings can be excused (2026-09-10)', () => {
    const adjusted = applyAdjudicationVerdicts(
      engineResult(),
      [
        { sequence: 1, field: 'account', verdict: 'dismiss', reason: 'naming' },
        { sequence: 1, field: 'gst', verdict: 'dismiss', reason: 'ledger order artifact' },
      ],
      answerKey(),
    );
    expect(adjusted.per_voucher_diffs.find((d) => d.field === 'account')?.is_correct).toBe(true);
    const gstDiff = adjusted.per_voucher_diffs.find((d) => d.field === 'gst');
    expect(gstDiff?.is_correct).toBe(false);
    expect(gstDiff?.error_code).toBe('GST_HEAD_WRONG');
    // account (1) + amount (1) earned of account 1 + gst 2 + amount 1.
    expect(adjusted.weighted_score).toBeCloseTo(2 / 4, 5);
    // The purchase concept owns account/side/amount/type, all correct after the
    // naming dismissal; the GST finding belongs to gst_classification.
    expect(adjusted.concept_results.find((c) => c.concept_tag === 'purchase_voucher_basics')?.result).toBe('pass');
  });

  it('never excuses a missing voucher', () => {
    const missing: ScoringResult = {
      ...engineResult(),
      per_voucher_diffs: [
        { voucherRef: 1, field: 'account', expected_masked: true, is_correct: false, error_code: 'VOUCHER_MISSING' },
      ],
    };
    const adjusted = applyAdjudicationVerdicts(
      missing,
      [{ sequence: 1, field: 'account', verdict: 'dismiss', reason: 'posted differently' }],
      answerKey(),
    );
    expect(adjusted.per_voucher_diffs[0].is_correct).toBe(false);
    expect(adjusted.per_voucher_diffs[0].error_code).toBe('VOUCHER_MISSING');
  });

  it('carries the submission-level facts through the rebuild', () => {
    const withFacts: ScoringResult = {
      ...engineResult(),
      unmatched_vouchers: [{ position: 3, date: '20260405', voucher_type: 'Payment', ledgers: ['Suspense'], amount: 18000, kind: 'extra' }],
      ledger_findings: [{ code: 'GST_LEDGER_NO_SIDE', ledgers: ['CGST'] }],
      composite_matches: [{ kind: 'split', sequences: [1], positions: [1, 2] }],
    };
    const adjusted = applyAdjudicationVerdicts(
      withFacts,
      [{ sequence: 1, field: 'account', verdict: 'dismiss', reason: 'naming' }],
      answerKey(),
    );
    expect(adjusted.unmatched_vouchers).toEqual(withFacts.unmatched_vouchers);
    expect(adjusted.ledger_findings).toEqual(withFacts.ledger_findings);
    expect(adjusted.composite_matches).toEqual(withFacts.composite_matches);
    // The ledger finding costs one standard weight: account 1 + amount 1 earned of 1 + 2 + 1 + 1 penalty.
    expect(adjusted.weighted_score).toBeCloseTo(2 / 5, 5);
  });

  it('verdicts for the wrong sequence or field change nothing', () => {
    const adjusted = applyAdjudicationVerdicts(
      engineResult(),
      [
        { sequence: 2, field: 'account', verdict: 'dismiss', reason: 'wrong transaction' },
        { sequence: 1, field: 'narration', verdict: 'dismiss', reason: 'field was never flagged' },
      ],
      answerKey(),
    );
    // Rebuilt, so the derived fields are recomputed (which adds the tie-out
    // concept and an empty mismatch list), but no diff and no score moved.
    expect(adjusted.per_voucher_diffs).toEqual(engineResult().per_voucher_diffs);
    expect(adjusted.weighted_score).toBe(engineResult().weighted_score);
    expect(adjusted.tb_tie_out).toBe(engineResult().tb_tie_out);
    expect(adjusted.overall_result).toBe(engineResult().overall_result);
    expect(adjusted.concept_results.find((c) => c.concept_tag === 'purchase_voucher_basics')?.result).toBe('fail');
  });
});

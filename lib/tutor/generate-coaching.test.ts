import { describe, expect, it } from 'vitest';
import type { ScoringResult, VoucherDiff } from '@/lib/schemas/scoring';
import type { CoachingSignal } from '@/lib/llm/prompts/coaching';
import { buildCoachingSignal, buildSequenceLabels, checkFeedbackIdentifiers, checkOpeningLineFacts, composeFallbackOpeningLine, groupDescriptionsByField } from './generate-coaching';

function signalWith(overrides: Partial<CoachingSignal>): CoachingSignal {
  return {
    overallResult: 'fail',
    tbTieOut: true,
    weightedScorePercent: 40,
    incorrectConceptDescriptions: [],
    correctConceptDescriptions: [],
    qualitative: null,
    missingPartDescriptions: [],
    rectificationDescriptions: [],
    ...overrides,
  };
}

describe('sequence labels (pack-exercise specificity)', () => {
  it('names flagged areas by bill reference or distinctive party account', () => {
    const key = {
      entries: [
        {
          sequence: 13, correct_account: 'Coimbatore Interiors', dr_cr: 'Dr' as const, amount: 76700,
          voucher_type: 'Sales', gst_head: 'IGST' as const, gst_rate: 18, tds_section: null,
          tds_rate: null, tds_base: null, bill_reference: 'INV-012', narration: null,
          concept_tags: ['gst_classification' as const], requires_source_document: false, source_document_type: null,
        },
        {
          sequence: 65, correct_account: 'Advertisement & Marketing', dr_cr: 'Dr' as const, amount: 60000,
          voucher_type: 'Purchase', gst_head: 'CGST' as const, gst_rate: 18, tds_section: '194C',
          tds_rate: 2, tds_base: 60000, bill_reference: null, narration: null,
          concept_tags: ['tds_classification' as const], requires_source_document: false, source_document_type: null,
        },
      ],
    };
    const labels = buildSequenceLabels(key);
    // A bill ref alone is unfindable for a learner who never entered the
    // Against Ref (real intern report, 2026-08-31) — the party/voucher-type
    // rider makes the label locate the entry in their own books.
    expect(labels.get(13)).toBe('INV-012 (the Coimbatore Interiors sales)');
    expect(labels.get(65)).toBe('the Advertisement & Marketing purchase');

    const described = groupDescriptionsByField(
      [
        { voucherRef: 13, field: 'gst', expected_masked: true, is_correct: false, error_code: 'GST_HEAD_WRONG' },
        { voucherRef: 65, field: 'gst', expected_masked: true, is_correct: false, error_code: 'GST_HEAD_WRONG' },
      ],
      labels,
    );
    expect(described).toEqual([
      'the GST treatment (INV-012 (the Coimbatore Interiors sales) and the Advertisement & Marketing purchase)',
    ]);
  });
});

describe('checkOpeningLineFacts', () => {
  it('rejects a result line blaming the Trial Balance when tie-out matched', () => {
    // The exact live-observed hallucination: TB tied out, model blamed it anyway.
    expect(
      checkOpeningLineFacts('The submission failed due to mismatches in the Trial Balance tie-out.', signalWith({})),
    ).not.toBeNull();
  });

  it('accepts a Trial Balance mention when tie-out genuinely failed', () => {
    expect(
      checkOpeningLineFacts('Did not pass — the Trial Balance does not tie out.', signalWith({ tbTieOut: false })),
    ).toBeNull();
  });

  it('accepts a result line that does not mention the Trial Balance', () => {
    expect(checkOpeningLineFacts('Not a pass — several fields need another look.', signalWith({}))).toBeNull();
  });
});

describe('composeFallbackOpeningLine', () => {
  it('states each overall result plainly without inventing a cause', () => {
    expect(composeFallbackOpeningLine(signalWith({ overallResult: 'pass' }))).not.toMatch(/trial balance/i);
    expect(composeFallbackOpeningLine(signalWith({ overallResult: 'partial' }))).not.toMatch(/trial balance/i);
    expect(composeFallbackOpeningLine(signalWith({ overallResult: 'fail' }))).not.toMatch(/trial balance/i);
  });
});

function diff(field: VoucherDiff['field'], voucherRef: number | null): VoucherDiff {
  return {
    voucherRef,
    field,
    expected_masked: true,
    is_correct: false,
    error_code: null,
  };
}

describe('groupDescriptionsByField', () => {
  it('collapses the same field across several transactions into one description', () => {
    const result = groupDescriptionsByField([
      diff('account', 1),
      diff('account', 3),
      diff('account', 4),
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]).toBe('the ledger account classification (transactions 1, 3 and 4)');
  });

  it('names a single affected transaction in the singular', () => {
    const result = groupDescriptionsByField([diff('narration', 2)]);

    expect(result).toEqual(['the narration (transaction 2)']);
  });

  it('keeps distinct fields as separate descriptions', () => {
    const result = groupDescriptionsByField([
      diff('account', 1),
      diff('dr_cr', 1),
      diff('amount', 1),
    ]);

    expect(result).toHaveLength(3);
  });

  it('deduplicates a transaction repeated for the same field', () => {
    // A multi-leg voucher can produce two diffs for the same field and
    // sequence — the learner should not see "transactions 1 and 1".
    const result = groupDescriptionsByField([diff('account', 1), diff('account', 1)]);

    expect(result).toEqual(['the ledger account classification (transaction 1)']);
  });

  it('sorts transaction numbers regardless of diff order', () => {
    const result = groupDescriptionsByField([diff('amount', 4), diff('amount', 2)]);

    expect(result).toEqual(['the amount posted (transactions 2 and 4)']);
  });

  it('omits the transaction suffix when no voucher reference is available', () => {
    const result = groupDescriptionsByField([diff('voucher_type', null)]);

    expect(result).toEqual(['the voucher type used']);
  });

  it('returns nothing for an empty diff list', () => {
    expect(groupDescriptionsByField([])).toEqual([]);
  });
});

function scoringResultWith(diffs: VoucherDiff[]): ScoringResult {
  return {
    per_voucher_diffs: diffs,
    tb_tie_out: true,
    weighted_score: 0.8,
    overall_result: 'partial',
    concept_results: [],
  };
}

describe('buildCoachingSignal flagged-area accuracy (pilot 2026-08-31)', () => {
  it('excludes unassessed incorrect diffs (null error code) from the flagged areas', () => {
    // When a leg's account never matched, dr_cr and amount are emitted
    // incorrect with error_code null — they were never actually judged. The
    // live pilot feedback told the learner to "reconsider the debit and
    // credit direction" on INV-010, whose direction was textbook-correct.
    const signal = buildCoachingSignal(
      scoringResultWith([
        { voucherRef: 10, field: 'account', expected_masked: true, is_correct: false, error_code: 'ACCOUNT_WRONG' },
        { voucherRef: 10, field: 'dr_cr', expected_masked: true, is_correct: false, error_code: null },
        { voucherRef: 10, field: 'amount', expected_masked: true, is_correct: false, error_code: null },
      ]),
    );

    expect(signal.incorrectConceptDescriptions).toHaveLength(1);
    expect(signal.incorrectConceptDescriptions[0]).toMatch(/ledger account classification/);
    expect(signal.incorrectConceptDescriptions.join(' ')).not.toMatch(/direction|amount/i);
  });

  it('still flags a genuinely-assessed wrong direction', () => {
    const signal = buildCoachingSignal(
      scoringResultWith([
        { voucherRef: 3, field: 'dr_cr', expected_masked: true, is_correct: false, error_code: 'DR_CR_REVERSED' },
      ]),
    );

    expect(signal.incorrectConceptDescriptions).toEqual(['the Debit/Credit direction (transaction 3)']);
  });

  it('reports a missing voucher as its own not-recorded area, not an account-classification problem', () => {
    // VOUCHER_MISSING lives on the account field; without the split, an
    // entry the learner never posted read as "revisit the ledger account
    // classification for AI-201" instead of saying it was never entered.
    const key = {
      entries: [
        {
          sequence: 21, correct_account: 'Ahmedabad Import', dr_cr: 'Cr' as const, amount: 106200,
          voucher_type: 'Purchase', gst_head: 'IGST' as const, gst_rate: 18, tds_section: null,
          tds_rate: null, tds_base: null, bill_reference: 'AI-201', narration: null,
          concept_tags: ['gst_classification' as const], requires_source_document: false, source_document_type: null,
        },
      ],
    };
    const signal = buildCoachingSignal(
      scoringResultWith([
        { voucherRef: 21, field: 'account', expected_masked: true, is_correct: false, error_code: 'VOUCHER_MISSING' },
      ]),
      key,
    );

    expect(signal.incorrectConceptDescriptions).toHaveLength(1);
    expect(signal.incorrectConceptDescriptions[0]).toMatch(/not to have been recorded/);
    expect(signal.incorrectConceptDescriptions[0]).toContain('AI-201');
    expect(signal.incorrectConceptDescriptions[0]).not.toMatch(/ledger account classification/);
  });
});

describe('guardrails (2026-09-01: identifier echo, praise/flag exclusivity, label collisions)', () => {
  it('checkFeedbackIdentifiers catches a mistyped identifier (the live DW-115 slip)', () => {
    const signal = signalWith({
      incorrectConceptDescriptions: ['the ledger account classification (DT-115 (the Office Equipment purchase))'],
    });
    const issue = checkFeedbackIdentifiers(
      { went_well: [], needs_work: ['Take another look at DW-115, the Office Equipment purchase.'] },
      signal,
    );
    expect(issue).toContain('DW-115');
  });

  it('checkFeedbackIdentifiers passes when identifiers are copied exactly', () => {
    const signal = signalWith({
      incorrectConceptDescriptions: ['the GST treatment (INV-016 and CA26-101)'],
      correctConceptDescriptions: ['the Debit/Credit direction (INV-M-101)'],
    });
    const issue = checkFeedbackIdentifiers(
      {
        went_well: ['Your direction on INV-M-101 was precise.'],
        needs_work: ['Review the GST on INV-016 and CA26-101.'],
      },
      signal,
    );
    expect(issue).toBeNull();
  });

  it('checkFeedbackIdentifiers ignores plain prose without identifier tokens', () => {
    const issue = checkFeedbackIdentifiers(
      { went_well: ['Solid voucher-type choices throughout.'], needs_work: ['Revisit the narrations.'] },
      signalWith({}),
    );
    expect(issue).toBeNull();
  });

  it('buildCoachingSignal drops a partially-wrong transaction from the praise side', () => {
    const signal = buildCoachingSignal(
      scoringResultWith([
        { voucherRef: 5, field: 'account', expected_masked: true, is_correct: false, error_code: 'ACCOUNT_WRONG' },
        { voucherRef: 5, field: 'dr_cr', expected_masked: true, is_correct: true, error_code: null },
        { voucherRef: 9, field: 'dr_cr', expected_masked: true, is_correct: true, error_code: null },
      ]),
    );
    // Transaction 5 is flagged, so its correct dr_cr must not be praised;
    // fully-clean transaction 9 still is.
    expect(signal.correctConceptDescriptions).toEqual(['the Debit/Credit direction (transaction 9)']);
  });

  it('buildSequenceLabels disambiguates colliding labels with the amount', () => {
    const leg = (sequence: number, amount: number) => ({
      sequence, correct_account: 'Bank Charges', dr_cr: 'Dr' as const, amount,
      voucher_type: 'Payment', gst_head: null, gst_rate: null, tds_section: null,
      tds_rate: null, tds_base: null, bill_reference: null, narration: null,
      concept_tags: ['payment_voucher_basics' as const], requires_source_document: false,
      source_document_type: null,
    });
    const labels = buildSequenceLabels({ entries: [leg(46, 350), leg(78, 850)] });
    expect(labels.get(46)).toBe('the Bank Charges payment of Rs. 350');
    expect(labels.get(78)).toBe('the Bank Charges payment of Rs. 850');
  });
});

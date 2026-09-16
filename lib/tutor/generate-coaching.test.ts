import { describe, expect, it, vi } from 'vitest';
import type { ScoringResult, VoucherDiff } from '@/lib/schemas/scoring';
import type { CoachingFact, CoachingSignal } from '@/lib/llm/prompts/coaching';
import type { CoachingModelOutput } from '@/lib/schemas/coaching';
import type { CorrectionDecision } from '@/lib/tutor/correction-round';
import {
  buildCoachingFacts,
  buildCoachingSignal,
  buildSequenceLabels,
  checkGrounding,
  checkOpeningLineFacts,
  composeFallbackCoaching,
  composeFallbackOpeningLine,
  composeNextNote,
  generateCoaching,
  groupDescriptionsByField,
} from './generate-coaching';

function signalWith(overrides: Partial<CoachingSignal>): CoachingSignal {
  return {
    overallResult: 'fail',
    tbTieOut: true,
    incorrectConceptDescriptions: [],
    correctConceptDescriptions: [],
    qualitative: null,
    missingPartDescriptions: [],
    rectifications: [],
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
      checkOpeningLineFacts('The Trial Balance does not tie out yet, so that is where to start.', signalWith({ tbTieOut: false })),
    ).toBeNull();
  });

  it('accepts a result line that does not mention the Trial Balance', () => {
    expect(checkOpeningLineFacts('Several fields need another look before this month is settled.', signalWith({}))).toBeNull();
  });

  // 2026-09-16: learners are never shown a number or a verdict for a batch.
  it.each([
    'Your submission came in at 63 percent. A solid first pass.',
    'You scored well on the sales entries this month.',
    'This came out at 41 out of 60 on the checks that matter.',
  ])('rejects score language: %s', (line) => {
    expect(checkOpeningLineFacts(line, signalWith({}))).not.toBeNull();
  });

  it.each([
    'A partial result: some entries are right.',
    'This submission passes.',
    'This one did not pass yet.',
    'Not a pass, but close.',
    'The GST treatment failed across the board.',
  ])('rejects verdict language: %s', (line) => {
    expect(checkOpeningLineFacts(line, signalWith({}))).not.toBeNull();
  });

  // "Pass an entry" is ordinary Indian accounting usage and must survive, or
  // clean feedback would be thrown away and replaced by the fallback line.
  it('accepts passing an entry, which is bookkeeping vocabulary and not a verdict', () => {
    expect(
      checkOpeningLineFacts('You passed the sales entries cleanly and tied the bills to the right invoices.', signalWith({})),
    ).toBeNull();
  });
});

describe('composeFallbackOpeningLine', () => {
  it('states each overall result plainly without inventing a cause', () => {
    expect(composeFallbackOpeningLine(signalWith({ overallResult: 'pass' }))).not.toMatch(/trial balance/i);
    expect(composeFallbackOpeningLine(signalWith({ overallResult: 'partial' }))).not.toMatch(/trial balance/i);
    expect(composeFallbackOpeningLine(signalWith({ overallResult: 'fail' }))).not.toMatch(/trial balance/i);
  });

  // This line is what REPLACES one that failed the guard, so it has to pass
  // the guard itself. Otherwise the fallback reintroduces exactly the score
  // or verdict wording the guard just rejected.
  it.each(['pass', 'partial', 'fail'] as const)('survives its own guard for %s', (overallResult) => {
    const signal = signalWith({ overallResult });
    expect(checkOpeningLineFacts(composeFallbackOpeningLine(signal), signal)).toBeNull();
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

describe('guardrails (2026-09-01: praise/flag exclusivity, label collisions)', () => {
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

  // Template595 (2026-09-16): "Bill-by-bill referencing was handled
  // correctly" sat directly above three flagged bill references.
  it('buildCoachingSignal praises a field only when no diff of that field was flagged', () => {
    const signal = buildCoachingSignal(
      scoringResultWith([
        { voucherRef: 5, field: 'bill_reference', expected_masked: true, is_correct: false, error_code: 'BILL_REFERENCE_WRONG' },
        { voucherRef: 9, field: 'bill_reference', expected_masked: true, is_correct: true, error_code: null },
        { voucherRef: 9, field: 'voucher_type', expected_masked: true, is_correct: true, error_code: null },
      ]),
    );
    expect(signal.correctConceptDescriptions.join(' ')).not.toMatch(/bill-by-bill/);
    expect(signal.correctConceptDescriptions).toEqual(['the voucher type used (transaction 9)']);
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

// Grounded coaching (2026-09-16): a closed fact list, a citation contract
// checked in code, retries with the violations, and a fallback that never
// drops a finding. Template595's first review invented history, reversed a
// Sales gap and closed with "nothing more to send" during a correction round.

const FACTS: CoachingFact[] = [
  { id: 'P1', kind: 'praise', text: 'the voucher type used (INV-M-101 (the Karnataka Emporium receipt)) was handled correctly' },
  { id: 'I1', kind: 'issue', text: 'the GST treatment (INV-012 (the Coimbatore Interiors sales)) needs another look' },
  { id: 'T1', kind: 'tieout', text: "Sales shows Rs 15,000 more on the credit side in the Trial Balance than this month's correct postings" },
];

function bullet(text: string, factIds: string[]) {
  return { text, fact_ids: factIds };
}

const GROUNDED: CoachingModelOutput = {
  opening_line: 'The month is mostly in shape, and the GST heads are the place to look.',
  went_well: [bullet('Voucher types were right, including on INV-M-101.', ['P1'])],
  needs_work: [
    bullet('Take another look at the GST on INV-012. The head follows the place of supply.', ['I1']),
    bullet('Sales shows Rs 15,000 more on the credit side than the correct postings for the month.', ['T1']),
  ],
};

describe('checkGrounding', () => {
  const context = { tbTieOut: false };

  it('accepts output where every bullet is grounded in the facts it cites', () => {
    expect(checkGrounding(GROUNDED, FACTS, context)).toEqual([]);
  });

  it('accepts Indian digit grouping written without commas', () => {
    const output = { ...GROUNDED, needs_work: [GROUNDED.needs_work[0], bullet('Sales is Rs 15000 heavier on the credit side.', ['T1'])] };
    expect(checkGrounding(output, FACTS, context)).toEqual([]);
  });

  it('rejects a fabricated identifier (the live DW-115 slip)', () => {
    const output = { ...GROUNDED, needs_work: [bullet('Take another look at the GST on INV-021.', ['I1']), GROUNDED.needs_work[1]] };
    expect(checkGrounding(output, FACTS, context).join(' ')).toContain('INV-021');
  });

  it('rejects an identifier that exists but is not in the cited facts', () => {
    const output = { ...GROUNDED, needs_work: [bullet('Take another look at the GST on INV-M-101.', ['I1']), GROUNDED.needs_work[1]] };
    expect(checkGrounding(output, FACTS, context).join(' ')).toContain('INV-M-101');
  });

  it('rejects a fabricated amount', () => {
    const output = { ...GROUNDED, needs_work: [GROUNDED.needs_work[0], bullet('Sales is off by Rs 50,000 on the credit side.', ['T1'])] };
    expect(checkGrounding(output, FACTS, context).join(' ')).toContain('50000');
  });

  it('rejects a history claim with no fixed or still fact behind it', () => {
    const output = {
      ...GROUNDED,
      needs_work: [bullet('The GST gap on INV-012 is still recurring from an earlier round.', ['I1']), GROUNDED.needs_work[1]],
    };
    expect(checkGrounding(output, FACTS, context).join(' ')).toMatch(/claims history/);
  });

  it('rejects a history word in the opening line when no fixed or still fact exists', () => {
    const output = { ...GROUNDED, opening_line: 'The same GST gap shows up again this month.' };
    expect(checkGrounding(output, FACTS, context).join(' ')).toMatch(/opening_line uses "shows up again"/);
  });

  // Every form the invented history took on Template595's first review.
  it.each([
    'This is the same classification gap flagged in an earlier round, still recurring.',
    'This is part of the same journal basics that showed up as a gap before too.',
    'The next round should zero in on these, since all three have now shown up two rounds running.',
    'The GST head is wrong again, same as last time.',
    'It failed again on INV-012.',
    'This was flagged previously.',
    'The GST gap is no longer a one-off.',
  ])('rejects the history claim "%s"', (text) => {
    const output = { ...GROUNDED, needs_work: [bullet(text, ['I1']), GROUNDED.needs_work[1]] };
    expect(checkGrounding(output, FACTS, context).join(' ')).toMatch(/claims history/);
  });

  describe('figures merged across ledger facts', () => {
    const ledgerFacts: CoachingFact[] = [
      { id: 'I1', kind: 'issue', text: 'the GST treatment (INV-012 (the Coimbatore Interiors sales)) needs another look' },
      { id: 'T1', kind: 'tieout', text: "Sales shows Rs 15,000 more on the debit side in the Trial Balance than this month's correct postings" },
      { id: 'T2', kind: 'tieout', text: "Purchases shows Rs 8,000 more on the credit side in the Trial Balance than this month's correct postings" },
      { id: 'T3', kind: 'tieout', text: 'Sales Returns does not appear in the Trial Balance export at all (it should have moved by Rs 12,000 this month)' },
    ];
    const withBullet = (text: string, ids: string[]): CoachingModelOutput => ({
      opening_line: 'A few ledgers need a look.',
      went_well: [],
      needs_work: [bullet('Take another look at the GST on INV-012.', ['I1']), bullet(text, ids)],
    });

    it('rejects figures swapped between two merged ledgers (review finding)', () => {
      const output = withBullet('Sales is off by Rs 8,000 and Purchases by Rs 15,000.', ['T1', 'T2', 'T3']);
      expect(checkGrounding(output, ledgerFacts, { tbTieOut: false }).join(' ')).toMatch(/wrong ledger/);
    });

    it('does not let Sales lend its figure to Sales Returns', () => {
      const output = withBullet(
        'Sales shows Rs 15,000 more on the debit side; Purchases shows Rs 8,000 more on the credit side; Sales Returns should have moved by Rs 15,000.',
        ['T1', 'T2', 'T3'],
      );
      expect(checkGrounding(output, ledgerFacts, { tbTieOut: false }).join(' ')).toMatch(/wrong ledger/);
    });

    it('accepts correctly merged ledgers', () => {
      const output = withBullet(
        'Sales shows Rs 15,000 more on the debit side, and Purchases shows Rs 8,000 more on the credit side, while Sales Returns does not appear though it should have moved by Rs 12,000.',
        ['T1', 'T2', 'T3'],
      );
      expect(checkGrounding(output, ledgerFacts, { tbTieOut: false })).toEqual([]);
    });
  });

  // Ordinary coaching the bare-word rule used to reject (live replay: two of
  // three attempts retried over "look again" and "before").
  it.each([
    'On INV-012, look again at which GST head applies.',
    'Check the place of supply before posting the GST on INV-012.',
    'The GST on INV-012 still needs a closer look.',
    'Take another look at the GST on INV-012: the same issue can sit on more than one line.',
  ])('accepts the ordinary phrasing "%s"', (text) => {
    const output = { ...GROUNDED, needs_work: [bullet(text, ['I1']), GROUNDED.needs_work[1]] };
    expect(checkGrounding(output, FACTS, context)).toEqual([]);
  });

  it('allows history in a bullet that cites a still-failing fact', () => {
    const facts: CoachingFact[] = [
      ...FACTS,
      { id: 'S1', kind: 'still', text: 'GST classification was failing in the previous round of this batch and is still failing now' },
    ];
    const output = {
      ...GROUNDED,
      needs_work: [...GROUNDED.needs_work, bullet('GST classification is still slipping, as in the previous round.', ['S1'])],
    };
    expect(checkGrounding(output, facts, context)).toEqual([]);
  });

  it('rejects an issue fact that no bullet cites', () => {
    const output = { ...GROUNDED, needs_work: [GROUNDED.needs_work[0]] };
    expect(checkGrounding(output, FACTS, context).join(' ')).toMatch(/not cited by any needs_work bullet: T1/);
  });

  it('rejects went_well citing an issue fact, and a bullet with no or unknown ids', () => {
    const output = {
      ...GROUNDED,
      went_well: [bullet('The GST on INV-012 was good.', ['I1']), bullet('Nice work overall.', []), bullet('Great ledgers.', ['P9'])],
    };
    const violations = checkGrounding(output, FACTS, context).join(' ');
    expect(violations).toMatch(/went_well may cite only P and F facts/);
    expect(violations).toMatch(/cites no fact ids/);
    expect(violations).toMatch(/"P9", which is not a listed fact/);
  });

  it('rejects an em dash in a bullet or the opening line', () => {
    const output = {
      ...GROUNDED,
      opening_line: 'A solid month — mostly.',
      went_well: [bullet('Voucher types were right — every one.', ['P1'])],
    };
    const violations = checkGrounding(output, FACTS, context);
    expect(violations.filter((violation) => /em dash/.test(violation))).toHaveLength(2);
  });

  it('rejects numbers and identifiers in the opening line, and keeps the verdict rules', () => {
    expect(checkGrounding({ ...GROUNDED, opening_line: 'Look at INV-012 first.' }, FACTS, context).join(' ')).toMatch(
      /number or an identifier/,
    );
    expect(checkGrounding({ ...GROUNDED, opening_line: 'A partial result this month.' }, FACTS, context).join(' ')).toMatch(
      /verdict word/,
    );
  });
});

describe('buildCoachingFacts', () => {
  it('numbers facts per kind and keeps rectification history only on F and S facts', () => {
    const facts = buildCoachingFacts(
      signalWith({
        tbTieOut: false,
        correctConceptDescriptions: ['the narration (transaction 2)'],
        incorrectConceptDescriptions: ['the GST treatment (transaction 3)', 'the amount posted (transaction 4)'],
        tbMismatchDescriptions: ["Sales shows Rs 15,000 more on the credit side in the Trial Balance than this month's correct postings"],
        rectifications: [
          { classification: 'FIXED', text: 'TDS classification was failing in the last batch that tested it and is fixed now' },
        ],
        missingPartDescriptions: ['your explanation never arrived before the review window closed, so this was scored on the parts that did.'],
      }),
    );
    expect(facts.map((fact) => fact.id)).toEqual(['P1', 'F1', 'I1', 'I2', 'T1', 'M1']);
  });

  it('frames a books gap as possible earlier-month drift only after the first month', () => {
    const books = { clean: false, descriptions: ['Sales closes with Rs 15,000 more on the credit side than the correct books, year to date'] };
    const first = buildCoachingFacts(signalWith({ booksReconciliation: books, batchOrdinal: 0 }));
    const later = buildCoachingFacts(signalWith({ booksReconciliation: books, batchOrdinal: 3 }));
    expect(first[0].text).not.toMatch(/earlier/);
    expect(later[0].text).toMatch(/earlier months/);
  });
});

function fakeScoring(): ScoringResult {
  return {
    per_voucher_diffs: [
      { voucherRef: 3, field: 'gst', expected_masked: true, is_correct: false, error_code: 'GST_HEAD_WRONG' },
      { voucherRef: 4, field: 'voucher_type', expected_masked: true, is_correct: true, error_code: null },
    ],
    tb_tie_out: false,
    tb_tie_out_mismatches: [{ account: 'Sales', status: 'off', difference: -15000 }],
    unmatched_vouchers: [{ position: 7, date: '20250412', voucher_type: 'Payment', ledgers: ['Suspense'], amount: 18000, kind: 'extra' }],
    ledger_findings: [{ code: 'SECOND_BANK_LEDGER', ledgers: ['HDFC BANK', 'HDFC 123'] }],
    books_reconciliation: [{ account: 'Sundry Debtors', status: 'off', difference: 2500 }],
    weighted_score: 0.6,
    overall_result: 'partial',
    concept_results: [{ concept_tag: 'gst_classification', result: 'fail' }],
  };
}

const OPEN_ROUND: CorrectionDecision = {
  kind: 'open',
  round: 1,
  focusConceptTag: 'gst_classification',
  failingConceptTags: ['gst_classification'],
};

const HALLUCINATION = {
  opening_line: 'The same gaps are recurring again this month.',
  went_well: [{ text: 'Your GST was spot on.', fact_ids: ['I1'] }],
  needs_work: [{ text: 'The Deccan Traders gap of Rs 50,000 is still there from last batch.', fact_ids: ['I1'] }],
};

describe('generateCoaching (grounded loop, injected completion)', () => {
  it('falls back to the facts after three ungrounded outputs, keeping every finding', async () => {
    const complete = vi.fn().mockResolvedValue(HALLUCINATION);
    const recordViolations = vi.fn();
    const coaching = await generateCoaching(
      'learner-1',
      { overallResult: 'partial', scoringResult: fakeScoring(), qualitative: null, rectifications: [], batchOrdinal: 0, nextStep: OPEN_ROUND },
      { complete, recordViolations },
    );

    expect(complete).toHaveBeenCalledTimes(3);
    expect(recordViolations).toHaveBeenCalledTimes(3);
    expect(recordViolations.mock.calls[2][0]).toMatchObject({ attempt: 3, usedFallback: true });
    // The retry prompts carry the violations back to the model.
    const retryMessages = complete.mock.calls[1][0].messages as { content: string }[];
    expect(retryMessages[retryMessages.length - 1].content).toMatch(/rejected by the fact checker/);

    const needsWork = coaching.needs_work.join(' | ');
    expect(coaching.needs_work).toHaveLength(5);
    expect(needsWork).toContain('GST treatment');
    expect(needsWork).toContain('Payment voucher no. 7');
    expect(needsWork).toMatch(/more than one bank ledger/i);
    expect(needsWork).toContain('Sales shows Rs 15,000 more on the credit side');
    expect(needsWork).toContain('Sundry Debtors closes with Rs 2,500 more on the debit side');
    expect(needsWork).not.toMatch(/earlier months/);
    expect(coaching.went_well).toEqual(['The voucher type used (transaction 4) was handled correctly.']);
    expect(JSON.stringify(coaching)).not.toMatch(/Deccan|recurring|50,000/);
    expect(Object.keys(coaching).sort()).toEqual(['needs_work', 'next_note', 'opening_line', 'went_well']);
  });

  it('uses the second output when the first is rejected and the second is grounded', async () => {
    const grounded = {
      opening_line: 'Most of the month is in place, with a few areas to check below.',
      went_well: [{ text: 'Voucher types were right on transaction 4.', fact_ids: ['P1'] }],
      needs_work: [
        { text: 'Take another look at the GST on transaction 3.', fact_ids: ['I1'] },
        { text: 'Check Payment voucher no. 7 dated 12-04-2025 for Rs 18,000 on Suspense.', fact_ids: ['U1'] },
        { text: 'Two bank ledgers are in use, HDFC BANK and HDFC 123. Keep one.', fact_ids: ['L1'] },
        { text: 'Sales shows Rs 15,000 more on the credit side than the month should.', fact_ids: ['T1'] },
        { text: 'Sundry Debtors closes Rs 2,500 heavier on the debit side than the correct books.', fact_ids: ['B1'] },
      ],
    };
    const complete = vi.fn().mockResolvedValueOnce(HALLUCINATION).mockResolvedValueOnce(grounded);
    const coaching = await generateCoaching(
      'learner-1',
      { overallResult: 'partial', scoringResult: fakeScoring(), qualitative: null, nextStep: OPEN_ROUND },
      { complete, recordViolations: vi.fn() },
    );

    expect(complete).toHaveBeenCalledTimes(2);
    expect(complete.mock.calls[0][0].temperature).toBe(0.2);
    expect(coaching).toEqual({
      opening_line: grounded.opening_line,
      went_well: ['Voucher types were right on transaction 4.'],
      needs_work: grounded.needs_work.map((item) => item.text),
      next_note: composeNextNote({ nextStep: OPEN_ROUND, missingPartDescriptions: [], hasFindings: true }),
    });
  });

  it('treats malformed JSON as a failed attempt instead of throwing', async () => {
    const complete = vi.fn().mockRejectedValue(new SyntaxError('Unexpected token < in JSON'));
    const recordViolations = vi.fn();
    const coaching = await generateCoaching(
      'learner-1',
      { overallResult: 'partial', scoringResult: fakeScoring(), qualitative: null, nextStep: OPEN_ROUND },
      { complete, recordViolations },
    );
    expect(complete).toHaveBeenCalledTimes(3);
    expect(recordViolations.mock.calls[0][0].violations.join(' ')).toMatch(/not valid JSON/);
    expect(coaching.needs_work).toHaveLength(5);
  });

  it('still throws on a network failure so Inngest retries the step', async () => {
    const complete = vi.fn().mockRejectedValue(new Error('OpenRouter request failed (503)'));
    await expect(
      generateCoaching(
        'learner-1',
        { overallResult: 'partial', scoringResult: fakeScoring(), qualitative: null, nextStep: OPEN_ROUND },
        { complete, recordViolations: vi.fn() },
      ),
    ).rejects.toThrow(/503/);
  });

  it('the fallback passes its own grounding check', () => {
    const signal = buildCoachingSignal(fakeScoring());
    const facts = buildCoachingFacts({
      ...signal,
      batchOrdinal: 2,
      rectifications: [
        { classification: 'STILL_FAILING', text: 'GST classification was failing in the previous round of this batch and is still failing now' },
      ],
    });
    const fallback = composeFallbackCoaching(facts, signal);
    const praiseFacts = facts.filter((fact) => fact.kind === 'praise' || fact.kind === 'fixed');
    const issueFacts = facts.filter((fact) => fact.kind !== 'praise' && fact.kind !== 'fixed');
    const cited: CoachingModelOutput = {
      opening_line: fallback.opening_line,
      went_well: praiseFacts.map((fact, index) => bullet(fallback.went_well[index], [fact.id])),
      needs_work: issueFacts.map((fact, index) => bullet(fallback.needs_work[index], [fact.id])),
    };
    expect(checkGrounding(cited, facts, { tbTieOut: signal.tbTieOut })).toEqual([]);
  });
});

describe('composeNextNote', () => {
  it('points at the correction when a round opens, without repeating the send instruction that follows it', () => {
    const note = composeNextNote({ nextStep: OPEN_ROUND, missingPartDescriptions: [], hasFindings: true });
    expect(note).toMatch(/Fix these points in Tally/);
    expect(note).not.toMatch(/nothing more to send|Day Book and Trial Balance|—/);
  });

  it('moves on when the batch advances', () => {
    expect(
      composeNextNote({ nextStep: { kind: 'advance', reason: 'nothing-failing' }, missingPartDescriptions: [], hasFindings: false }),
    ).toBe('Nothing here needs fixing. What comes next follows below.');
    expect(
      composeNextNote({ nextStep: { kind: 'advance', reason: 'rounds-exhausted' }, missingPartDescriptions: [], hasFindings: true }),
    ).toMatch(/move on/);
  });

  it('states a missing part first', () => {
    const note = composeNextNote({
      nextStep: { kind: 'advance', reason: 'not-supported' },
      missingPartDescriptions: ['your explanation never arrived before the review window closed, so this was scored on the parts that did.'],
      hasFindings: true,
    });
    expect(note.startsWith('Your explanation never arrived')).toBe(true);
  });
});

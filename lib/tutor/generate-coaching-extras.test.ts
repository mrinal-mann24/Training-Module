import { describe, expect, it } from 'vitest';
import type { ScoringResult } from '@/lib/schemas/scoring';
import {
  buildCoachingSignal,
  describeBooksReconciliation,
  describeCompositeMatches,
  describeLedgerFindings,
  describeTieOutMismatches,
  describeUnmatchedVouchers,
} from './generate-coaching';

// 2026-09-10: extra vouchers, ledger set-up findings and accepted composite
// postings reach the coaching call as plain lines.

describe('describeUnmatchedVouchers', () => {
  it('names each voucher with its date, type, amount, ledgers and what it looks like', () => {
    const lines = describeUnmatchedVouchers([
      { position: 7, date: '20250412', voucher_type: 'Payment', ledgers: ['Suspense', 'HDFC Bank'], amount: 18000, kind: 'extra' },
      { position: 3, date: '20250401', voucher_type: 'Purchase', ledgers: [], amount: 0, kind: 'blank' },
    ]);
    expect(lines).toEqual([
      'Payment voucher no. 7 dated 12-04-2025, Rs 18,000, ledgers Suspense, HDFC Bank: a posting that matches nothing in this batch',
      'Purchase voucher no. 3 dated 01-04-2025: a blank voucher with no ledger lines',
    ]);
  });

  it('caps a flood of vouchers', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ position: i + 1, date: '20250401', voucher_type: 'Journal', ledgers: ['X'], amount: 1, kind: 'extra' as const }));
    const lines = describeUnmatchedVouchers(many);
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe('and 3 more voucher(s) matched nothing');
  });
});

describe('describeLedgerFindings and describeCompositeMatches', () => {
  it('states each finding once with the ledger names', () => {
    const lines = describeLedgerFindings([
      { code: 'GST_LEDGER_NO_SIDE', ledgers: ['CGST', 'IGST'] },
      { code: 'SECOND_BANK_LEDGER', ledgers: ['HDFC BANK', 'HDFC 123'] },
      { code: 'DUPLICATE_PARTY_LEDGER', ledgers: ['Karnataka Emporium', 'KAREMP'] },
    ]);
    expect(lines[0]).toContain('(CGST, IGST)');
    expect(lines[1]).toContain('(HDFC BANK, HDFC 123)');
    expect(lines[2]).toContain('(Karnataka Emporium, KAREMP)');
  });

  it('describes accepted composites as good news using the transaction labels', () => {
    const labels = new Map([[1, 'INV-012'], [2, 'Prepaid Software']]);
    expect(describeCompositeMatches([{ kind: 'split', sequences: [1], positions: [1, 2] }], labels)).toEqual([
      'INV-012 was posted as two vouchers whose combined ledger effect is right, and was accepted as such',
    ]);
    expect(describeCompositeMatches([{ kind: 'combined', sequences: [1, 2], positions: [1] }], labels)).toEqual([
      'INV-012 and Prepaid Software were posted as one combined voucher whose ledger effect is right, and were accepted as such',
    ]);
  });
});

describe('buildCoachingSignal carries the new facts', () => {
  it('fills the three description lists from the scoring result', () => {
    const scoringResult: ScoringResult = {
      per_voucher_diffs: [],
      tb_tie_out: true,
      tb_tie_out_mismatches: [],
      unmatched_vouchers: [{ position: 2, date: '20250405', voucher_type: 'Journal', ledgers: ['Suspense'], amount: 5000, kind: 'duplicate' }],
      ledger_findings: [{ code: 'SECOND_BANK_LEDGER', ledgers: ['HDFC BANK', 'HDFC 123'] }],
      composite_matches: [{ kind: 'split', sequences: [4], positions: [5, 6] }],
      weighted_score: 0.9,
      overall_result: 'pass',
      concept_results: [],
    };
    const signal = buildCoachingSignal(scoringResult);
    expect(signal.unmatchedVoucherDescriptions).toHaveLength(1);
    expect(signal.unmatchedVoucherDescriptions?.[0]).toContain('a duplicate of another voucher');
    expect(signal.ledgerFindingDescriptions?.[0]).toContain('more than one bank ledger');
    expect(signal.compositeDescriptions?.[0]).toContain('transaction 4 was posted as two vouchers');
  });
});

// 2026-09-16: the difference is Dr-positive. "Sales moved Rs 15,000 more"
// was written for a Sales ledger carrying LESS credit than it should
// (Template595); naming the side is correct for debit and credit ledgers.
describe('describeTieOutMismatches', () => {
  it('names the credit side for a negative difference on a credit ledger', () => {
    expect(describeTieOutMismatches([{ account: 'Sales', status: 'off', difference: -15000 }])).toEqual([
      "Sales shows Rs 15,000 more on the credit side in the Trial Balance than this month's correct postings",
    ]);
  });

  it('names the debit side for a positive difference', () => {
    expect(describeTieOutMismatches([{ account: 'Office Rent', status: 'off', difference: 720.34 }])).toEqual([
      "Office Rent shows Rs 720 more on the debit side in the Trial Balance than this month's correct postings",
    ]);
  });

  it('describes a ledger missing from the export and states the cap as its own line', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ account: `Ledger ${i + 1}`, status: 'off' as const, difference: 100 }));
    const lines = describeTieOutMismatches([{ account: 'Sales Returns', status: 'missing', difference: -5000 }, ...many]);
    expect(lines[0]).toBe('Sales Returns does not appear in the Trial Balance export at all (it should have moved by Rs 5,000 this month)');
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe('and 3 more ledger(s) in the Trial Balance are off');
  });
});

describe('describeBooksReconciliation', () => {
  it('names the side of a closing-balance gap in both directions', () => {
    expect(
      describeBooksReconciliation([
        { account: 'Sundry Debtors', status: 'off', difference: 2500 },
        { account: 'Sales', status: 'off', difference: -150000 },
      ]),
    ).toEqual([
      'Sundry Debtors closes with Rs 2,500 more on the debit side than the correct books, year to date',
      'Sales closes with Rs 1,50,000 more on the credit side than the correct books, year to date',
    ]);
  });

  it('describes a ledger missing from the export and caps with its own line', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ account: `Ledger ${i + 1}`, status: 'off' as const, difference: -10 }));
    const lines = describeBooksReconciliation([{ account: 'HDFC Bank', status: 'missing', difference: -150000 }, ...many]);
    expect(lines[0]).toBe('HDFC Bank has no ledger in the export although the correct books carry a balance of about Rs 1,50,000 on it');
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe('and 2 more ledger(s) differ');
  });
});

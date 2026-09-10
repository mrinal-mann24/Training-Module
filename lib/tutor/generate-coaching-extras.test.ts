import { describe, expect, it } from 'vitest';
import type { ScoringResult } from '@/lib/schemas/scoring';
import { buildCoachingSignal, describeCompositeMatches, describeLedgerFindings, describeUnmatchedVouchers } from './generate-coaching';

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

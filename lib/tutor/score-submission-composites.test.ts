import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { Voucher } from '@/lib/schemas/voucher';
import { scoreSubmission } from './score-submission';

// 2026-09-10: composite postings, extra vouchers, ledger set-up findings
// and the bank-reference narration check, all from the full-year audits.

type LegSpec = [account: string, side: 'Dr' | 'Cr', amount: number];

function leg(
  sequence: number,
  [account, side, amount]: LegSpec,
  overrides: Partial<AnswerKeyEntry> = {},
): AnswerKeyEntry {
  return {
    sequence,
    correct_account: account,
    dr_cr: side,
    amount,
    voucher_type: 'Purchase',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['purchase_voucher_basics'],
    requires_source_document: false,
    source_document_type: null,
    ...overrides,
  };
}

function voucher(type: string, date: string, legs: LegSpec[], narration = 'posted', refs: Record<string, string> = {}): Voucher {
  return {
    voucherType: type,
    date,
    narration,
    ledgerEntries: legs.map(([ledgerName, drOrCr, amount]) => ({
      ledgerName,
      amount,
      drOrCr,
      billAllocations: refs[ledgerName] ? [{ name: refs[ledgerName], amount }] : [],
    })),
  };
}

const emptyTrialBalance = { ledgers: [] };

describe('split postings: one transaction recorded as two vouchers (Yeshas, April 2024)', () => {
  // Professional fees 60,000 + GST 9%+9%, TDS 194J 10% at booking.
  const answerKey: AnswerKey = {
    entries: [
      leg(1, ['Legal & Professional Charges', 'Dr', 60000], { tds_section: '194J', tds_rate: 10, tds_base: 60000, bill_reference: 'MA-206' }),
      leg(1, ['Input CGST', 'Dr', 5400], { gst_head: 'CGST', gst_rate: 18 }),
      leg(1, ['Input SGST', 'Dr', 5400], { gst_head: 'SGST', gst_rate: 18 }),
      leg(1, ['Mehta & Associates', 'Cr', 64800], { bill_reference: 'MA-206' }),
      leg(1, ['TDS Payable — u/s 194J', 'Cr', 6000]),
    ],
  };

  it('accepts the purchase without TDS plus a separate TDS journal as the correct posting', () => {
    const dayBook = {
      vouchers: [
        voucher('Purchase', '20240412', [
          ['Legal & Professional Charges', 'Dr', 60000],
          ['Input CGST', 'Dr', 5400],
          ['Input SGST', 'Dr', 5400],
          ['Mehta & Associates', 'Cr', 70800],
        ], 'bill', { 'Mehta & Associates': 'MA-206' }),
        voucher('Journal', '20240412', [
          ['Mehta & Associates', 'Dr', 6000],
          ['TDS Payable — u/s 194J', 'Cr', 6000],
        ], 'tds', { 'Mehta & Associates': 'MA-206' }),
      ],
    };
    const result = scoreSubmission(dayBook, emptyTrialBalance, answerKey);
    expect(result.per_voucher_diffs.filter((d) => !d.is_correct)).toEqual([]);
    expect(result.composite_matches).toEqual([{ kind: 'split', sequences: [1], positions: [1, 2] }]);
    expect(result.unmatched_vouchers).toEqual([]);
  });

  it('still flags a genuinely missing TDS when no journal supplies it', () => {
    const dayBook = {
      vouchers: [
        voucher('Purchase', '20240412', [
          ['Legal & Professional Charges', 'Dr', 60000],
          ['Input CGST', 'Dr', 5400],
          ['Input SGST', 'Dr', 5400],
          ['Mehta & Associates', 'Cr', 70800],
        ], 'bill', { 'Mehta & Associates': 'MA-206' }),
      ],
    };
    const result = scoreSubmission(dayBook, emptyTrialBalance, answerKey);
    expect(result.per_voucher_diffs.some((d) => d.error_code === 'TDS_MISSING')).toBe(true);
    expect(result.composite_matches).toEqual([]);
  });
});

describe('combined postings: two transactions recorded as one voucher (Praveen, April 2024)', () => {
  const answerKey: AnswerKey = {
    entries: [
      leg(1, ['Software Subscription', 'Dr', 18000], { voucher_type: 'Payment', concept_tags: ['payment_voucher_basics'] }),
      leg(1, ['HDFC Bank — 1234', 'Cr', 18000], { voucher_type: 'Payment', concept_tags: ['payment_voucher_basics'] }),
      leg(2, ['Prepaid Software', 'Dr', 15000], { voucher_type: 'Journal', concept_tags: ['journal_voucher_basics'] }),
      leg(2, ['Software Subscription', 'Cr', 15000], { voucher_type: 'Journal', concept_tags: ['journal_voucher_basics'] }),
    ],
  };

  it('accepts one journal whose ledger effect equals the payment plus the prepaid transfer', () => {
    const dayBook = {
      vouchers: [
        voucher('Journal', '20240430', [
          ['Software Subscription', 'Dr', 3000],
          ['Prepaid Software', 'Dr', 15000],
          ['HDFC Bank — 1234', 'Cr', 18000],
        ]),
      ],
    };
    const result = scoreSubmission(dayBook, emptyTrialBalance, answerKey);
    expect(result.per_voucher_diffs.filter((d) => !d.is_correct)).toEqual([]);
    expect(result.composite_matches).toEqual([{ kind: 'combined', sequences: [1, 2], positions: [1] }]);
    expect(result.unmatched_vouchers).toEqual([]);
    expect(result.concept_results.find((c) => c.concept_tag === 'payment_voucher_basics')?.result).toBe('pass');
    expect(result.concept_results.find((c) => c.concept_tag === 'journal_voucher_basics')?.result).toBe('pass');
  });

  it('does not accept a voucher whose net effect differs', () => {
    const dayBook = {
      vouchers: [
        voucher('Journal', '20240430', [
          ['Software Subscription', 'Dr', 3000],
          ['Prepaid Software', 'Dr', 12000],
          ['HDFC Bank — 1234', 'Cr', 15000],
        ]),
      ],
    };
    const result = scoreSubmission(dayBook, emptyTrialBalance, answerKey);
    expect(result.composite_matches).toEqual([]);
    expect(result.per_voucher_diffs.some((d) => d.error_code === 'VOUCHER_MISSING')).toBe(true);
  });
});

describe('extra vouchers are listed and only blank or duplicate ones cost anything', () => {
  const answerKey: AnswerKey = {
    entries: [
      leg(1, ['Rent', 'Dr', 25000], { voucher_type: 'Payment', concept_tags: ['payment_voucher_basics'] }),
      leg(1, ['HDFC Bank — 1234', 'Cr', 25000], { voucher_type: 'Payment', concept_tags: ['payment_voucher_basics'] }),
    ],
  };
  const rent = voucher('Payment', '20240405', [['Rent', 'Dr', 25000], ['HDFC Bank — 1234', 'Cr', 25000]]);

  it('reports a Suspense detour and its reversal without changing the score', () => {
    const detour = voucher('Payment', '20240406', [['Suspense', 'Dr', 18000], ['HDFC Bank — 1234', 'Cr', 18000]]);
    const reversal = voucher('Journal', '20240407', [['HDFC Bank — 1234', 'Dr', 18000], ['Suspense', 'Cr', 18000]]);
    const result = scoreSubmission({ vouchers: [rent, detour, reversal] }, emptyTrialBalance, answerKey);
    expect(result.unmatched_vouchers?.map((v) => [v.position, v.kind])).toEqual([[2, 'reversal'], [3, 'reversal']]);
    expect(result.weighted_score).toBeCloseTo(1, 5);
  });

  it('reports a duplicate and a blank voucher and charges one standard weight each', () => {
    const duplicate = voucher('Payment', '20240405', [['Rent', 'Dr', 25000], ['HDFC Bank — 1234', 'Cr', 25000]]);
    const blank = voucher('Purchase', '20240401', []);
    const result = scoreSubmission({ vouchers: [rent, duplicate, blank] }, emptyTrialBalance, answerKey);
    expect(result.unmatched_vouchers?.map((v) => v.kind)).toEqual(['duplicate', 'blank']);
    // Rent transaction: 2 legs x (account, dr_cr, amount) + voucher_type + gst 2 + tds 2 + bill 1 = 12 earned of 12, plus 2 penalty.
    expect(result.weighted_score).toBeCloseTo(12 / 14, 5);
  });

  it('describes an unrelated posting as extra with its ledgers and amount', () => {
    const extra = voucher('Purchase', '20240409', [['Purchases', 'Dr', 40000], ['Deccan Traders', 'Cr', 40000]]);
    const result = scoreSubmission({ vouchers: [rent, extra] }, emptyTrialBalance, answerKey);
    expect(result.unmatched_vouchers).toEqual([
      { position: 2, date: '20240409', voucher_type: 'Purchase', ledgers: ['Purchases', 'Deccan Traders'], amount: 40000, kind: 'extra' },
    ]);
  });
});

describe('ledger set-up findings', () => {
  const answerKey: AnswerKey = {
    entries: [
      leg(1, ['Karnataka Emporium', 'Dr', 59000], { voucher_type: 'Sales', concept_tags: ['sales_voucher_basics'], bill_reference: 'INV-030' }),
      leg(1, ['Sales', 'Cr', 50000], { voucher_type: 'Sales', concept_tags: ['sales_voucher_basics'] }),
      leg(1, ['Output CGST', 'Cr', 4500], { voucher_type: 'Sales', concept_tags: ['gst_classification'], gst_head: 'CGST', gst_rate: 18 }),
      leg(1, ['Output SGST', 'Cr', 4500], { voucher_type: 'Sales', concept_tags: ['gst_classification'], gst_head: 'SGST', gst_rate: 18 }),
      leg(2, ['HDFC Bank — 1234', 'Dr', 59000], { voucher_type: 'Receipt', concept_tags: ['receipt_voucher_basics'] }),
      leg(2, ['Karnataka Emporium', 'Cr', 59000], { voucher_type: 'Receipt', concept_tags: ['receipt_voucher_basics'], bill_reference: 'INV-030' }),
    ],
  };

  it('flags GST ledgers with no side, a second bank ledger and two ledgers for one party, once each', () => {
    const dayBook = {
      vouchers: [
        voucher('Sales', '20240410', [['Karnataka Emporium', 'Dr', 59000], ['Sales', 'Cr', 50000], ['CGST', 'Cr', 4500], ['SGST', 'Cr', 4500]], 'inv', { 'Karnataka Emporium': 'INV-030' }),
        voucher('Receipt', '20240420', [['HDFC 123', 'Dr', 59000], ['KAREMP', 'Cr', 59000]], 'rcpt', { KAREMP: 'INV-030' }),
        voucher('Receipt', '20240421', [['HDFC BANK', 'Dr', 100], ['Interest Income', 'Cr', 100]]),
      ],
    };
    const result = scoreSubmission(dayBook, emptyTrialBalance, answerKey);
    expect(result.ledger_findings).toEqual([
      { code: 'GST_LEDGER_NO_SIDE', ledgers: ['CGST', 'SGST'] },
      { code: 'SECOND_BANK_LEDGER', ledgers: ['HDFC 123', 'HDFC BANK'] },
      { code: 'DUPLICATE_PARTY_LEDGER', ledgers: ['Karnataka Emporium', 'KAREMP'] },
    ]);
  });

  it('is silent for a clean ledger set-up whatever the single bank ledger is called', () => {
    const dayBook = {
      vouchers: [
        voucher('Sales', '20240410', [['Karnataka Emporium', 'Dr', 59000], ['Sales', 'Cr', 50000], ['Output CGST', 'Cr', 4500], ['Output SGST', 'Cr', 4500]], 'inv', { 'Karnataka Emporium': 'INV-030' }),
        voucher('Receipt', '20240420', [['HDFC BANK', 'Dr', 59000], ['Karnataka Emporium', 'Cr', 59000]], 'rcpt', { 'Karnataka Emporium': 'INV-030' }),
      ],
    };
    const result = scoreSubmission(dayBook, emptyTrialBalance, answerKey);
    expect(result.ledger_findings).toEqual([]);
    expect(result.per_voucher_diffs.filter((d) => !d.is_correct)).toEqual([]);
  });
});

describe('bank reference in the narration (documents mode)', () => {
  const keyNarration = 'Received Rs 59,000 from Karnataka Emporium via bank, Ref NEFT/N24042002/KAREMP/INV-030, against INV-030.';
  const answerKey: AnswerKey = {
    entries: [
      leg(1, ['HDFC Bank — 1234', 'Dr', 59000], { voucher_type: 'Receipt', concept_tags: ['receipt_voucher_basics'], narration: keyNarration }),
      leg(1, ['Karnataka Emporium', 'Cr', 59000], { voucher_type: 'Receipt', concept_tags: ['receipt_voucher_basics'], narration: keyNarration }),
    ],
  };
  const receipt = (narration: string) => ({
    vouchers: [voucher('Receipt', '20240420', [['HDFC Bank — 1234', 'Dr', 59000], ['Karnataka Emporium', 'Cr', 59000]], narration)],
  });

  it('passes when the statement reference, or just its stamp, is in the narration', () => {
    expect(scoreSubmission(receipt('NEFT/N24042002/KAREMP/INV-030 Karnataka Emporium'), emptyTrialBalance, answerKey).per_voucher_diffs.find((d) => d.field === 'narration')?.is_correct).toBe(true);
    expect(scoreSubmission(receipt('rcpt n24042002'), emptyTrialBalance, answerKey).per_voucher_diffs.find((d) => d.field === 'narration')?.is_correct).toBe(true);
  });

  it('flags a narration without the reference, at one standard weight', () => {
    const result = scoreSubmission(receipt('Received from Karnataka Emporium'), emptyTrialBalance, answerKey);
    const narration = result.per_voucher_diffs.find((d) => d.field === 'narration');
    expect(narration?.is_correct).toBe(false);
    expect(narration?.error_code).toBe('NARRATION_MISSING');
    // 2 legs x 3 + voucher_type + gst 2 + tds 2 + bill 1 = 12 earned of 13.
    expect(result.weighted_score).toBeCloseTo(12 / 13, 5);
    // The retired narration concept is never reported.
    expect(result.concept_results.some((c) => c.concept_tag === 'narration_discipline')).toBe(false);
  });

  it('checks nothing about narration when the key names no statement reference', () => {
    const plainKey: AnswerKey = { entries: answerKey.entries.map((entry) => ({ ...entry, narration: 'Received from Karnataka Emporium.' })) };
    const result = scoreSubmission(receipt(''), emptyTrialBalance, plainKey);
    expect(result.per_voucher_diffs.some((d) => d.field === 'narration')).toBe(false);
  });
});

describe('accruals ledger family (Yeshas, Accounts Payable for Outstanding Expenses)', () => {
  it('accepts Accounts Payable where the key says Outstanding Expenses', () => {
    const answerKey: AnswerKey = {
      entries: [
        leg(1, ['Electricity Charges', 'Dr', 4500], { voucher_type: 'Journal', concept_tags: ['journal_voucher_basics'] }),
        leg(1, ['Outstanding Expenses', 'Cr', 4500], { voucher_type: 'Journal', concept_tags: ['journal_voucher_basics'] }),
      ],
    };
    const dayBook = { vouchers: [voucher('Journal', '20250131', [['Electricity Charges', 'Dr', 4500], ['Accounts Payable', 'Cr', 4500]])] };
    const result = scoreSubmission(dayBook, emptyTrialBalance, answerKey);
    expect(result.per_voucher_diffs.filter((d) => !d.is_correct)).toEqual([]);
  });
});

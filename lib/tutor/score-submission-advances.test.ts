import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { Voucher } from '@/lib/schemas/voucher';
import { scoreSubmission } from './score-submission';

// 2026-09-11: a receipt carries GST only for a service advance (rulebook 9B
// step 1, Output GST on Advance), so GST on a receipt is judged on the
// output side with the figures checked, like a sales voucher.

type LegSpec = [account: string, side: 'Dr' | 'Cr', amount: number];

function leg(sequence: number, [account, side, amount]: LegSpec, overrides: Partial<AnswerKeyEntry> = {}): AnswerKeyEntry {
  return {
    sequence,
    correct_account: account,
    dr_cr: side,
    amount,
    voucher_type: 'Receipt',
    gst_head: null,
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: ['customer_advance'],
    requires_source_document: false,
    source_document_type: null,
    ...overrides,
  };
}

function voucher(legs: LegSpec[]): Voucher {
  return {
    voucherType: 'Receipt',
    date: '20250505',
    narration: 'NEFT/N25050501/KOHLI advance inclusive of GST',
    ledgerEntries: legs.map(([ledgerName, drOrCr, amount]) => ({
      ledgerName,
      amount,
      drOrCr,
      billAllocations: ledgerName === 'Kohli Retail' ? [{ name: 'ADV-C01', amount }] : [],
    })),
  };
}

const emptyTrialBalance = { ledgers: [] };

describe('service advance receipt (rulebook 9B step 1)', () => {
  const answerKey: AnswerKey = {
    entries: [
      leg(1, ['HDFC Bank — 1234', 'Dr', 118000]),
      leg(1, ['Kohli Retail', 'Cr', 100000], { bill_reference: 'ADV-C01 (Advance)' }),
      leg(1, ['Output CGST on Advance', 'Cr', 9000], { gst_head: 'CGST', gst_rate: 18 }),
      leg(1, ['Output SGST on Advance', 'Cr', 9000], { gst_head: 'SGST', gst_rate: 18 }),
    ],
  };

  const gstDiff = (vouchers: Voucher[]) =>
    scoreSubmission({ vouchers }, emptyTrialBalance, answerKey).per_voucher_diffs.find((d) => d.field === 'gst');

  it('accepts the advance-GST ledgers on the output side with the right figures', () => {
    const diff = gstDiff([
      voucher([
        ['HDFC Bank', 'Dr', 118000],
        ['Kohli Retail', 'Cr', 100000],
        ['Output CGST on Advance', 'Cr', 9000],
        ['Output SGST on Advance', 'Cr', 9000],
      ]),
    ]);
    expect(diff?.is_correct).toBe(true);
  });

  it('flags advance GST posted to the input side', () => {
    const diff = gstDiff([
      voucher([
        ['HDFC Bank', 'Dr', 118000],
        ['Kohli Retail', 'Cr', 100000],
        ['Input CGST', 'Cr', 9000],
        ['Input SGST', 'Cr', 9000],
      ]),
    ]);
    expect(diff?.is_correct).toBe(false);
  });

  it('flags advance GST with the wrong figure', () => {
    const diff = gstDiff([
      voucher([
        ['HDFC Bank', 'Dr', 118000],
        ['Kohli Retail', 'Cr', 106000],
        ['Output CGST on Advance', 'Cr', 6000],
        ['Output SGST on Advance', 'Cr', 6000],
      ]),
    ]);
    expect(diff?.is_correct).toBe(false);
  });
});

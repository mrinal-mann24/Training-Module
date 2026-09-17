import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { LedgerEntry, ParsedTrialBalance, Voucher } from '@/lib/schemas/voucher';
import { keyBankReference, scoreSubmission } from './score-submission';

// Regression tests for the second 2026-09-17 audit round: TDS section and
// amount, GST amounts from key metadata, the month-end set-off judged
// against the learner's own GST ledgers, head-wise payable ledgers, the
// tie-out guards and multi-bill bank references.

function leg(sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string, options: Partial<AnswerKeyEntry> = {}): AnswerKeyEntry {
  return {
    sequence,
    correct_account: account,
    dr_cr: drCr,
    amount,
    voucher_type: voucherType,
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
    ...options,
  };
}

function entry(ledgerName: string, drOrCr: 'Dr' | 'Cr', amount: number, refs: string[] = []): LedgerEntry {
  return { ledgerName, drOrCr, amount, billAllocations: refs.map((name) => ({ name, amount })) };
}

function voucher(voucherType: string, entries: LedgerEntry[], narration = 'x'): Voucher {
  return { voucherType, date: '20240430', narration, ledgerEntries: entries };
}

const EMPTY_TB: ParsedTrialBalance = { ledgers: [] };
const score = (vouchers: Voucher[], key: AnswerKey) => scoreSubmission({ vouchers }, EMPTY_TB, key);
const diffOf = (result: ReturnType<typeof score>, sequence: number, field: string) =>
  result.per_voucher_diffs.filter((diff) => diff.voucherRef === sequence && diff.field === field);

describe('bank references in key narrations', () => {
  it('reads a multi-bill reference joined with " & " and a 9-digit stamp (sequence 100+)', () => {
    const narration = 'Paid Rs 4,50,000 to Mumbai Suppliers via bank, Ref NEFT/N240416101/MUMBAI SUPPLIERS/MS-B1 & MS-B2 & MS-B3, against MS-B1 & MS-B2 & MS-B3.';
    expect(keyBankReference(narration)).toBe('NEFT/N240416101/MUMBAI SUPPLIERS/MS-B1 & MS-B2 & MS-B3');
  });

  it('does not cut a bill number with a dot or lowercase letters short', () => {
    expect(keyBankReference('Received Rs 100 from Karnataka Emporium via bank, Ref NEFT/N24041601/KARNATAKA EMPORIUM/inv.12, against inv.12.')).toBe(
      'NEFT/N24041601/KARNATAKA EMPORIUM/inv.12',
    );
    expect(keyBankReference('Cash deposited into bank, Rs 5,000, Ref CASH DEPOSIT/CD24040305/CASH.')).toBe('CASH DEPOSIT/CD24040305/CASH');
    expect(keyBankReference('Being office computers vide bill DT-115, Ref INV-012.')).toBeNull();
  });

  it('scores the narration of a multi-bill payment', () => {
    const narration = 'Paid Rs 4,50,000 to Mumbai Suppliers via bank, Ref NEFT/N240416101/MUMBAI SUPPLIERS/MS-B1 & MS-B2, against MS-B1 & MS-B2.';
    const key: AnswerKey = {
      entries: [
        leg(1, 'Mumbai Suppliers', 'Dr', 450000, 'Payment', { bill_reference: 'MS-B1, MS-B2', narration }),
        leg(1, 'HDFC Bank — 1234', 'Cr', 450000, 'Payment', { bill_reference: 'MS-B1, MS-B2', narration }),
      ],
    };
    const pay = (text: string) =>
      voucher('Payment', [entry('Mumbai Suppliers', 'Dr', 450000, ['MS-B1', 'MS-B2']), entry('HDFC Bank — 1234', 'Cr', 450000)], text);
    expect(diffOf(score([pay('NEFT/N240416101/MUMBAI SUPPLIERS/MS-B1 & MS-B2')], key), 1, 'narration')[0].is_correct).toBe(true);
    expect(diffOf(score([pay('paid N240416101')], key), 1, 'narration')[0].is_correct).toBe(true);
    expect(diffOf(score([pay('paid N240416102')], key), 1, 'narration')[0].error_code).toBe('NARRATION_MISSING');
  });
});

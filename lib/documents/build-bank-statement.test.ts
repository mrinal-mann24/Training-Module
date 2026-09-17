import { describe, expect, it } from 'vitest';
import type { GeneratedExercise } from '@/lib/schemas/exercise';
import { applyBankReferences, buildBankStatementContent } from './build-bank-statement';

type Entry = GeneratedExercise['answer_key']['entries'][number];

const leg = (sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string, ref: string | null = null): Entry => ({
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
  bill_reference: ref,
  narration: 'model-written narration with UTR7788392',
  concept_tags: ['payment_voucher_basics'],
  requires_source_document: voucherType !== 'Sales',
  source_document_type: voucherType !== 'Sales' ? 'bank_statement' : null,
});

// Garima's Level 3 shape: a contra withdrawal (text-backed), a sale, two
// receipts and a payment on the statement.
const generated = {
  scenario: 'Batch.',
  difficulty_level: 'L1',
  variant: 'A',
  transactions: [
    { sequence: 1, description: 'On 01-Jun-2026, withdraw Rs 10,000 from HDFC Bank — 1234 into Cash-in-Hand.' },
    { sequence: 2, description: 'On 05-Jun-2026, sell goods to Kolkata Emporium under Invoice KE-305.' },
    { sequence: 3, description: 'On 08-Jun-2026, a partial payment from Kolkata Emporium against KE-305: post it from the bank statement.' },
    { sequence: 4, description: 'On 21-Jun-2026, full settlement of VV-556 to Vizag Vendors: post it from the bank statement.' },
  ],
  answer_key: {
    entries: [
      leg(1, 'Cash', 'Dr', 10000, 'Contra'),
      leg(1, 'HDFC Bank — 1234', 'Cr', 10000, 'Contra'),
      leg(2, 'Kolkata Emporium', 'Dr', 64900, 'Sales', 'KE-305'),
      leg(2, 'Sales', 'Cr', 64900, 'Sales', 'KE-305'),
      leg(3, 'HDFC Bank — 1234', 'Dr', 25000, 'Receipt', 'Against KE-305 (Partial)'),
      leg(3, 'Kolkata Emporium', 'Cr', 25000, 'Receipt', 'Against KE-305 (Partial)'),
      leg(4, 'Vizag Vendors', 'Dr', 17700, 'Payment', 'VV-556'),
      leg(4, 'HDFC Bank — 1234', 'Cr', 17700, 'Payment', 'VV-556'),
    ],
  },
} as unknown as GeneratedExercise;

describe('buildBankStatementContent (statement written by code from the key, 2026-09-03)', () => {
  it('lists every bank movement in date order with a true running balance', () => {
    const built = buildBankStatementContent({ companyName: 'Blossom Retail Pvt Ltd', openingBankBalance: 926116, generated });
    expect(built).not.toBeNull();
    const { content } = built!;
    expect(content.accountHolderName).toBe('Blossom Retail Pvt Ltd');
    expect(content.period).toBe('01-Jun-2026 to 21-Jun-2026');
    expect(content.transactions.map((t) => [t.date, t.debit, t.credit, t.balance])).toEqual([
      ['01-Jun-2026', 10000, null, 916116],
      ['08-Jun-2026', null, 25000, 941116],
      ['21-Jun-2026', 17700, null, 923416],
    ]);
  });

  it('prints a bank-shaped reference carrying the bill number, unique per line', () => {
    const { content, referenceBySequence } = buildBankStatementContent({ companyName: 'X', openingBankBalance: 100000, generated })!;
    expect(content.transactions[1].narration).toBe('NEFT/N26060803/KOLKATA EMPORIUM/KE-305');
    expect(content.transactions[2].narration).toBe('NEFT/N26062104/VIZAG VENDORS/VV-556');
    expect(content.transactions[0].narration).toBe('CASH WITHDRAWAL/CW26060101/CASH');
    expect(new Set(referenceBySequence.values()).size).toBe(3);
  });

  it('separates several settled bills with " & " and spells a party "&" as AND (2026-09-17)', () => {
    // "MS/990/MS/991" could not be read as two bills, and "&" in a party
    // name fell outside the scorer's reference pattern.
    const multi = {
      ...generated,
      transactions: [{ sequence: 9, description: 'On 25-Jun-2026, a payment to Mehta & Associates went out from the bank.' }],
      answer_key: {
        entries: [
          leg(9, 'Mehta & Associates', 'Dr', 30000, 'Payment', 'Against MS/990, Against MS/991 (part)'),
          leg(9, 'HDFC Bank — 1234', 'Cr', 30000, 'Payment', 'Against MS/990, Against MS/991 (part)'),
        ],
      },
    } as unknown as GeneratedExercise;
    const built = buildBankStatementContent({ companyName: 'X', openingBankBalance: 50000, generated: multi })!;
    expect(built.content.transactions[0].narration).toBe('NEFT/N26062509/MEHTA AND ASSOCIATES/MS/990 & MS/991');
    const payment = applyBankReferences(multi, built.referenceBySequence).answer_key.entries[0];
    expect(payment.narration).toBe(
      'Paid Rs 30,000 to Mehta & Associates via bank, Ref NEFT/N26062509/MEHTA AND ASSOCIATES/MS/990 & MS/991, against MS/990 & MS/991.',
    );
  });

  it('never prints a negative balance unless the account has an overdraft (2026-09-17 audit)', () => {
    // Opening 0 and a 10,000 withdrawal on the 1st: no bank would issue that row.
    expect(() => buildBankStatementContent({ companyName: 'X', openingBankBalance: 0, generated })).toThrow(/would go negative/);
    const od = buildBankStatementContent({ companyName: 'X', openingBankBalance: 0, generated, overdraftAllowed: true })!;
    expect(od.content.transactions[0].balance).toBe(-10000);
  });

  it('returns null when the batch touches no bank ledger', () => {
    const noBank = { ...generated, answer_key: { entries: [leg(2, 'Kolkata Emporium', 'Dr', 64900, 'Sales', 'KE-305')] } } as GeneratedExercise;
    expect(buildBankStatementContent({ companyName: 'X', openingBankBalance: 0, generated: noBank })).toBeNull();
  });
});

describe('applyBankReferences (key narration carries the same reference as the statement)', () => {
  it('rewrites narrations on statement sequences only', () => {
    const built = buildBankStatementContent({ companyName: 'X', openingBankBalance: 100000, generated })!;
    const applied = applyBankReferences(generated, built.referenceBySequence);
    const receipt = applied.answer_key.entries.find((e) => e.sequence === 3)!;
    expect(receipt.narration).toBe('Received Rs 25,000 from Kolkata Emporium via bank, Ref NEFT/N26060803/KOLKATA EMPORIUM/KE-305, against KE-305.');
    const payment = applied.answer_key.entries.find((e) => e.sequence === 4)!;
    expect(payment.narration).toContain('Paid Rs 17,700 to Vizag Vendors via bank, Ref NEFT/N26062104/VIZAG VENDORS/VV-556');
    const contra = applied.answer_key.entries.find((e) => e.sequence === 1)!;
    expect(contra.narration).toBe('Cash withdrawn from bank, Rs 10,000, Ref CASH WITHDRAWAL/CW26060101/CASH.');
    const sale = applied.answer_key.entries.find((e) => e.sequence === 2)!;
    expect(sale.narration).toBe('model-written narration with UTR7788392');
  });
});

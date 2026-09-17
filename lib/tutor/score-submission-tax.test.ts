import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { LedgerEntry, ParsedTrialBalance, Voucher } from '@/lib/schemas/voucher';
import { evaluateTrialBalanceTieOut, keyBankReference, scoreSubmission } from './score-submission';

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

describe('TDS: section and amount are scored (pack metadata keys)', () => {
  // Pack seq 47: Mehta & Associates, 194J at 10% on 75,000, GST 18% intra.
  const mehta = (options: Partial<AnswerKeyEntry> = {}): AnswerKey => ({
    entries: [
      leg(1, 'Legal & Professional Charges', 'Dr', 75000, 'Purchase', { gst_head: 'CGST', gst_rate: 18, tds_section: '194J', tds_rate: 10, tds_base: 75000, bill_reference: 'CA26-101', ...options }),
      leg(1, 'Mehta & Associates', 'Cr', 81000, 'Purchase', { gst_head: 'CGST', gst_rate: 18, tds_section: '194J', tds_rate: 10, tds_base: 75000, bill_reference: 'CA26-101', ...options }),
    ],
  });
  const posted = (tdsLedger: string, tds: number, party = 81000) =>
    voucher('Purchase', [
      entry('Legal & Professional Charges', 'Dr', 75000),
      entry('Input CGST', 'Dr', 6750),
      entry('Input SGST', 'Dr', 6750),
      entry('Mehta & Associates', 'Cr', party, ['CA26-101']),
      entry(tdsLedger, 'Cr', tds),
    ]);
  const tdsDiff = (v: Voucher, key: AnswerKey = mehta()) => diffOf(score([v], key), 1, 'tds')[0];

  it('accepts the right section and amount, within a rupee of rounding', () => {
    expect(tdsDiff(posted('TDS Payable — u/s 194J', 7500)).is_correct).toBe(true);
    expect(tdsDiff(posted('TDS Payable', 7500)).is_correct).toBe(true);
    expect(tdsDiff(posted('TDS 194J 10%', 7501, 80999)).is_correct).toBe(true);
  });

  it('flags a wrong section at the same rate (194I for a 194J fee)', () => {
    expect(tdsDiff(posted('TDS Payable — u/s 194I', 7500)).error_code).toBe('TDS_SECTION_WRONG');
  });

  it('flags a 194J ledger on a 194C bill', () => {
    const balaji: AnswerKey = {
      entries: [
        leg(1, 'Repairs & Maintenance', 'Dr', 150000, 'Purchase', { gst_head: 'CGST', gst_rate: 18, tds_section: '194C', tds_rate: 2, tds_base: 150000, bill_reference: 'BI-047' }),
        leg(1, 'Balaji Interiors', 'Cr', 174000, 'Purchase', { gst_head: 'CGST', gst_rate: 18, tds_section: '194C', tds_rate: 2, tds_base: 150000, bill_reference: 'BI-047' }),
      ],
    };
    const v = voucher('Purchase', [
      entry('Repairs & Maintenance', 'Dr', 150000),
      entry('Input CGST', 'Dr', 13500),
      entry('Input SGST', 'Dr', 13500),
      entry('Balaji Interiors', 'Cr', 174000, ['BI-047']),
      entry('TDS Payable — u/s 194J', 'Cr', 3000),
    ]);
    expect(tdsDiff(v, balaji).error_code).toBe('TDS_SECTION_WRONG');
  });

  it('flags a wrong TDS amount, naming a wrong rate or a GST-inclusive base when that is what was done', () => {
    expect(tdsDiff(posted('TDS Payable — u/s 194J', 7000, 81500)).error_code).toBe('TDS_AMOUNT_WRONG');
    expect(tdsDiff(posted('TDS Payable — u/s 194J', 1500, 87000)).error_code).toBe('TDS_RATE_WRONG');
    expect(tdsDiff(posted('TDS Payable — u/s 194J', 8850, 79650)).error_code).toBe('TDS_BASE_WRONG');
  });
});

describe('TDS and GST legs of generated keys are amount-checked', () => {
  const key: AnswerKey = {
    entries: [
      leg(1, 'Professional Fees', 'Dr', 60000, 'Purchase', { bill_reference: 'PF-1' }),
      leg(1, 'Input CGST', 'Dr', 5400, 'Purchase', { gst_head: 'CGST', gst_rate: 9, bill_reference: 'PF-1' }),
      leg(1, 'Input SGST', 'Dr', 5400, 'Purchase', { gst_head: 'SGST', gst_rate: 9, bill_reference: 'PF-1' }),
      leg(1, 'Consultant Co', 'Cr', 64800, 'Purchase', { bill_reference: 'PF-1' }),
      leg(1, 'TDS Payable u/s 194J', 'Cr', 6000, 'Purchase', { tds_section: '194J', tds_rate: 10, tds_base: 60000, bill_reference: 'PF-1' }),
    ],
  };
  const posted = (cgst: number, tds: number, party: number) =>
    voucher('Purchase', [
      entry('Professional Fees', 'Dr', 60000),
      entry('Input CGST', 'Dr', cgst),
      entry('Input SGST', 'Dr', 5400),
      entry('Consultant Co', 'Cr', party, ['PF-1']),
      entry('TDS Payable u/s 194J', 'Cr', tds),
    ]);

  it('a wrong TDS leg is AMOUNT_WRONG on the leg and a TDS error', () => {
    const result = score([posted(5400, 5000, 65800)], key);
    const amounts = diffOf(result, 1, 'amount');
    expect(amounts[4].error_code).toBe('AMOUNT_WRONG');
    expect(amounts[4].vacuously_correct).toBeUndefined();
    expect(diffOf(result, 1, 'tds')[0].is_correct).toBe(false);
  });

  it('allows a rupee of rounding on a tax leg', () => {
    const result = score([posted(5400.6, 6000, 64800.6)], key);
    expect(diffOf(result, 1, 'amount')[1].is_correct).toBe(true);
  });
});

describe('GST amounts from key metadata (the pack stores GST as gst_head/gst_rate only)', () => {
  const purchase = (head: 'CGST' | 'IGST', rate: number): AnswerKey => ({
    entries: [
      leg(1, 'Trading goods', 'Dr', 80000, 'Purchase', { gst_head: head, gst_rate: rate, bill_reference: 'DT-115' }),
      leg(1, 'Deccan Traders', 'Cr', 94400, 'Purchase', { gst_head: head, gst_rate: rate, bill_reference: 'DT-115' }),
    ],
  });
  const intra = (cgst: number, sgst: number) =>
    voucher('Purchase', [
      entry('Trading goods', 'Dr', 80000),
      entry('Input CGST', 'Dr', cgst),
      entry('Input SGST', 'Dr', sgst),
      entry('Deccan Traders', 'Cr', 80000 + cgst + sgst, ['DT-115']),
    ]);
  const gstDiff = (v: Voucher, key: AnswerKey) => diffOf(score([v], key), 1, 'gst')[0];

  it('accepts CGST and SGST at half the combined rate each (pack: gst_rate 18 on the CGST head)', () => {
    expect(gstDiff(intra(7200, 7200), purchase('CGST', 18)).is_correct).toBe(true);
  });

  it('reads a generated per-head rate (9 on CGST) as 18% overall, like the generation checks', () => {
    expect(gstDiff(intra(7200, 7200), purchase('CGST', 9)).is_correct).toBe(true);
  });

  it('flags the wrong tax figure', () => {
    expect(gstDiff(intra(4000, 4000), purchase('CGST', 18)).error_code).toBe('GST_RATE_WRONG');
    expect(gstDiff(intra(7200, 4000), purchase('CGST', 18)).error_code).toBe('GST_RATE_WRONG');
  });

  it('checks IGST at the whole rate', () => {
    const igst = (amount: number) =>
      voucher('Purchase', [entry('Trading goods', 'Dr', 80000), entry('Input IGST', 'Dr', amount), entry('Deccan Traders', 'Cr', 80000 + amount, ['DT-115'])]);
    expect(gstDiff(igst(14400), purchase('IGST', 18)).is_correct).toBe(true);
    expect(gstDiff(igst(12000), purchase('IGST', 18)).error_code).toBe('GST_RATE_WRONG');
  });
});

describe('month-end GST set-off is judged against the learner\'s own GST ledgers', () => {
  // The pack's April figures (seq 99): output CGST 40,680, SGST 40,680,
  // IGST 3,52,980; input CGST and SGST 52,314.83 each (5,000 carried
  // forward), IGST 1,71,000; net payable 1,58,710.34.
  const books: Voucher[] = [
    voucher('Sales', [entry('Karnataka Emporium', 'Dr', 533360), entry('Sales', 'Cr', 452000), entry('Output CGST', 'Cr', 40680), entry('Output SGST', 'Cr', 40680)]),
    voucher('Sales', [entry('Delhi Bazaar', 'Dr', 2313980), entry('Sales', 'Cr', 1961000), entry('Output IGST', 'Cr', 352980)]),
    voucher('Purchase', [entry('Purchases', 'Dr', 525720.33), entry('Input CGST', 'Dr', 47314.83), entry('Input SGST', 'Dr', 47314.83), entry('Deccan Traders', 'Cr', 620349.99)]),
    voucher('Purchase', [entry('Purchases', 'Dr', 950000), entry('Input IGST', 'Dr', 171000), entry('Mumbai Suppliers', 'Cr', 1121000)]),
  ];
  const tags: AnswerKeyEntry['concept_tags'] = ['journal_voucher_basics', 'gst_classification'];
  const setOffKey: AnswerKey = {
    opening_balances: [
      { account: 'Input CGST c/f', dr_cr: 'Dr', amount: 5000 },
      { account: 'Input SGST c/f', dr_cr: 'Dr', amount: 5000 },
    ],
    entries: [
      leg(1, 'Output CGST', 'Dr', 40680, 'Journal', { gst_head: 'CGST', concept_tags: tags }),
      leg(1, 'Output SGST', 'Dr', 40680, 'Journal', { gst_head: 'SGST', concept_tags: tags }),
      leg(1, 'Output IGST', 'Dr', 352980, 'Journal', { gst_head: 'IGST', concept_tags: tags }),
      leg(1, 'Input CGST', 'Cr', 52314.83, 'Journal', { gst_head: 'CGST', concept_tags: tags }),
      leg(1, 'Input SGST', 'Cr', 52314.83, 'Journal', { gst_head: 'SGST', concept_tags: tags }),
      leg(1, 'Input IGST', 'Cr', 171000, 'Journal', { gst_head: 'IGST', concept_tags: tags }),
      leg(1, 'GST Payable', 'Cr', 158710.34, 'Journal', { concept_tags: tags }),
    ],
  };
  const setOff = (credits: { c: number; s: number; i: number }, payables: [string, number][]) =>
    voucher('Journal', [
      entry('Output CGST', 'Dr', 40680),
      entry('Output SGST', 'Dr', 40680),
      entry('Output IGST', 'Dr', 352980),
      entry('Input CGST', 'Cr', credits.c),
      entry('Input SGST', 'Cr', credits.s),
      entry('Input IGST', 'Cr', credits.i),
      ...payables.map(([name, amount]) => entry(name, 'Cr', amount)),
    ]);
  const judged = (v: Voucher) => score([...books, v], setOffKey);

  it('accepts the least-cash statutory utilisation', () => {
    const result = judged(setOff({ c: 52314.83, s: 52314.83, i: 171000 }, [['GST Payable', 158710.34]]));
    expect(diffOf(result, 1, 'gst')[0].is_correct).toBe(true);
    expect(diffOf(result, 1, 'account').every((diff) => diff.is_correct)).toBe(true);
  });

  it('accepts a head-wise payable ledger when the whole liability is one head (IGST Payable)', () => {
    const result = judged(setOff({ c: 52314.83, s: 52314.83, i: 171000 }, [['IGST Payable', 158710.34]]));
    expect(diffOf(result, 1, 'gst')[0].is_correct).toBe(true);
    expect(diffOf(result, 1, 'account').every((diff) => diff.is_correct)).toBe(true);
  });

  it('flags a set-off that leaves more to pay than the least-cash order (CGST/SGST credit left unused)', () => {
    const result = judged(setOff({ c: 40680, s: 40680, i: 171000 }, [['GST Payable', 181980]]));
    expect(diffOf(result, 1, 'gst')[0].error_code).toBe('GST_RATE_WRONG');
  });

  it('flags credit used beyond what the books hold', () => {
    const result = judged(setOff({ c: 52314.83, s: 52314.83, i: 200000 }, [['GST Payable', 129710.34]]));
    expect(diffOf(result, 1, 'gst')[0].error_code).toBe('GST_RATE_WRONG');
  });

  it('keeps rejecting an Output ledger used as the payable', () => {
    const v = voucher('Journal', [
      entry('Output CGST', 'Dr', 40680),
      entry('Output SGST', 'Dr', 40680),
      entry('Output IGST', 'Dr', 352980),
      entry('Input CGST', 'Cr', 52314.83),
      entry('Input SGST', 'Cr', 52314.83),
      entry('Input IGST', 'Cr', 171000),
      entry('Output IGST', 'Cr', 158710.34),
    ]);
    const accounts = diffOf(judged(v), 1, 'account');
    expect(accounts[6].error_code).toBe('ACCOUNT_WRONG');
  });

  describe('cross-utilisation rules', () => {
    const smallKey = (legs: [string, 'Dr' | 'Cr', number][]): AnswerKey => ({
      entries: legs.map(([name, side, amount]) => leg(1, name, side, amount, 'Journal', { gst_head: /igst/i.test(name) ? 'IGST' : /cgst/i.test(name) ? 'CGST' : /sgst/i.test(name) ? 'SGST' : null, concept_tags: tags })),
    });
    const sale = (c: number, s: number, i: number) =>
      voucher('Sales', [
        entry('Karnataka Emporium', 'Dr', c + s + i + 1000),
        entry('Sales', 'Cr', 1000),
        ...(c ? [entry('Output CGST', 'Cr', c)] : []),
        ...(s ? [entry('Output SGST', 'Cr', s)] : []),
        ...(i ? [entry('Output IGST', 'Cr', i)] : []),
      ]);
    const buy = (c: number, s: number, i: number) =>
      voucher('Purchase', [
        entry('Purchases', 'Dr', 1000),
        ...(c ? [entry('Input CGST', 'Dr', c)] : []),
        ...(s ? [entry('Input SGST', 'Dr', s)] : []),
        ...(i ? [entry('Input IGST', 'Dr', i)] : []),
        entry('Deccan Traders', 'Cr', c + s + i + 1000),
      ]);
    const gstOf = (vouchers: Voucher[], key: AnswerKey) => diffOf(score(vouchers, key), 1, 'gst')[0];

    it('never sets CGST credit off against SGST', () => {
      const key = smallKey([['Output SGST', 'Dr', 100], ['GST Payable', 'Cr', 100]]);
      const v = voucher('Journal', [entry('Output SGST', 'Dr', 100), entry('Input CGST', 'Cr', 100)]);
      expect(gstOf([sale(0, 100, 0), buy(100, 0, 0), v], key).error_code).toBe('GST_HEAD_WRONG');
    });

    it('uses IGST credit before CGST credit', () => {
      const key = smallKey([['Output CGST', 'Dr', 100], ['Input IGST', 'Cr', 50], ['Input CGST', 'Cr', 50]]);
      const legal = voucher('Journal', [entry('Output CGST', 'Dr', 100), entry('Input IGST', 'Cr', 50), entry('Input CGST', 'Cr', 50)]);
      const illegal = voucher('Journal', [entry('Output CGST', 'Dr', 100), entry('Input CGST', 'Cr', 100)]);
      expect(gstOf([sale(100, 0, 0), buy(100, 0, 50), legal], key).is_correct).toBe(true);
      expect(gstOf([sale(100, 0, 0), buy(100, 0, 50), illegal], key).error_code).toBe('GST_HEAD_WRONG');
    });

    it('accepts the key\'s GST Payable split across head-wise payable ledgers in any legal proportion, and rejects a head with no liability', () => {
      const key = smallKey([['Output CGST', 'Dr', 100], ['Output SGST', 'Dr', 100], ['Input IGST', 'Cr', 50], ['GST Payable', 'Cr', 150]]);
      const split = (payables: [string, number][]) =>
        voucher('Journal', [entry('Output CGST', 'Dr', 100), entry('Output SGST', 'Dr', 100), entry('Input IGST', 'Cr', 50), ...payables.map(([name, amount]) => entry(name, 'Cr', amount))]);
      for (const payables of [
        [['CGST Payable', 50], ['SGST Payable', 100]],
        [['CGST Payable', 75], ['SGST Payable', 75]],
      ] as [string, number][][]) {
        const result = score([sale(100, 100, 0), buy(0, 0, 50), split(payables)], key);
        expect(diffOf(result, 1, 'gst')[0].is_correct).toBe(true);
        expect(diffOf(result, 1, 'account').every((diff) => diff.is_correct)).toBe(true);
      }
      const wrongHead = score([sale(100, 100, 0), buy(0, 0, 50), split([['IGST Payable', 150]])], key);
      expect(diffOf(wrongHead, 1, 'gst')[0].error_code).toBe('GST_HEAD_WRONG');
    });
  });
});

describe('Trial Balance tie-out guards', () => {
  const tb = (rows: [string, number, number?][]): ParsedTrialBalance => ({
    ledgers: rows.map(([ledgerName, closing, opening]) => ({
      ledgerName,
      closingDebit: closing > 0 ? closing : 0,
      closingCredit: closing < 0 ? -closing : 0,
      ...(opening !== undefined ? { openingDebit: opening > 0 ? opening : 0, openingCredit: opening < 0 ? -opening : 0 } : {}),
    })),
  });

  it('does not exempt a party whose name contains "gst" (Kingston Traders)', () => {
    const key: AnswerKey = {
      entries: [leg(1, 'Purchases', 'Dr', 1000, 'Purchase', { bill_reference: 'KT-1' }), leg(1, 'Kingston Traders', 'Cr', 1000, 'Purchase', { bill_reference: 'KT-1' })],
    };
    const result = evaluateTrialBalanceTieOut(tb([['Purchases', 1000], ['Kingston Traders', -400]]), key, null);
    expect(result.mismatches).toEqual([{ account: 'kingston traders', status: 'off', difference: 600 }]);
  });

  it('does not let an alias take a ledger that contradicts the account (Interest Paid for Interest Income)', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'HDFC Bank — 1234', 'Dr', 1200, 'Receipt'),
        leg(1, 'Interest Income', 'Cr', 1200, 'Receipt', { account_aliases: ['Interest'] }),
      ],
    };
    const result = evaluateTrialBalanceTieOut(tb([['HDFC Bank — 1234', 1200], ['Interest Paid', -1200]]), key, null);
    expect(result.mismatches).toEqual([{ account: 'interest income', status: 'missing', difference: 1200 }]);
  });

  it('reads a ledger named like a Tally group when the key names it (Fixed Assets for Office Equipment)', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Office Equipment', 'Dr', 80000, 'Purchase', { account_aliases: ['Fixed Assets'], bill_reference: 'DT-1' }),
        leg(1, 'Deccan Traders', 'Cr', 80000, 'Purchase', { bill_reference: 'DT-1' }),
      ],
    };
    const result = evaluateTrialBalanceTieOut(tb([['Fixed Assets', 80000], ['Deccan Traders', -80000]]), key, null);
    expect(result.mismatches).toEqual([]);
  });

  it('reads an export run from the start of the year (April to May for the May batch) against the previous export', () => {
    const mayKey: AnswerKey = {
      entries: [leg(1, 'Rent', 'Dr', 40000, 'Payment'), leg(1, 'HDFC Bank — 1234', 'Cr', 40000, 'Payment')],
    };
    const rows = (bank: [number, number], rent: [number, number]): [string, number, number][] => [
      ['HDFC Bank — 1234', bank[1], bank[0]],
      ['Rent', rent[1], rent[0]],
      ...Array.from({ length: 12 }, (_, i): [string, number, number] => [`Party ${String.fromCharCode(65 + i)} Traders`, -(1000 + i * 10), -500]),
    ];
    // April export: opening = books begin, April paid rent 40,000.
    const april = tb(rows([800000, 760000], [0, 40000]));
    // May export run from 1 April: the opening column is still books begin.
    const mayFromApril = tb(rows([800000, 720000], [0, 80000]));
    const result = evaluateTrialBalanceTieOut(mayFromApril, mayKey, april);
    expect(result.mismatches).toEqual([]);
    // A true May-only export still reads closing minus opening.
    const mayOnly = tb(rows([760000, 720000], [40000, 80000]));
    expect(evaluateTrialBalanceTieOut(mayOnly, mayKey, april).mismatches).toEqual([]);
  });
});

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

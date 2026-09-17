import { describe, expect, it } from 'vitest';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { LedgerEntry, Voucher } from '@/lib/schemas/voucher';
import { baseVoucherType, canonicalBillReference, scoreSubmission } from './score-submission';

// Regression tests for the 2026-09-17 scoring audit: bill references,
// voucher pairing, custom voucher types and weights.

type LegOptions = Partial<AnswerKeyEntry>;

function leg(sequence: number, account: string, drCr: 'Dr' | 'Cr', amount: number, voucherType: string, options: LegOptions = {}): AnswerKeyEntry {
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
    concept_tags: ['payment_voucher_basics'],
    requires_source_document: false,
    source_document_type: null,
    ...options,
  };
}

function entry(ledgerName: string, drOrCr: 'Dr' | 'Cr', amount: number, refs: string[] = [], billType?: string): LedgerEntry {
  return {
    ledgerName,
    drOrCr,
    amount,
    billAllocations: refs.map((name) => (billType ? { name, amount, billType } : { name, amount })),
  };
}

function voucher(voucherType: string, entries: LedgerEntry[], narration = 'x'): Voucher {
  return { voucherType, date: '20260405', narration, ledgerEntries: entries };
}

const score = (vouchers: Voucher[], key: AnswerKey) => scoreSubmission({ vouchers }, { ledgers: [] }, key);

const diffOf = (result: ReturnType<typeof score>, sequence: number, field: string) =>
  result.per_voucher_diffs.filter((diff) => diff.voucherRef === sequence && diff.field === field);

describe('bill references are exact tokens on the party leg', () => {
  const receiptKey = (reference: string): AnswerKey => ({
    entries: [
      leg(1, 'HDFC Bank — 1234', 'Dr', 45000, 'Receipt', { bill_reference: reference }),
      leg(1, 'Karnataka Emporium', 'Cr', 45000, 'Receipt', { bill_reference: reference }),
    ],
  });
  const receipt = (refs: string[], onBankLeg = false) =>
    voucher('Receipt', [
      entry('HDFC Bank — 1234', 'Dr', 45000, onBankLeg ? refs : []),
      entry('Karnataka Emporium', 'Cr', 45000, onBankLeg ? [] : refs),
    ]);
  const referenceOk = (refs: string[], reference: string, onBankLeg = false) =>
    diffOf(score([receipt(refs, onBankLeg)], receiptKey(reference)), 1, 'bill_reference')[0];

  it('rejects fragments that used to pass by containment', () => {
    expect(referenceOk(['1'], 'INV-001').error_code).toBe('BILL_REFERENCE_WRONG');
    expect(referenceOk(['0'], 'INV-001').error_code).toBe('BILL_REFERENCE_WRONG');
    expect(referenceOk(['INV'], 'INV-001').error_code).toBe('BILL_REFERENCE_WRONG');
    expect(referenceOk(['INV-010'], 'INV-01').error_code).toBe('BILL_REFERENCE_WRONG');
    expect(referenceOk(['DT-115'], 'DT-11').error_code).toBe('BILL_REFERENCE_WRONG');
  });

  it('ignores formatting: case, punctuation, leading zeros and annotations', () => {
    expect(referenceOk(['INV-18'], 'INV-018').is_correct).toBe(true);
    expect(referenceOk(['inv 018'], 'INV-018').is_correct).toBe(true);
    expect(referenceOk(['INV018'], 'INV-18').is_correct).toBe(true);
    expect(referenceOk(['Agst Ref INV-001'], 'INV-001 (bal)').is_correct).toBe(true);
    expect(referenceOk(['INV-025 dt 04-May'], 'Against INV-025 (Partial)').is_correct).toBe(true);
    expect(canonicalBillReference('INV-1-01')).not.toBe(canonicalBillReference('INV-11'));
    expect(canonicalBillReference('New Ref')).toBeNull();
    expect(canonicalBillReference('REF-001')).toBe('REF-1');
  });

  it('requires every reference of a multi-reference key', () => {
    expect(referenceOk(['INV-001'], 'INV-001 (bal), INV-016 (part)').error_code).toBe('BILL_REFERENCE_WRONG');
    expect(referenceOk(['INV-001', 'INV-005'], 'INV-001 (bal), INV-016 (part)').error_code).toBe('BILL_REFERENCE_WRONG');
    expect(referenceOk(['INV-001', 'INV-016'], 'INV-001 (bal), INV-016 (part)').is_correct).toBe(true);
    expect(referenceOk(['MS-B1', 'MS-B2'], 'MS-B1, MS-B2, MS-B3 (part)').error_code).toBe('BILL_REFERENCE_WRONG');
  });

  it('rejects an allocation against a bill the key does not name', () => {
    expect(referenceOk(['INV-001', 'INV-099'], 'INV-001').error_code).toBe('BILL_REFERENCE_WRONG');
  });

  it('ignores allocations on a non-party leg', () => {
    expect(referenceOk(['INV-001'], 'INV-001', true).error_code).toBe('BILL_REFERENCE_MISSING');
  });

  it('accepts an advance applied against the invoice (pack seq 87: ADV-01 against INV-009)', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'HDFC Bank — 1234', 'Dr', 150000, 'Receipt', { bill_reference: 'ADV-01' }),
        leg(1, 'Kerala Handicrafts', 'Cr', 150000, 'Receipt', { bill_reference: 'ADV-01' }),
        leg(2, 'Kerala Handicrafts', 'Dr', 212400, 'Sales', { bill_reference: 'INV-009' }),
        leg(2, 'Sales', 'Cr', 212400, 'Sales', { bill_reference: 'INV-009' }),
      ],
    };
    const result = score(
      [
        voucher('Receipt', [entry('HDFC Bank — 1234', 'Dr', 150000), entry('Kerala Handicrafts', 'Cr', 150000, ['ADV-01'], 'Advance')]),
        voucher('Sales', [
          { ledgerName: 'Kerala Handicrafts', drOrCr: 'Dr', amount: 212400, billAllocations: [
            { name: 'ADV-01', amount: 150000, billType: 'Agst Ref' },
            { name: 'INV-009', amount: 62400, billType: 'New Ref' },
          ] },
          entry('Sales', 'Cr', 212400),
        ]),
      ],
      key,
    );
    expect(diffOf(result, 1, 'bill_reference')[0].is_correct).toBe(true);
    expect(diffOf(result, 2, 'bill_reference')[0].is_correct).toBe(true);
  });

  it('accepts a note by its own number or by the bill it is against, only when the key links them', () => {
    const debitNoteKey = (narration: string): AnswerKey => ({
      entries: [
        leg(1, 'Mumbai Suppliers', 'Dr', 29500, 'Debit Note', { bill_reference: 'DN-M1', narration }),
        leg(1, 'Purchase Returns', 'Cr', 29500, 'Debit Note', { bill_reference: 'DN-M1', narration }),
      ],
    });
    const debitNote = (ref: string) =>
      voucher('Debit Note', [entry('Mumbai Suppliers', 'Dr', 29500, [ref], 'Agst Ref'), entry('Purchase Returns', 'Cr', 29500)]);
    const linked = 'Being goods returned to Mumbai Suppliers vide DN-M1 against MS-B1';
    expect(diffOf(score([debitNote('MS-B1')], debitNoteKey(linked)), 1, 'bill_reference')[0].is_correct).toBe(true);
    expect(diffOf(score([debitNote('DN-M1')], debitNoteKey(linked)), 1, 'bill_reference')[0].is_correct).toBe(true);
    // Pack seq 51: the key's narration names only DN-M1.
    const unlinked = 'Being goods returned to Mumbai Suppliers vide DN-M1';
    expect(diffOf(score([debitNote('MS-B1')], debitNoteKey(unlinked)), 1, 'bill_reference')[0].error_code).toBe('BILL_REFERENCE_WRONG');
  });
});

describe('voucher pairing: best score first over all pairs', () => {
  it('pairs two equal Deccan Traders payments by their bill references when posted in swapped order', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Deccan Traders', 'Dr', 5000, 'Payment', { bill_reference: 'DT/102' }),
        leg(1, 'HDFC Bank — 1234', 'Cr', 5000, 'Payment', { bill_reference: 'DT/102' }),
        leg(2, 'Deccan Traders', 'Dr', 5000, 'Payment', { bill_reference: 'DT/103' }),
        leg(2, 'HDFC Bank — 1234', 'Cr', 5000, 'Payment', { bill_reference: 'DT/103' }),
      ],
    };
    const payment = (ref: string) => voucher('Payment', [entry('Deccan Traders', 'Dr', 5000, [ref]), entry('HDFC Bank — 1234', 'Cr', 5000)]);
    const result = score([payment('DT/103'), payment('DT/102')], key);
    expect(result.per_voucher_diffs.every((diff) => diff.is_correct)).toBe(true);
  });

  it('an omitted sale does not steal the same party\'s receipt', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Mysore Decor', 'Dr', 49560, 'Sales', { bill_reference: 'INV-018' }),
        leg(1, 'Sales', 'Cr', 49560, 'Sales', { bill_reference: 'INV-018' }),
        leg(2, 'HDFC Bank — 1234', 'Dr', 49560, 'Receipt', { bill_reference: 'INV-018' }),
        leg(2, 'Mysore Decor', 'Cr', 49560, 'Receipt', { bill_reference: 'INV-018' }),
      ],
    };
    const receipt = voucher('Receipt', [entry('HDFC Bank — 1234', 'Dr', 49560), entry('Mysore Decor', 'Cr', 49560, ['INV-018'])]);
    const unrelated = voucher('Journal', [entry('Depreciation', 'Dr', 900), entry('Furniture', 'Cr', 900)]);
    const result = score([receipt, unrelated], key);
    expect(diffOf(result, 1, 'account').map((diff) => diff.error_code)).toEqual(['VOUCHER_MISSING']);
    expect(diffOf(result, 2, 'account').every((diff) => diff.is_correct)).toBe(true);
    expect(diffOf(result, 2, 'bill_reference')[0].is_correct).toBe(true);
  });

  it('treats any bank ledger as generic: an ICICI payment is not evidence for a different ICICI payment', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Vendor X', 'Dr', 7000, 'Payment'),
        leg(1, 'ICICI Bank', 'Cr', 7000, 'Payment'),
        leg(2, 'Vendor Y', 'Dr', 9000, 'Payment'),
        leg(2, 'ICICI Bank', 'Cr', 9000, 'Payment'),
      ],
    };
    const paymentY = voucher('Payment', [entry('Vendor Y', 'Dr', 9000), entry('ICICI Bank', 'Cr', 9000)]);
    const unrelated = voucher('Journal', [entry('Depreciation', 'Dr', 900), entry('Furniture', 'Cr', 900)]);
    const result = score([paymentY, unrelated], key);
    expect(diffOf(result, 1, 'account').map((diff) => diff.error_code)).toEqual(['VOUCHER_MISSING']);
    expect(diffOf(result, 2, 'account').every((diff) => diff.is_correct)).toBe(true);
  });
});

describe('custom voucher types are judged by their base type', () => {
  it('maps a custom name that names exactly one base type', () => {
    expect(baseVoucherType('GST Sales')).toBe('sales');
    expect(baseVoucherType('Sales GST')).toBe('sales');
    expect(baseVoucherType('Sales - Local')).toBe('sales');
    expect(baseVoucherType('Purchase (Import)')).toBe('purchase');
    expect(baseVoucherType('Sales Return')).toBe('credit note');
    expect(baseVoucherType('Credit Note')).toBe('credit note');
    expect(baseVoucherType('Sales Payment')).toBe('sales payment');
  });

  it('scores "GST Sales" as a Sales voucher and still applies the GST side check', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Customer A', 'Dr', 11800, 'Sales', { gst_head: 'CGST', gst_rate: 18 }),
        leg(1, 'Sales', 'Cr', 10000, 'Sales'),
        leg(1, 'Output CGST', 'Cr', 900, 'Sales', { gst_head: 'CGST', gst_rate: 9 }),
        leg(1, 'Output SGST', 'Cr', 900, 'Sales', { gst_head: 'SGST', gst_rate: 9 }),
      ],
    };
    const sale = (tax: string) =>
      voucher('GST Sales', [entry('Customer A', 'Dr', 11800), entry('Sales', 'Cr', 10000), entry(`${tax} CGST`, 'Cr', 900), entry(`${tax} SGST`, 'Cr', 900)]);
    const right = score([sale('Output')], key);
    expect(diffOf(right, 1, 'voucher_type')[0].is_correct).toBe(true);
    expect(diffOf(right, 1, 'gst')[0].is_correct).toBe(true);
    const wrongSide = score([sale('Input')], key);
    expect(diffOf(wrongSide, 1, 'gst')[0].error_code).toBe('GST_HEAD_WRONG');
  });
});

describe('weights: skipping never scores better than attempting', () => {
  const key: AnswerKey = {
    entries: [
      leg(1, 'Rent', 'Dr', 20000, 'Payment'),
      leg(1, 'HDFC Bank — 1234', 'Cr', 20000, 'Payment'),
      leg(2, 'Kingston Traders', 'Dr', 8000, 'Payment'),
      leg(2, 'HDFC Bank — 1234', 'Cr', 8000, 'Payment'),
    ],
  };
  const rentPayment = (ledger: string) => voucher('Payment', [entry(ledger, 'Dr', 20000), entry('HDFC Bank — 1234', 'Cr', 20000)]);
  const kingston = voucher('Payment', [entry('Kingston Traders', 'Dr', 8000), entry('HDFC Bank — 1234', 'Cr', 8000)]);

  it('a missing voucher costs the full weight of the transaction', () => {
    const missing = score([kingston, voucher('Journal', [entry('Depreciation', 'Dr', 1), entry('Furniture', 'Cr', 1)])], key);
    const missingDiff = diffOf(missing, 1, 'account')[0];
    expect(missingDiff.error_code).toBe('VOUCHER_MISSING');
    // 2 legs x (account + side + amount) + type + GST(2) + TDS(2) + bill reference
    expect(missingDiff.weight).toBe(12);
  });

  it('a wrong expense ledger scores better than leaving the voucher out, and is charged once', () => {
    const attempted = score([rentPayment('Printing & Stationery'), kingston], key);
    const skipped = score([kingston, voucher('Journal', [entry('Depreciation', 'Dr', 1), entry('Furniture', 'Cr', 1)])], key);
    expect(attempted.weighted_score).toBeGreaterThan(skipped.weighted_score);
    const flagged = attempted.per_voucher_diffs.filter((diff) => !diff.is_correct);
    expect(flagged.map((diff) => `${diff.field}:${diff.error_code}`)).toEqual(['account:ACCOUNT_WRONG']);
    const notScored = attempted.per_voucher_diffs.filter((diff) => diff.voucherRef === 1 && diff.leg === 0 && diff.field !== 'account');
    expect(notScored.map((diff) => diff.weight)).toEqual([0, 0]);
    expect(attempted.concept_results.find((result) => result.concept_tag === 'payment_voucher_basics')?.result).toBe('fail');
  });

  it('checks the amount on a party whose name contains "gst" (Kingston Traders)', () => {
    const wrongAmount = voucher('Payment', [entry('Kingston Traders', 'Dr', 8500), entry('HDFC Bank — 1234', 'Cr', 8500)]);
    const result = score([rentPayment('Rent'), wrongAmount], key);
    const partyAmount = diffOf(result, 2, 'amount').find((diff) => diff.leg === 0);
    expect(partyAmount?.error_code).toBe('AMOUNT_WRONG');
    expect(partyAmount?.vacuously_correct).toBeUndefined();
  });
});

describe('typo tolerance respects the key\'s own accounts', () => {
  it('does not accept Mehta Traders for Mehra Traders when both are parties of the batch', () => {
    const key: AnswerKey = {
      entries: [
        leg(1, 'Mehra Traders', 'Dr', 4000, 'Payment'),
        leg(1, 'HDFC Bank — 1234', 'Cr', 4000, 'Payment'),
        leg(2, 'Mehta Traders', 'Dr', 6000, 'Payment'),
        leg(2, 'HDFC Bank — 1234', 'Cr', 6000, 'Payment'),
      ],
    };
    const result = score(
      [
        voucher('Payment', [entry('Mehta Traders', 'Dr', 4000), entry('HDFC Bank — 1234', 'Cr', 4000)]),
        voucher('Payment', [entry('Mehta Traders', 'Dr', 6000), entry('HDFC Bank — 1234', 'Cr', 6000)]),
      ],
      key,
    );
    expect(diffOf(result, 1, 'account').some((diff) => diff.error_code === 'ACCOUNT_WRONG')).toBe(true);
    expect(diffOf(result, 2, 'account').every((diff) => diff.is_correct)).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';
import {
  applyDocumentsMode,
  checkMonthEndNoteDetails,
  buildSalesInvoiceContent,
  documentTypeForVoucher,
  isDocumentsModeUnlocked,
  isAiaOnboardingDue,
} from './documents-mode';
import { planSourceDocuments } from './generate-exercise';

type Entry = GeneratedExercise['answer_key']['entries'][number];

function leg(
  sequence: number,
  voucherType: string,
  account: string,
  drCr: 'Dr' | 'Cr',
  amount: number,
  extra: Partial<Entry> = {},
): Entry {
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
    concept_tags: ['sales_voucher_basics'] as ConceptTag[],
    requires_source_document: false,
    source_document_type: null,
    ...extra,
  };
}

const COMPANY = 'Blossom Retail Pvt Ltd';

// A realistic March batch shape: credit sale, cash sale, purchase, receipt,
// contra, rent accrual journal, debit note.
function batch(): GeneratedExercise {
  const ref = (value: string) => ({ bill_reference: value });
  return {
    scenario: 'Batch: same company, continuing.',
    transactions: [
      { sequence: 1, description: 'On 03-Mar-2025, you raise Sales Invoice INV-062 to Karnataka Emporium (Karnataka) for goods worth Rs 60,000 plus CGST Rs 5,400 and SGST Rs 5,400, total Rs 70,800, on credit.' },
      { sequence: 2, description: 'On 05-Mar-2025, you make a cash counter sale of Rs 2,000 plus CGST Rs 180 and SGST Rs 180, total Rs 2,360.' },
      { sequence: 3, description: 'On 07-Mar-2025, an invoice arrived from Mumbai Suppliers (Ref MS-975): post it from the attached invoice.' },
      { sequence: 4, description: 'On 09-Mar-2025, a receipt from Karnataka Emporium against bill INV-031 landed in the bank: post it from the bank statement.' },
      { sequence: 5, description: 'On 11-Mar-2025, cash is deposited into the bank: post it from the bank statement.' },
      { sequence: 6, description: 'On 15-Mar-2025, you accrue March office rent of Rs 25,000 that remains unpaid, posting it against Outstanding Expenses.' },
      { sequence: 7, description: 'On 20-Mar-2025, Deccan Traders accepts a return of goods from bill DT-501: base value Rs 8,000 plus CGST Rs 720 and SGST Rs 720, total Rs 9,440.' },
    ],
    difficulty_level: 'L4',
    variant: 'A',
    answer_key: {
      entries: [
        leg(1, 'Sales', 'Karnataka Emporium', 'Dr', 70800, ref('INV-062 (New Ref)')),
        leg(1, 'Sales', 'Sales', 'Cr', 60000, ref('INV-062 (New Ref)')),
        leg(1, 'Sales', 'Output CGST', 'Cr', 5400, { ...ref('INV-062 (New Ref)'), gst_head: 'CGST' }),
        leg(1, 'Sales', 'Output SGST', 'Cr', 5400, { ...ref('INV-062 (New Ref)'), gst_head: 'SGST' }),
        leg(2, 'Sales', 'Cash', 'Dr', 2360),
        leg(2, 'Sales', 'Sales', 'Cr', 2000),
        leg(2, 'Sales', 'Output CGST', 'Cr', 180, { gst_head: 'CGST' }),
        leg(2, 'Sales', 'Output SGST', 'Cr', 180, { gst_head: 'SGST' }),
        leg(3, 'Purchase', 'Purchases', 'Dr', 50000, { ...ref('MS-975 (New Ref)'), requires_source_document: true, source_document_type: 'vendor_invoice' }),
        leg(3, 'Purchase', 'Input IGST', 'Dr', 9000, { ...ref('MS-975 (New Ref)'), gst_head: 'IGST', requires_source_document: true, source_document_type: 'vendor_invoice' }),
        leg(3, 'Purchase', 'Mumbai Suppliers', 'Cr', 59000, { ...ref('MS-975 (New Ref)'), requires_source_document: true, source_document_type: 'vendor_invoice' }),
        leg(4, 'Receipt', 'HDFC Bank — 1234', 'Dr', 40000, { ...ref('INV-031 (part payment)'), requires_source_document: true, source_document_type: 'bank_statement' }),
        leg(4, 'Receipt', 'Karnataka Emporium', 'Cr', 40000, { ...ref('INV-031 (part payment)'), requires_source_document: true, source_document_type: 'bank_statement' }),
        leg(5, 'Contra', 'HDFC Bank — 1234', 'Dr', 4000),
        leg(5, 'Contra', 'Cash', 'Cr', 4000),
        leg(6, 'Journal', 'Rent', 'Dr', 25000),
        leg(6, 'Journal', 'Outstanding Expenses', 'Cr', 25000),
        leg(7, 'Debit Note', 'Deccan Traders', 'Dr', 9440, ref('DT-501 (part return)')),
        leg(7, 'Debit Note', 'Purchase Returns', 'Cr', 8000, ref('DT-501 (part return)')),
        leg(7, 'Debit Note', 'Input CGST', 'Cr', 720, { ...ref('DT-501 (part return)'), gst_head: 'CGST' }),
        leg(7, 'Debit Note', 'Input SGST', 'Cr', 720, { ...ref('DT-501 (part return)'), gst_head: 'SGST' }),
      ],
    },
  };
}

describe('documents mode unlock', () => {
  it('unlocks at three mastered concepts', () => {
    expect(isDocumentsModeUnlocked([{ status: 'mastered' }, { status: 'mastered' }, { status: 'developing' }])).toBe(false);
    expect(isDocumentsModeUnlocked([{ status: 'mastered' }, { status: 'mastered' }, { status: 'mastered' }])).toBe(true);
  });
});

describe('documentTypeForVoucher', () => {
  it('maps every voucher type to the paperwork it arrives as', () => {
    expect(documentTypeForVoucher('Purchase')).toBe('vendor_invoice');
    expect(documentTypeForVoucher('Sales')).toBe('sales_invoice');
    expect(documentTypeForVoucher('Receipt')).toBe('bank_statement');
    expect(documentTypeForVoucher('Payment')).toBe('bank_statement');
    expect(documentTypeForVoucher('Contra')).toBe('bank_statement');
    expect(documentTypeForVoucher('Journal')).toBe('month_end_note');
    expect(documentTypeForVoucher('Debit Note')).toBe('month_end_note');
  });
});

describe('buildSalesInvoiceContent', () => {
  it('reads the invoice figures off the legs exactly', () => {
    const legs = batch().answer_key.entries.filter((e) => e.sequence === 1);
    const content = buildSalesInvoiceContent(legs, batch().transactions[0].description, COMPANY);
    expect(content.buyerName).toBe('Karnataka Emporium');
    expect(content.invoiceNumber).toBe('INV-062');
    expect(content.invoiceDate).toBe('03-Mar-2025');
    expect(content.isCashMemo).toBe(false);
    expect(content.lineItems).toEqual([{ description: 'Trading goods as per order', quantity: 1, rate: 60000, amount: 60000 }]);
    expect(content.taxBreakup).toEqual({ cgst_amount: 5400, sgst_amount: 5400, igst_amount: null });
    expect(content.totalAmount).toBe(70800);
    expect(content.placeOfSupply).toBe('Karnataka');
    expect(content.sellerName).toBe(COMPANY);
  });

  it('turns a cash sale into a cash memo with a generated number', () => {
    const legs = batch().answer_key.entries.filter((e) => e.sequence === 2);
    const content = buildSalesInvoiceContent(legs, batch().transactions[1].description, COMPANY);
    expect(content.isCashMemo).toBe(true);
    expect(content.buyerName).toBe('Cash (walk-in customer)');
    expect(content.invoiceNumber).toBe('CM-250305-02');
    expect(content.totalAmount).toBe(2360);
  });

  it('refuses legs that do not add up', () => {
    const legs = batch().answer_key.entries.filter((e) => e.sequence === 1).map((e) => (e.correct_account === 'Sales' ? { ...e, amount: 59000 } : e));
    expect(() => buildSalesInvoiceContent(legs, batch().transactions[0].description, COMPANY)).toThrow(/do not add up/);
  });
});

describe('applyDocumentsMode', () => {
  const plan = applyDocumentsMode(batch(), { companyName: COMPANY, monthLabel: 'March 2025' });

  it('marks every transaction document-backed with the right type', () => {
    const byType = new Map<number, string | null>();
    for (const entry of plan.generated.answer_key.entries) byType.set(entry.sequence, entry.source_document_type);
    expect([...byType.entries()]).toEqual([
      [1, 'sales_invoice'], [2, 'sales_invoice'], [3, 'vendor_invoice'], [4, 'bank_statement'],
      [5, 'bank_statement'], [6, 'month_end_note'], [7, 'month_end_note'],
    ]);
    expect(plan.generated.answer_key.entries.every((entry) => entry.requires_source_document)).toBe(true);
  });

  it('rewrites every brief line as a dated pointer with no figures', () => {
    for (const transaction of plan.generated.transactions) {
      expect(transaction.description).toMatch(/^On \d{2}-Mar-2025, /);
      expect(transaction.description).not.toMatch(/Rs\s?[\d,]+|₹|\d+\s?%/);
    }
    const lines = plan.generated.transactions.map((t) => t.description);
    expect(lines[0]).toBe('On 03-Mar-2025, you raised Sales Invoice INV-062 on Karnataka Emporium: post it from the attached sales invoice.');
    expect(lines[1]).toBe('On 05-Mar-2025, a counter sale was made for cash: post it from the attached cash memo.');
    expect(lines[2]).toBe('On 07-Mar-2025, an invoice arrived from Mumbai Suppliers (Ref MS-975): post it from the attached invoice.');
    expect(lines[3]).toBe('On 09-Mar-2025, a receipt from Karnataka Emporium against bill INV-031 landed in the bank: post it from the bank statement.');
    expect(lines[4]).toBe('On 11-Mar-2025, cash was deposited into the bank: post it from the bank statement.');
    expect(lines[5]).toBe('On 15-Mar-2025, post month-end note 1 from the attached Month-end Notes document.');
    expect(lines[6]).toBe('On 20-Mar-2025, post month-end note 2 from the attached Month-end Notes document.');
  });

  it('moves the journal wording, figures included, onto the notes sheet', () => {
    expect(plan.monthEndNotes).not.toBeNull();
    expect(plan.monthEndNotes?.period).toBe('March 2025');
    expect(plan.monthEndNotes?.notes.map((n) => n.number)).toEqual([1, 2]);
    expect(plan.monthEndNotes?.notes[0].text).toContain('Rs 25,000');
    expect(plan.monthEndNotes?.notes[1].text).toContain('DT-501');
  });

  it('builds one sales document per sale and leaves the answer key figures untouched', () => {
    expect(plan.salesInvoices.map((s) => s.sequence)).toEqual([1, 2]);
    expect(plan.generated.answer_key.entries.map((e) => e.amount)).toEqual(batch().answer_key.entries.map((e) => e.amount));
    expect(plan.generated.scenario).toContain('Documents mode');
  });

  it('ships one sales register CSV carrying the same figures as the sales invoices', () => {
    expect(plan.salesRegister?.period).toBe('March 2025');
    expect(plan.salesRegister?.rows.map((r) => [r.invoiceNumber, r.customerName, r.taxableValue, r.cgst, r.sgst, r.igst, r.total])).toEqual([
      ['INV-062', 'Karnataka Emporium', 60000, 5400, 5400, 0, 70800],
      ['CM-250305-02', 'Cash (walk-in customer)', 2000, 180, 180, 0, 2360],
    ]);
    expect(plan.generated.scenario).toContain('sales register CSV');
    // A batch with no sale ships no register.
    const noSales = { ...batch(), transactions: batch().transactions.filter((t) => t.sequence > 2), answer_key: { entries: batch().answer_key.entries.filter((e) => e.sequence > 2) } };
    expect(applyDocumentsMode(noSales, { companyName: COMPANY, monthLabel: 'March 2025' }).salesRegister).toBeNull();
  });

  it('keeps the invoice generator and the statement builder on their own document types', () => {
    const sourcePlan = planSourceDocuments(plan.generated);
    expect(sourcePlan.invoices.map((i) => i.legs[0].sequence)).toEqual([3]);
    expect(sourcePlan.bankLines.map((l) => l.entry.sequence)).toEqual([4, 5]);
  });
});

describe('checkMonthEndNoteDetails', () => {
  it('passes when every journal-type line states its figures', () => {
    expect(checkMonthEndNoteDetails(batch())).toBe(null);
  });

  it('rejects a journal written as a figure-less pointer', () => {
    const generated = batch();
    generated.transactions[5].description = 'On 15-Mar-2025, accrue the March rent: post it from the notes.';
    expect(checkMonthEndNoteDetails(generated)).toMatch(/transaction 6 is a journal-type entry/);
  });
});

describe('isAiaOnboardingDue', () => {
  const mastered = [{ status: 'mastered' }, { status: 'mastered' }, { status: 'mastered' }];
  it('is due once the walkthrough is done, documents mode is unlocked and the flow has not been completed', () => {
    expect(isAiaOnboardingDue({ walkthroughCompleted: true, aiaOnboardingCompletedAt: null, mastery: mastered })).toBe(true);
  });
  it('is not due before the first-day walkthrough, below the threshold, or after completion', () => {
    expect(isAiaOnboardingDue({ walkthroughCompleted: false, aiaOnboardingCompletedAt: null, mastery: mastered })).toBe(false);
    expect(isAiaOnboardingDue({ walkthroughCompleted: true, aiaOnboardingCompletedAt: null, mastery: mastered.slice(0, 2) })).toBe(false);
    expect(isAiaOnboardingDue({ walkthroughCompleted: true, aiaOnboardingCompletedAt: '2026-09-09T05:00:00Z', mastery: mastered })).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import type { AnswerKey, ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';
import { extractTransactionDate } from '@/lib/llm/prompts/source-document';
import { applyBankReferences, buildBankStatementContent } from '@/lib/documents/build-bank-statement';
import { applyDocumentsMode } from './documents-mode';
import { appendMonthEndJournals } from './month-end-journals';
import { planSourceDocuments } from './generate-exercise';
import {
  checkDatesExist,
  checkEducationalDates,
  educationalDateLabels,
  educationalDayFor,
  educationalDaysFor,
  enforceEducationalDates,
  isEducationalDay,
  parseMonthLabel,
  redateDescription,
  redateForEducationalMode,
} from './educational-dates';

type Entry = GeneratedExercise['answer_key']['entries'][number];

function leg(sequence: number, voucherType: string, account: string, drCr: 'Dr' | 'Cr', amount: number, extra: Partial<Entry> = {}): Entry {
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

function batchOf(descriptions: string[], scenario = 'Batch: same company, continuing.'): GeneratedExercise {
  return {
    scenario,
    transactions: descriptions.map((description, index) => ({ sequence: index + 1, description })),
    difficulty_level: 'L1',
    variant: 'A',
    answer_key: { entries: descriptions.flatMap((_, index) => [leg(index + 1, 'Contra', 'HDFC Bank — 1234', 'Dr', 100), leg(index + 1, 'Contra', 'Cash', 'Cr', 100)]) },
  };
}

const MAY_2024 = { monthIndex: 4, year: 2024 };
const JUNE_2024 = { monthIndex: 5, year: 2024 };

describe('educationalDaysFor / isEducationalDay', () => {
  it('allows 1, 2 and 31 in a 31-day month, including December', () => {
    expect(educationalDaysFor(4, 2024)).toEqual([1, 2, 31]);
    expect(educationalDaysFor(11, 2024)).toEqual([1, 2, 31]);
    expect(educationalDaysFor(0, 2025)).toEqual([1, 2, 31]);
  });

  it('allows only 1 and 2 in April, June, September, November and February (leap or not)', () => {
    for (const monthIndex of [3, 5, 8, 10]) expect(educationalDaysFor(monthIndex, 2024)).toEqual([1, 2]);
    expect(educationalDaysFor(1, 2024)).toEqual([1, 2]);
    expect(educationalDaysFor(1, 2025)).toEqual([1, 2]);
    expect(educationalDaysFor(1, 2028)).toEqual([1, 2]);
  });

  it('never allows the last day of a short month', () => {
    expect(isEducationalDay(30, 5, 2024)).toBe(false);
    expect(isEducationalDay(29, 1, 2024)).toBe(false);
    expect(isEducationalDay(28, 1, 2025)).toBe(false);
    expect(isEducationalDay(31, 4, 2024)).toBe(true);
    expect(isEducationalDay(2, 5, 2024)).toBe(true);
    expect(isEducationalDay(15, 4, 2024)).toBe(false);
  });
});

describe('educationalDayFor', () => {
  it('maps 1 to 1, 2..16 to 2 and 17..31 to 31 in a 31-day month', () => {
    expect(educationalDayFor(1, 4, 2024)).toBe(1);
    expect(educationalDayFor(2, 4, 2024)).toBe(2);
    expect(educationalDayFor(16, 4, 2024)).toBe(2);
    expect(educationalDayFor(17, 4, 2024)).toBe(31);
    expect(educationalDayFor(31, 4, 2024)).toBe(31);
    expect(educationalDayFor(31, 11, 2024)).toBe(31);
  });

  it('maps 17 onwards to 2 when the month has no 31st, leap February included', () => {
    expect(educationalDayFor(17, 5, 2024)).toBe(2);
    expect(educationalDayFor(30, 5, 2024)).toBe(2);
    expect(educationalDayFor(29, 1, 2024)).toBe(2);
    expect(educationalDayFor(28, 1, 2025)).toBe(2);
    expect(educationalDayFor(29, 1, 2028)).toBe(2);
  });

  it('is monotonic non-decreasing across every day of every month of a leap and a common year', () => {
    for (const year of [2024, 2025, 2028]) {
      for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
        let previous = 0;
        for (let day = 1; day <= 31; day++) {
          const mapped = educationalDayFor(day, monthIndex, year);
          expect(mapped).toBeGreaterThanOrEqual(previous);
          expect(isEducationalDay(mapped, monthIndex, year)).toBe(true);
          previous = mapped;
        }
      }
    }
  });
});

describe('educationalDateLabels / parseMonthLabel', () => {
  it('formats the allowed dates of the month', () => {
    expect(educationalDateLabels(MAY_2024)).toEqual(['01-May-2024', '02-May-2024', '31-May-2024']);
    expect(educationalDateLabels({ monthIndex: 1, year: 2028 })).toEqual(['01-Feb-2028', '02-Feb-2028']);
  });

  it('parses the batch month label', () => {
    expect(parseMonthLabel('June 2024')).toEqual(JUNE_2024);
    expect(parseMonthLabel('December 2025')).toEqual({ monthIndex: 11, year: 2025 });
    expect(parseMonthLabel('Junee 2024')).toBeNull();
  });
});

describe('redateDescription', () => {
  it('rewrites a named-month date and keeps its exact style', () => {
    expect(redateDescription('On 15-May-2024, paid rent.', MAY_2024)).toBe('On 02-May-2024, paid rent.');
    expect(redateDescription('On 20 May 2024, paid rent.', MAY_2024)).toBe('On 31 May 2024, paid rent.');
    expect(redateDescription('On 5/May/2024, paid rent.', MAY_2024)).toBe('On 2/May/2024, paid rent.');
    expect(redateDescription('On 9 May 2024, paid.', MAY_2024)).toBe('On 2 May 2024, paid.');
    expect(redateDescription('On 18 MAY 2024, paid.', MAY_2024)).toBe('On 31 MAY 2024, paid.');
  });

  it('rewrites numeric DD-MM-YYYY and DD/MM/YYYY dates, keeping padding and separators', () => {
    expect(redateDescription('On 15/05/2024, sold goods.', MAY_2024)).toBe('On 02/05/2024, sold goods.');
    expect(redateDescription('On 25-5-2024, sold goods.', MAY_2024)).toBe('On 31-5-2024, sold goods.');
    expect(redateDescription('On 7/6/2024, sold goods.', JUNE_2024)).toBe('On 2/6/2024, sold goods.');
  });

  it('maps a 30-day month onto 1 and 2 only, and fixes an impossible 31-Jun', () => {
    expect(redateDescription('On 30-Jun-2024, contra.', JUNE_2024)).toBe('On 02-Jun-2024, contra.');
    expect(redateDescription('On 31-Jun-2024, contra.', JUNE_2024)).toBe('On 02-Jun-2024, contra.');
    expect(redateDescription('On 01-Jun-2024, contra.', JUNE_2024)).toBe('On 01-Jun-2024, contra.');
  });

  it('leaves tokens of other months and years, and bare month mentions, untouched', () => {
    const text = 'On 15-May-2024, settle the 12-Apr-2024 bill, the March invoice and 20-May-2025.';
    expect(redateDescription(text, MAY_2024)).toBe('On 02-May-2024, settle the 12-Apr-2024 bill, the March invoice and 20-May-2025.');
  });

  it('rewrites every in-scope token in one text', () => {
    expect(redateDescription('Between 03-May-2024 and 19/05/2024.', MAY_2024)).toBe('Between 02-May-2024 and 31/05/2024.');
  });

  it('with no month, maps each token within its own month (the diagnostic fallback)', () => {
    expect(redateDescription('On 15-Apr-2024 and 20-May-2024 and 29-Feb-2024 and 31-Dec-2024.', null)).toBe(
      'On 02-Apr-2024 and 31-May-2024 and 02-Feb-2024 and 31-Dec-2024.',
    );
  });

  it('is idempotent on allowed dates', () => {
    const text = 'On 01-May-2024, 02-May-2024 and 31-May-2024.';
    expect(redateDescription(text, MAY_2024)).toBe(text);
  });
});

describe('redateForEducationalMode', () => {
  it('redates transactions, scenario prose and narrations, and nothing else', () => {
    const generated = batchOf(['On 12-Jun-2024, deposit cash.', 'On 28-Jun-2024, withdraw cash.'], 'Batch.\n1. On 12-Jun-2024, deposit cash.');
    generated.answer_key.entries[0] = { ...generated.answer_key.entries[0], narration: 'Deposit on 12-Jun-2024' };
    const redated = redateForEducationalMode(generated, JUNE_2024);
    expect(redated.transactions.map((t) => t.description)).toEqual(['On 02-Jun-2024, deposit cash.', 'On 02-Jun-2024, withdraw cash.']);
    expect(redated.scenario).toBe('Batch.\n1. On 02-Jun-2024, deposit cash.');
    expect(redated.answer_key.entries[0].narration).toBe('Deposit on 02-Jun-2024');
    expect(redated.answer_key.entries.map((e) => [e.sequence, e.amount])).toEqual(generated.answer_key.entries.map((e) => [e.sequence, e.amount]));
    // The input is not mutated.
    expect(generated.transactions[0].description).toBe('On 12-Jun-2024, deposit cash.');
  });
});

describe('checkEducationalDates', () => {
  it('lists every transaction dated on a day Educational Mode will not save', () => {
    const generated = batchOf(['On 01-May-2024, a.', 'On 02-May-2024, b.', 'On 31-May-2024, c.', 'On 15-May-2024, d.', 'On 30/05/2024, e.']);
    const error = checkEducationalDates(generated, MAY_2024);
    expect(error).toContain('transaction 4 is dated 15-May-2024');
    expect(error).toContain('transaction 5 is dated 30/05/2024');
    expect(error).toContain('Educational Mode only saves 01, 02 and 31');
    expect(error).not.toContain('transaction 1');
    expect(error).not.toContain('transaction 3');
  });

  it('rejects the 30th of June and the 29th of a leap February, the last days of their months', () => {
    expect(checkEducationalDates(batchOf(['On 30-Jun-2024, a.']), JUNE_2024)).toContain('transaction 1 is dated 30-Jun-2024');
    expect(checkEducationalDates(batchOf(['On 29-Feb-2024, a.']), { monthIndex: 1, year: 2024 })).toContain('29-Feb-2024');
  });

  it('passes an all-allowed batch and ignores tokens of other months when a month is given', () => {
    expect(checkEducationalDates(batchOf(['On 02-Jun-2024, settle the 15-May-2024 bill.']), JUNE_2024)).toBeNull();
    expect(checkEducationalDates(batchOf(['On 02-Jun-2024, settle the 15-May-2024 bill.']), null)).toContain('15-May-2024');
  });
});

describe('checkDatesExist (every learner)', () => {
  it('flags dates that do not exist', () => {
    const error = checkDatesExist(batchOf(['On 31-Jun-2024, a.', 'On 30-Feb-2024, b.', 'On 29-Feb-2025, c.', 'On 12/13/2024, d.', 'On 00-May-2024, e.']));
    expect(error).toContain('transaction 1 is dated "31-Jun-2024", but June 2024 has only 30 days');
    expect(error).toContain('transaction 2 is dated "30-Feb-2024", but February 2024 has only 29 days');
    expect(error).toContain('transaction 3 is dated "29-Feb-2025", but February 2025 has only 28 days');
    expect(error).toContain('transaction 4 is dated "12/13/2024", which has no month 13');
    expect(error).toContain('transaction 5 is dated "00-May-2024"');
  });

  it('accepts real dates, including a leap day and 31-Dec', () => {
    expect(checkDatesExist(batchOf(['On 29-Feb-2024, a.', 'On 31-Dec-2024, b.', 'On 30/06/2024, c.', 'On 15-Jun-2024, d.']))).toBeNull();
  });
});

describe('enforceEducationalDates', () => {
  it('returns a batch the check accepts, across a year rollover', () => {
    const december = enforceEducationalDates(batchOf(['On 24-Dec-2024, a.', 'On 03-Jan-2025, b.']), { monthIndex: 11, year: 2024 });
    expect(december.transactions.map((t) => t.description)).toEqual(['On 31-Dec-2024, a.', 'On 03-Jan-2025, b.']);
    const january = enforceEducationalDates(batchOf(['On 24-Dec-2024, a.', 'On 03-Jan-2025, b.']), null);
    expect(january.transactions.map((t) => t.description)).toEqual(['On 31-Dec-2024, a.', 'On 02-Jan-2025, b.']);
    expect(checkEducationalDates(january, null)).toBeNull();
  });
});

// The whole post-generation date path for an educational learner: every
// date the learner sees in a document must be one Tally Educational Mode
// will save. June has no 31st, so only the 1st and 2nd are allowed.
describe('educational post-generation pipeline produces only allowed dates', () => {
  const COMPANY = 'Blossom Retail Pvt Ltd';
  const ref = (value: string) => ({ bill_reference: value });

  function juneBatch(): GeneratedExercise {
    return {
      scenario: 'Batch: same company, continuing.',
      transactions: [
        { sequence: 1, description: 'On 04-Jun-2024, you raise Sales Invoice INV-062 to Karnataka Emporium (Karnataka) for goods worth Rs 60,000 plus CGST Rs 5,400 and SGST Rs 5,400, total Rs 70,800, on credit.' },
        { sequence: 2, description: 'On 09-Jun-2024, you make a cash counter sale of Rs 2,000 plus CGST Rs 180 and SGST Rs 180, total Rs 2,360.' },
        { sequence: 3, description: 'On 14-Jun-2024, an invoice arrived from Mumbai Suppliers (Ref MS-975): post it from the attached invoice.' },
        { sequence: 4, description: 'On 19-Jun-2024, a receipt from Karnataka Emporium against bill INV-062 landed in the bank: post it from the bank statement.' },
        { sequence: 5, description: 'On 23/06/2024, cash is deposited into the bank: post it from the bank statement.' },
        { sequence: 6, description: 'On 30-Jun-2024, you accrue June office rent of Rs 25,000 that remains unpaid, posting it against Outstanding Expenses.' },
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
          leg(4, 'Receipt', 'HDFC Bank — 1234', 'Dr', 40000, { ...ref('INV-062 (part payment)'), requires_source_document: true, source_document_type: 'bank_statement' }),
          leg(4, 'Receipt', 'Karnataka Emporium', 'Cr', 40000, { ...ref('INV-062 (part payment)'), requires_source_document: true, source_document_type: 'bank_statement' }),
          leg(5, 'Contra', 'HDFC Bank — 1234', 'Dr', 2000),
          leg(5, 'Contra', 'Cash', 'Cr', 2000),
          leg(6, 'Journal', 'Rent', 'Dr', 25000),
          leg(6, 'Journal', 'Outstanding Expenses', 'Cr', 25000),
        ],
      },
    };
  }

  const priorKeys: AnswerKey[] = [{ opening_balances: [{ account: 'GST Payable', dr_cr: 'Cr', amount: 4000 }], entries: [] }];
  const allowedDays = new Set(educationalDaysFor(JUNE_2024.monthIndex, JUNE_2024.year));

  function runPipeline() {
    const withJournals = appendMonthEndJournals(juneBatch(), {
      priorKeys,
      concepts: ['gst_set_off', 'gst_payment'],
      month: JUNE_2024,
      licenseMode: 'educational',
      bankAccount: 'HDFC Bank — 1234',
      bankAfterBatch: 500000,
    }).generated;
    const redated = enforceEducationalDates(withJournals, JUNE_2024);
    const documents = applyDocumentsMode(redated, { companyName: COMPANY, monthLabel: 'June 2024', priorKeys });
    const statement = buildBankStatementContent({ companyName: COMPANY, openingBankBalance: 100000, generated: documents.generated });
    const final = statement ? applyBankReferences(documents.generated, statement.referenceBySequence) : documents.generated;
    return { withJournals, redated, documents, statement, final };
  }

  const dayOf = (label: string): number => Number(/^(\d{2})-Jun-2024$/.exec(label)?.[1]);

  it('the appended month-end journals are already on allowed days', () => {
    const { withJournals } = runPipeline();
    const appended = withJournals.transactions.slice(-2).map((t) => extractTransactionDate(t.description)?.day);
    expect(appended).toEqual([2, 2]);
  });

  it('every transaction line, sales invoice, cash memo, vendor invoice source and month-end note is on an allowed day', () => {
    const { redated, documents, final } = runPipeline();
    for (const transaction of [...redated.transactions, ...final.transactions]) {
      const date = extractTransactionDate(transaction.description);
      expect(date).not.toBeNull();
      expect(allowedDays.has(date!.day)).toBe(true);
    }
    expect(documents.salesInvoices).toHaveLength(2);
    for (const { content } of documents.salesInvoices) {
      expect(allowedDays.has(dayOf(content.invoiceDate))).toBe(true);
    }
    const cashMemo = documents.salesInvoices.find((sale) => sale.content.isCashMemo);
    expect(cashMemo?.content.invoiceNumber).toBe('CM-240602-02');
    for (const row of documents.salesRegister?.rows ?? []) {
      expect(allowedDays.has(dayOf(row.invoiceDate))).toBe(true);
    }
    for (const note of documents.monthEndNotes?.notes ?? []) {
      expect(allowedDays.has(dayOf(note.date))).toBe(true);
    }
    const vendorInvoices = planSourceDocuments(final).invoices;
    expect(vendorInvoices).toHaveLength(1);
    expect(extractTransactionDate(vendorInvoices[0].transactionDescription)?.day).toBe(2);
  });

  it('every bank statement row and every reference yymmdd stamp is on an allowed day, in a consistent order', () => {
    const { statement, final } = runPipeline();
    expect(statement).not.toBeNull();
    const rows = statement!.content.transactions;
    // Receipt, contra deposit and the GST payment.
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(allowedDays.has(dayOf(row.date))).toBe(true);
      const stamp = /\/(?:N|CD|CW)(\d{2})(\d{2})(\d{2})\d{2}\//.exec(row.narration);
      expect(stamp).not.toBeNull();
      expect(stamp![1]).toBe('24');
      expect(stamp![2]).toBe('06');
      expect(allowedDays.has(Number(stamp![3]))).toBe(true);
    }
    expect(statement!.content.period).toBe('02-Jun-2024 to 02-Jun-2024');
    // The running balance still walks the rows exactly.
    expect(rows.map((row) => row.balance)).toEqual([140000, 142000, 138000]);
    // The key's narrations carry the same stamped references.
    for (const reference of statement!.referenceBySequence.values()) {
      expect(final.answer_key.entries.some((entry) => entry.narration?.includes(reference))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------- 2026-09-17 audit

import { checkCanonicalDateFormat, dateTokensIn } from './educational-dates';

describe('identifiers are never redated (2026-09-17 audit)', () => {
  it('leaves date-shaped runs inside document numbers alone', () => {
    const text = 'On 15-Jun-2024, bills MS/12/06/2024, KE/15-06-2024 and INV-12-Jun-2024 arrived, and Invoice No. 17 Jun 2024.';
    expect(redateDescription(text, JUNE_2024)).toBe(
      'On 02-Jun-2024, bills MS/12/06/2024, KE/15-06-2024 and INV-12-Jun-2024 arrived, and Invoice No. 17 Jun 2024.',
    );
    expect(dateTokensIn(text).filter((token) => token.embedded)).toHaveLength(4);
  });
});

describe('other date shapes are recognised and redated (2026-09-17 audit)', () => {
  it('handles "5th June 2024", "June 5, 2024", "2024-06-05", "05.06.2024" and "15/06/24"', () => {
    expect(redateDescription('On 5th June 2024, paid.', JUNE_2024)).toBe('On 2nd June 2024, paid.');
    expect(redateDescription('On June 5, 2024, paid.', JUNE_2024)).toBe('On June 2, 2024, paid.');
    expect(redateDescription('On 2024-06-05, paid.', JUNE_2024)).toBe('On 2024-06-02, paid.');
    expect(redateDescription('On 05.06.2024, paid.', JUNE_2024)).toBe('On 02.06.2024, paid.');
    expect(redateDescription('On 15/06/24, paid.', JUNE_2024)).toBe('On 02/06/24, paid.');
  });

  it('asserts over the scenario prose and the narrations too', () => {
    const batch = batchOf(['On 01-May-2024, contra.']);
    const withProse: GeneratedExercise = {
      ...batch,
      scenario: 'Month opens with a note dated 15-May-2024.',
      answer_key: { ...batch.answer_key, entries: batch.answer_key.entries.map((entry) => ({ ...entry, narration: 'Deposited on 20-May-2024.' })) },
    };
    const message = checkEducationalDates(withProse, MAY_2024);
    expect(message).toContain('the scenario is dated 15-May-2024');
    expect(message).toContain('the narration of transaction 1 is dated 20-May-2024');
    const redated = enforceEducationalDates(withProse, MAY_2024);
    expect(redated.scenario).toContain('02-May-2024');
    expect(redated.answer_key.entries[0].narration).toBe('Deposited on 31-May-2024.');
  });
});

describe('checkCanonicalDateFormat (2026-09-17 audit)', () => {
  it('accepts DD-Mon-YYYY only and rejects dates inside identifiers', () => {
    expect(checkCanonicalDateFormat(batchOf(['On 05-Jun-2024, paid.', 'On 5-Jun-2024, paid.']))).toBeNull();
    const message = checkCanonicalDateFormat(
      batchOf(['On June 5, 2024, paid.', 'On 05/06/2024, paid.', 'On 05-Jun-2024, bill MS/12/06/2024.'], 'Batch dated 2024-06-01.'),
    );
    expect(message).toContain('transaction 1 writes the date "June 5, 2024"');
    expect(message).toContain('transaction 2 writes the date "05/06/2024"');
    expect(message).toContain('transaction 3 has a date inside an identifier');
    expect(message).toContain('the scenario writes the date "2024-06-01"');
  });
});

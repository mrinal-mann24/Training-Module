import { describe, expect, it } from 'vitest';
import { COMPANY_DETAILS } from '@/lib/documents/company-details';
import { partyIdentityFor } from '@/lib/documents/party-directory';
import { auditDeliveredDocuments, type AuditDocument, type AuditMonth } from './document-audit';

const deccan = partyIdentityFor('Deccan Traders');
const mumbai = partyIdentityFor('Mumbai Suppliers');
const boutique = partyIdentityFor('Bengaluru Boutique');

function vendorInvoice(overrides: Record<string, unknown> = {}): AuditDocument {
  return {
    docType: 'vendor_invoice',
    data: {
      vendorName: 'Deccan Traders',
      vendorGSTIN: deccan.gstin,
      vendorAddress: deccan.address,
      invoiceNumber: 'DT/501',
      invoiceDate: '05-Jun-2025',
      lineItems: [{ description: 'Cotton fabric', quantity: 10, rate: 1000, amount: 10000 }],
      taxBreakup: { cgst_amount: 900, sgst_amount: 900, igst_amount: null },
      totalAmount: 11800,
      buyerName: COMPANY_DETAILS.name,
      buyerGSTIN: COMPANY_DETAILS.gstin,
      buyerAddress: COMPANY_DETAILS.address,
      ...overrides,
    },
  };
}

function salesInvoice(overrides: Record<string, unknown> = {}): AuditDocument {
  return {
    docType: 'sales_invoice',
    data: {
      sellerName: COMPANY_DETAILS.name,
      sellerGSTIN: COMPANY_DETAILS.gstin,
      sellerAddress: COMPANY_DETAILS.address,
      buyerName: 'Bengaluru Boutique',
      buyerGSTIN: boutique.gstin,
      buyerAddress: boutique.address,
      placeOfSupply: 'Karnataka',
      invoiceNumber: 'INV-3001',
      invoiceDate: '05-Jun-2025',
      isCashMemo: false,
      lineItems: [{ description: 'Trading goods', quantity: 1, rate: 60000, amount: 60000 }],
      taxBreakup: { cgst_amount: 5400, sgst_amount: 5400, igst_amount: null },
      totalAmount: 70800,
      ...overrides,
    },
  };
}

function bankStatement(rows: { debit: number | null; credit: number | null; balance: number }[]): AuditDocument {
  return {
    docType: 'bank_statement',
    data: { accountHolderName: COMPANY_DETAILS.name, period: 'June 2025', transactions: rows.map((row) => ({ date: '05-Jun-2025', narration: 'NEFT', ...row })) },
  };
}

function month(ordinal: number, documents: AuditDocument[], overrides: Partial<AuditMonth> = {}): AuditMonth {
  return { ordinal, exerciseId: `ex-${ordinal}`, label: `Month ${ordinal}`, source: 'planned', documents, partyNames: [], ...overrides };
}

const checksOf = (months: AuditMonth[]): string[] => auditDeliveredDocuments(months).findings.map((finding) => finding.check);

describe('auditDeliveredDocuments', () => {
  it('finds nothing wrong in documents printed from the directory', () => {
    const result = auditDeliveredDocuments([
      month(1, [vendorInvoice(), salesInvoice()], { partyNames: ['Deccan Traders', 'Bengaluru Boutique'] }),
      month(2, [vendorInvoice({ invoiceNumber: 'DT/502' }), salesInvoice({ invoiceNumber: 'INV-3002' })], { partyNames: ['Deccan Traders', 'Bengaluru Boutique'] }),
    ]);
    expect(result.findings).toEqual([]);
    expect(result.documentsChecked).toBe(4);
    expect(result.bySource.planned).toEqual({ months: 2, documents: 4, findings: 0 });
  });

  it('reports a party printed with another GST number, and lists both values for the party', () => {
    const result = auditDeliveredDocuments([
      month(1, [vendorInvoice()], { source: 'legacy' }),
      month(2, [vendorInvoice({ invoiceNumber: 'DT/502', vendorGSTIN: '29AUMCD4595H1ZX' })], { source: 'legacy' }),
    ]);
    const finding = result.findings.find((entry) => entry.check === 'PARTY_GSTIN');
    expect(finding?.ordinal).toBe(2);
    expect(finding?.message).toContain(deccan.gstin);
    const party = result.parties.find((entry) => entry.party === 'Deccan Traders');
    expect(party?.gstins.map((entry) => entry.value).sort()).toEqual(['29AUMCD4595H1ZX', deccan.gstin].sort());
    expect(result.bySource.legacy.findings).toBeGreaterThan(0);
  });

  it('reports a GST number that is not valid', () => {
    expect(checksOf([month(1, [vendorInvoice({ vendorGSTIN: '29ABCDE1234F1Z9' })])])).toContain('GSTIN_INVALID');
  });

  it('reports a party printed at another address', () => {
    expect(checksOf([month(1, [vendorInvoice({ vendorAddress: '12 Other Road, Mysuru' })])])).toEqual(['PARTY_ADDRESS']);
  });

  it('reports a number used again in a later month, and a document stored twice in one month', () => {
    expect(
      checksOf([
        month(1, [vendorInvoice()]),
        month(2, [vendorInvoice({ vendorName: 'Mumbai Suppliers', vendorGSTIN: mumbai.gstin, vendorAddress: mumbai.address, taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 1800 } })]),
      ]),
    ).toEqual(['NUMBER_REUSED']);
    expect(checksOf([month(1, [vendorInvoice(), vendorInvoice()])])).toEqual(['STORED_TWICE']);
  });

  it('reads INV-005 and INV-5 as the same number', () => {
    expect(checksOf([month(1, [salesInvoice({ invoiceNumber: 'INV-005' })]), month(2, [salesInvoice({ invoiceNumber: 'INV-5', totalAmount: 70800 })])])).toEqual(['NUMBER_REUSED']);
  });

  it('reports an invoice that does not add up', () => {
    expect(checksOf([month(1, [vendorInvoice({ totalAmount: 12000 })])])).toEqual(['ARITHMETIC']);
  });

  it('accepts a round-off line in the total', () => {
    expect(checksOf([month(1, [vendorInvoice({ totalAmount: 11800.4, roundOff: 0.4 })])])).toEqual([]);
  });

  it('reports a GST head that disagrees with the state of the printed GST number', () => {
    expect(checksOf([month(1, [vendorInvoice({ taxBreakup: { cgst_amount: null, sgst_amount: null, igst_amount: 1800 } })])])).toEqual(['GST_HEAD']);
  });

  it('reports company details that differ from the company', () => {
    const messages = auditDeliveredDocuments([month(1, [salesInvoice({ sellerGSTIN: '29AABCB1234H1Z0', sellerAddress: 'Somewhere else' })])]).findings;
    expect(messages.map((finding) => finding.check)).toEqual(['COMPANY_BLOCK', 'COMPANY_BLOCK']);
  });

  it('checks each sales register row against its invoice', () => {
    const register = (rows: Record<string, unknown>[]): AuditDocument => ({
      docType: 'sales_register',
      data: { sellerName: COMPANY_DETAILS.name, sellerGSTIN: COMPANY_DETAILS.gstin, period: 'June 2025', rows },
    });
    expect(checksOf([month(1, [salesInvoice(), register([{ invoiceNumber: 'INV-3001', customerGSTIN: boutique.gstin, total: 70800 }])])])).toEqual([]);
    expect(checksOf([month(1, [salesInvoice(), register([{ invoiceNumber: 'INV-3001', customerGSTIN: boutique.gstin, total: 70000 }])])])).toEqual(['REGISTER_ROW']);
    expect(checksOf([month(1, [salesInvoice(), register([{ invoiceNumber: 'INV-9999', customerGSTIN: boutique.gstin, total: 70800 }])])])).toEqual(['REGISTER_ROW']);
  });

  it('checks that a bank statement opens where the last one closed', () => {
    const first = bankStatement([{ debit: null, credit: 5000, balance: 105000 }]);
    const continues = bankStatement([{ debit: 2000, credit: null, balance: 103000 }]);
    const breaks = bankStatement([{ debit: 2000, credit: null, balance: 90000 }]);
    expect(checksOf([month(1, [first]), month(2, [continues])])).toEqual([]);
    const result = auditDeliveredDocuments([month(1, [first]), month(2, [breaks])]);
    expect(result.findings.map((finding) => finding.check)).toEqual(['BANK_CONTINUITY']);
    expect(result.findings[0].ordinal).toBe(2);
  });

  it('carries the closing balance across a month with no bank statement', () => {
    const first = bankStatement([{ debit: null, credit: 5000, balance: 105000 }]);
    const later = bankStatement([{ debit: 2000, credit: null, balance: 103000 }]);
    expect(checksOf([month(1, [first]), month(2, [vendorInvoice()]), month(3, [later])])).toEqual([]);
  });

  it('counts findings against the kind of month they are in', () => {
    const result = auditDeliveredDocuments([
      month(1, [vendorInvoice({ totalAmount: 12000 })], { source: 'legacy' }),
      month(2, [vendorInvoice({ invoiceNumber: 'DT/502' })], { source: 'dry-run' }),
    ]);
    expect(result.bySource.legacy.findings).toBe(1);
    expect(result.bySource['dry-run']).toEqual({ months: 1, documents: 1, findings: 0 });
  });
});

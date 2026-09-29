import { COMPANY_DETAILS } from '@/lib/documents/company-details';
import { isValidGstin, normalizePartyName, partyIdentityFor } from '@/lib/documents/party-directory';
import { canonicalRef } from '@/lib/tutor/bill-reference';

// Audit of the documents a learner has been given, across ALL their months
// (2026-09-29). The generator's checks look at one month at a time; this
// looks along the whole run: does a party carry one GST number and one
// address in every document, is a number ever printed twice, does each
// document add up, does each bank statement open where the last one closed.
// Pure: scripts/audit-delivered-documents.ts loads the rows. Read-only by
// design, it never proposes a rewrite of a delivered month.

export type MonthSource = 'pack' | 'legacy' | 'planned' | 'dry-run';

export type AuditDocument = { docType: string; data: unknown };

export type AuditMonth = {
  ordinal: number;
  exerciseId: string;
  label: string;
  source: MonthSource;
  documents: AuditDocument[];
  // Party ledger names this month's answer key posts to, in first-seen order.
  partyNames: string[];
};

export type AuditCheck =
  | 'PARTY_GSTIN'
  | 'PARTY_ADDRESS'
  | 'GSTIN_INVALID'
  | 'IDENTITY_SPLIT'
  | 'COMPANY_BLOCK'
  | 'NUMBER_REUSED'
  | 'STORED_TWICE'
  | 'ARITHMETIC'
  | 'GST_HEAD'
  | 'REGISTER_ROW'
  | 'BANK_CONTINUITY'
  | 'KEY_VS_DOCUMENT';

export type AuditFinding = { check: AuditCheck; ordinal: number; label: string; source: MonthSource; message: string };

export type PartySummary = { party: string; gstins: { value: string; months: number[] }[]; directoryGstin: string };

export type AuditResult = {
  findings: AuditFinding[];
  parties: PartySummary[];
  documentsChecked: number;
  bySource: Record<MonthSource, { months: number; documents: number; findings: number }>;
};

type LineItem = { amount?: number };
type TaxBreakup = { cgst_amount?: number | null; sgst_amount?: number | null; igst_amount?: number | null };
type Invoice = {
  vendorName?: string;
  vendorGSTIN?: string | null;
  vendorAddress?: string;
  buyerName?: string;
  buyerGSTIN?: string | null;
  buyerAddress?: string;
  sellerName?: string;
  sellerGSTIN?: string;
  sellerAddress?: string;
  invoiceNumber?: string;
  isCashMemo?: boolean;
  lineItems?: LineItem[];
  taxBreakup?: TaxBreakup;
  totalAmount?: number;
  roundOff?: number | null;
  reverseCharge?: boolean;
};
type BankStatement = { accountHolderName?: string; transactions?: { debit?: number | null; credit?: number | null; balance?: number }[] };
type SalesRegister = {
  sellerName?: string;
  sellerGSTIN?: string;
  rows?: { invoiceNumber?: string; customerName?: string; customerGSTIN?: string | null; total?: number; isCashMemo?: boolean }[];
};
type MonthEndNotes = { companyName?: string };

const TOLERANCE = 0.5;
const rupees = (value: number): string => (Math.round(value * 100) / 100).toLocaleString('en-IN');
// The generator's own identity of a number: INV-005 and INV-5 are one number.
const numberKey = (number: string): string => canonicalRef(number) ?? number.trim().toUpperCase();
const squash = (text: string | undefined | null): string => (text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

// The party a document is about: the vendor on a bill, the buyer on our own
// invoice. A cash memo has no party.
function partyOf(docType: string, invoice: Invoice): { name: string; gstin: string | null; address: string | null } | null {
  if (docType === 'vendor_invoice' && invoice.vendorName) {
    return { name: invoice.vendorName, gstin: invoice.vendorGSTIN ?? null, address: invoice.vendorAddress ?? null };
  }
  if (docType === 'sales_invoice' && invoice.buyerName && !invoice.isCashMemo) {
    return { name: invoice.buyerName, gstin: invoice.buyerGSTIN ?? null, address: invoice.buyerAddress ?? null };
  }
  return null;
}

function companyBlockProblems(docType: string, data: unknown, companyName: string): string[] {
  const problems: string[] = [];
  const sameName = (printed: string | undefined, what: string): void => {
    if (printed !== undefined && squash(printed) !== squash(companyName)) problems.push(`${what} prints the company as "${printed}", the company is "${companyName}"`);
  };
  const sameGstin = (printed: string | undefined | null, what: string): void => {
    if (printed && printed !== COMPANY_DETAILS.gstin) problems.push(`${what} prints the company GSTIN ${printed}, it is ${COMPANY_DETAILS.gstin}`);
  };
  const sameAddress = (printed: string | undefined, what: string): void => {
    if (printed && squash(printed) !== squash(COMPANY_DETAILS.address)) problems.push(`${what} prints the company address "${printed}", it is "${COMPANY_DETAILS.address}"`);
  };
  if (docType === 'sales_invoice') {
    const invoice = data as Invoice;
    const what = `sales invoice ${invoice.invoiceNumber ?? '?'}`;
    sameName(invoice.sellerName, what);
    sameGstin(invoice.sellerGSTIN, what);
    sameAddress(invoice.sellerAddress, what);
  } else if (docType === 'vendor_invoice') {
    const invoice = data as Invoice;
    const what = `vendor invoice ${invoice.invoiceNumber ?? '?'}`;
    sameName(invoice.buyerName, what);
    sameGstin(invoice.buyerGSTIN, what);
    sameAddress(invoice.buyerAddress, what);
  } else if (docType === 'bank_statement') {
    sameName((data as BankStatement).accountHolderName, 'bank statement');
  } else if (docType === 'month_end_note') {
    sameName((data as MonthEndNotes).companyName, 'month-end notes');
  } else if (docType === 'sales_register') {
    const register = data as SalesRegister;
    sameName(register.sellerName, 'sales register');
    sameGstin(register.sellerGSTIN, 'sales register');
  }
  return problems;
}

function invoiceProblems(docType: string, invoice: Invoice): { arithmetic: string | null; gstHead: string | null } {
  const number = invoice.invoiceNumber ?? '?';
  const tax = invoice.taxBreakup ?? {};
  const cgst = tax.cgst_amount ?? 0;
  const sgst = tax.sgst_amount ?? 0;
  const igst = tax.igst_amount ?? 0;
  let arithmetic: string | null = null;
  if (invoice.lineItems && invoice.totalAmount !== undefined) {
    const lines = invoice.lineItems.reduce((sum, line) => sum + (line.amount ?? 0), 0);
    const computed = lines + cgst + sgst + igst + (invoice.roundOff ?? 0);
    if (Math.abs(computed - invoice.totalAmount) >= TOLERANCE) {
      arithmetic = `${number}: lines ${rupees(lines)} plus GST ${rupees(cgst + sgst + igst)} come to ${rupees(computed)}, the invoice total is ${rupees(invoice.totalAmount)}`;
    }
  }
  let gstHead: string | null = null;
  const gstin = docType === 'vendor_invoice' ? invoice.vendorGSTIN : invoice.buyerGSTIN;
  if (gstin && /^\d{2}/.test(gstin) && cgst + sgst + igst > 0) {
    const home = gstin.slice(0, 2) === COMPANY_DETAILS.stateCode;
    if (home && igst > 0) gstHead = `${number}: the party's GSTIN ${gstin} is in ${COMPANY_DETAILS.state} but the invoice charges IGST`;
    if (!home && cgst + sgst > 0) gstHead = `${number}: the party's GSTIN ${gstin} is outside ${COMPANY_DETAILS.state} but the invoice charges CGST and SGST`;
  }
  return { arithmetic, gstHead };
}

export function auditDeliveredDocuments(months: readonly AuditMonth[], companyName: string = COMPANY_DETAILS.name): AuditResult {
  const ordered = [...months].sort((a, b) => a.ordinal - b.ordinal);
  const findings: AuditFinding[] = [];
  const add = (month: AuditMonth, check: AuditCheck, message: string): void => {
    findings.push({ check, ordinal: month.ordinal, label: month.label, source: month.source, message });
  };

  const gstinsByParty = new Map<string, { name: string; values: Map<string, number[]> }>();
  const numberSeen = new Map<string, { month: AuditMonth; party: string; total: number | undefined }>();
  const registry: string[] = [];
  let previousStatement: { month: AuditMonth; closing: number } | null = null;
  let documentsChecked = 0;

  for (const month of ordered) {
    const salesInvoices = new Map<string, Invoice>();

    for (const document of month.documents) {
      documentsChecked += 1;
      for (const problem of companyBlockProblems(document.docType, document.data, companyName)) add(month, 'COMPANY_BLOCK', problem);
      if (document.docType !== 'vendor_invoice' && document.docType !== 'sales_invoice') continue;

      const invoice = (document.data ?? {}) as Invoice;
      const number = invoice.invoiceNumber ?? '';
      const party = partyOf(document.docType, invoice);
      const { arithmetic, gstHead } = invoiceProblems(document.docType, invoice);
      if (arithmetic) add(month, 'ARITHMETIC', arithmetic);
      if (gstHead) add(month, 'GST_HEAD', gstHead);
      if (document.docType === 'sales_invoice' && number) salesInvoices.set(numberKey(number), invoice);

      if (number) {
        const key = `${document.docType}|${numberKey(number)}`;
        const earlier = numberSeen.get(key);
        const partyName = party?.name ?? (invoice.isCashMemo ? 'cash memo' : '');
        if (!earlier) {
          numberSeen.set(key, { month, party: partyName, total: invoice.totalAmount });
        } else if (earlier.month.exerciseId === month.exerciseId && earlier.party === partyName && earlier.total === invoice.totalAmount) {
          add(month, 'STORED_TWICE', `${number} (${partyName}) is stored twice for this month`);
        } else {
          add(month, 'NUMBER_REUSED', `${number} (${partyName}) was already used in month ${earlier.month.ordinal} (${earlier.month.label}) for ${earlier.party}`);
        }
      }

      if (!party) continue;
      const directory = partyIdentityFor(party.name);
      if (party.gstin) {
        const entry = gstinsByParty.get(normalizePartyName(party.name)) ?? { name: party.name, values: new Map<string, number[]>() };
        entry.values.set(party.gstin, [...(entry.values.get(party.gstin) ?? []), month.ordinal]);
        gstinsByParty.set(normalizePartyName(party.name), entry);
        if (!isValidGstin(party.gstin)) add(month, 'GSTIN_INVALID', `${number}: ${party.name} is printed with GSTIN ${party.gstin}, which is not a valid GST number`);
        if (party.gstin !== directory.gstin) {
          add(month, 'PARTY_GSTIN', `${number}: ${party.name} is printed with GSTIN ${party.gstin}; this party's GSTIN is ${directory.gstin}`);
        }
      }
      if (party.address && squash(party.address) !== squash(directory.address)) {
        add(month, 'PARTY_ADDRESS', `${number}: ${party.name} is printed at "${party.address}"; this party's address is "${directory.address}"`);
      }
    }

    // The key resolves a party against every party before it; the documents
    // resolve the name alone. The two must give the same GST number.
    for (const name of month.partyNames) {
      if (partyIdentityFor(name).gstin !== partyIdentityFor(name, registry).gstin) {
        add(month, 'IDENTITY_SPLIT', `${name}: the documents would print GSTIN ${partyIdentityFor(name).gstin}, the books hold ${partyIdentityFor(name, registry).gstin}`);
      }
      if (!registry.some((existing) => normalizePartyName(existing) === normalizePartyName(name))) registry.push(name);
    }

    for (const document of month.documents) {
      if (document.docType === 'sales_register') {
        for (const row of (document.data as SalesRegister).rows ?? []) {
          const invoice = salesInvoices.get(numberKey(row.invoiceNumber ?? ''));
          if (!invoice) {
            add(month, 'REGISTER_ROW', `sales register row ${row.invoiceNumber ?? '?'} has no sales invoice in this month`);
            continue;
          }
          if (row.total !== undefined && invoice.totalAmount !== undefined && Math.abs(row.total - invoice.totalAmount) >= TOLERANCE) {
            add(month, 'REGISTER_ROW', `sales register row ${row.invoiceNumber} shows ${rupees(row.total)}, the invoice total is ${rupees(invoice.totalAmount)}`);
          }
          if (!invoice.isCashMemo && (row.customerGSTIN ?? null) !== (invoice.buyerGSTIN ?? null)) {
            add(month, 'REGISTER_ROW', `sales register row ${row.invoiceNumber} shows GSTIN ${row.customerGSTIN ?? 'none'}, the invoice shows ${invoice.buyerGSTIN ?? 'none'}`);
          }
        }
      }
      if (document.docType === 'bank_statement') {
        const rows = (document.data as BankStatement).transactions ?? [];
        const first = rows[0];
        const last = rows[rows.length - 1];
        if (!first || first.balance === undefined || last.balance === undefined) continue;
        const opening = first.balance - (first.credit ?? 0) + (first.debit ?? 0);
        if (previousStatement && Math.abs(opening - previousStatement.closing) >= TOLERANCE) {
          add(
            month,
            'BANK_CONTINUITY',
            `the bank statement opens at ${rupees(opening)}; the statement of month ${previousStatement.month.ordinal} (${previousStatement.month.label}) closed at ${rupees(previousStatement.closing)}`,
          );
        }
        previousStatement = { month, closing: last.balance };
      }
    }
  }

  const bySource: AuditResult['bySource'] = {
    pack: { months: 0, documents: 0, findings: 0 },
    legacy: { months: 0, documents: 0, findings: 0 },
    planned: { months: 0, documents: 0, findings: 0 },
    'dry-run': { months: 0, documents: 0, findings: 0 },
  };
  for (const month of ordered) {
    bySource[month.source].months += 1;
    bySource[month.source].documents += month.documents.length;
  }
  for (const finding of findings) bySource[finding.source].findings += 1;

  const parties = [...gstinsByParty.values()]
    .map((entry) => ({
      party: entry.name,
      gstins: [...entry.values.entries()].map(([value, monthsSeen]) => ({ value, months: [...new Set(monthsSeen)] })),
      directoryGstin: partyIdentityFor(entry.name).gstin,
    }))
    .sort((a, b) => a.party.localeCompare(b.party));

  return { findings, parties, documentsChecked, bySource };
}

import type { SalesInvoiceContent, SalesRegisterContent, SalesRegisterRow } from '@/lib/schemas/source-document';

// Sales register (2026-09-09). AI Accountant's sales screen accepts CSV/XLS
// only, so a documents-mode batch that has any sale also ships one CSV
// listing that month's sales invoices and cash memos. Built by code from
// the batch's SalesInvoiceContent — the same figures that print on the
// invoice PDFs and sit in the answer key — so the three can never disagree.
//
// The column set is the one AI Accountant's import needs at minimum. If
// their template differs, change SALES_REGISTER_COLUMNS and cellsFor
// together; nothing else depends on the column order.

export const SALES_REGISTER_COLUMNS = [
  'Invoice No',
  'Invoice Date',
  'Customer Name',
  'Place of Supply',
  'Invoice Type',
  'Taxable Value',
  'CGST',
  'SGST',
  'IGST',
  'Total',
] as const;

export function buildSalesRegisterContent(
  invoices: SalesInvoiceContent[],
  params: { period: string },
): SalesRegisterContent | null {
  if (invoices.length === 0) return null;
  const rows: SalesRegisterRow[] = invoices.map((invoice) => {
    const taxableValue = round2(invoice.lineItems.reduce((sum, item) => sum + item.amount, 0));
    return {
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      customerName: invoice.buyerName,
      placeOfSupply: invoice.placeOfSupply,
      isCashMemo: invoice.isCashMemo,
      taxableValue,
      cgst: round2(invoice.taxBreakup.cgst_amount ?? 0),
      sgst: round2(invoice.taxBreakup.sgst_amount ?? 0),
      igst: round2(invoice.taxBreakup.igst_amount ?? 0),
      total: round2(invoice.totalAmount),
    };
  });
  return {
    sellerName: invoices[0].sellerName,
    sellerGSTIN: invoices[0].sellerGSTIN,
    period: params.period,
    rows,
  };
}

// Dates on the invoices print as DD-Mon-YYYY ("02-Apr-2025"); the register
// carries DD-MM-YYYY, the form Indian accounting imports read unambiguously
// and Excel shows as a date. Anything unparseable is passed through as is.
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function formatRegisterDate(invoiceDate: string): string {
  const match = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(invoiceDate.trim());
  if (!match) return invoiceDate;
  const monthIndex = MONTHS.indexOf(match[2].toLowerCase());
  if (monthIndex === -1) return invoiceDate;
  return `${match[1].padStart(2, '0')}-${String(monthIndex + 1).padStart(2, '0')}-${match[3]}`;
}

function cellsFor(row: SalesRegisterRow): string[] {
  return [
    row.invoiceNumber,
    formatRegisterDate(row.invoiceDate),
    row.customerName,
    row.placeOfSupply,
    row.isCashMemo ? 'Cash Memo' : 'Tax Invoice',
    money(row.taxableValue),
    money(row.cgst),
    money(row.sgst),
    money(row.igst),
    money(row.total),
  ];
}

// RFC 4180 CSV: CRLF line ends, every cell quoted (so names with commas or
// ampersands survive), UTF-8 with BOM so Excel opens it without a wizard.
const BOM = String.fromCharCode(0xfeff);
export function renderSalesRegisterCsv(content: SalesRegisterContent): Buffer {
  const lines = [SALES_REGISTER_COLUMNS.map(quote).join(','), ...content.rows.map((row) => cellsFor(row).map(quote).join(','))];
  return Buffer.from(BOM + lines.join('\r\n') + '\r\n', 'utf8');
}

function quote(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function money(value: number): string {
  return value.toFixed(2);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

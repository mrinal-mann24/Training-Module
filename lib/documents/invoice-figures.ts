import type { AnswerKeyEntry } from '@/lib/schemas/exercise';

// The figures a document prints, read off an answer key's legs, and the
// date read off the transaction line (answer-key entries carry no date
// field). Pure. Moved out of lib/llm/prompts/source-document.ts on
// 2026-09-22 (rebuild Stage 5) when the vendor invoice stopped being an
// LLM call; every document builder, the generation checks and the
// submission gate read dates through extractTransactionDate.

export type VendorInvoiceInput = {
  // Every answer-key leg of this transaction (party + base + tax legs for
  // multi-leg keys; just the party leg for single-leg keys).
  legs: AnswerKeyEntry[];
  // The exercise's own transaction line — grounds the DATE.
  transactionDescription: string;
  // The learner's company, printed as the invoice's recipient block;
  // COMPANY_DETAILS.name when omitted.
  companyName?: string;
};

// A statement line: the answer-key entry grounds the amount/direction, the
// transaction description grounds the date and business context.
export type BankStatementLineInput = {
  entry: AnswerKeyEntry;
  partyAccounts: string[];
  transactionDescription: string;
};

export type VendorInvoiceFigures = {
  vendorAccount: string;
  total: number;
  base: number;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  // One entry per debited expense/asset leg (account + amount). When a bill
  // carries more than one — goods plus freight on Garima's Level 5 MS-3102,
  // 2026-09-04 — the printed line items must split the taxable value the
  // same way, or the learner who posts from the document is scored wrong.
  baseLines: { account: string; amount: number }[];
};

const GST_LEG_PATTERN = /\b(cgst|sgst|igst)\b/i;
const TDS_LEG_PATTERN = /\btds\b/i;
const MONTH_NAMES_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function deriveInvoiceFigures(legs: AnswerKeyEntry[]): VendorInvoiceFigures {
  const taxLegs = legs.filter((leg) => GST_LEG_PATTERN.test(leg.correct_account));
  // A TDS purchase credits TWO ledgers: the vendor (net) and TDS Payable
  // (the deduction). The vendor's invoice knows nothing about our TDS — it
  // shows the gross fee — so TDS legs are neither party nor base, and the
  // printed total is the vendor's net plus the TDS withheld. Taking "the
  // first credited non-GST leg" made TDS Payable the vendor of Praveen's
  // Level 6 legal-fee invoice, total 2,000 instead of Sharma Legal 20,000
  // (2026-09-03).
  const tdsLegs = legs.filter((leg) => TDS_LEG_PATTERN.test(leg.correct_account));
  const nonTax = legs.filter((leg) => !GST_LEG_PATTERN.test(leg.correct_account) && !TDS_LEG_PATTERN.test(leg.correct_account));
  // On a purchase the vendor is the credited leg; base legs are the debits.
  const partyLeg = nonTax.find((leg) => leg.dr_cr === 'Cr') ?? nonTax[0];
  const baseLegs = nonTax.filter((leg) => leg !== partyLeg);
  const tdsWithheld = tdsLegs.filter((leg) => leg.dr_cr === 'Cr').reduce((sum, leg) => sum + leg.amount, 0);

  if (legs.length === 1) {
    // Single-leg key: party total inclusive of tax; split by the stated rate.
    const head = partyLeg.gst_head;
    if (!head) {
      return { vendorAccount: partyLeg.correct_account, total: partyLeg.amount, base: partyLeg.amount, cgst: null, sgst: null, igst: null, baseLines: [] };
    }
    // For CGST/SGST the key stores the PER-HEAD rate (gst_rate 9 = 9% CGST +
    // 9% SGST = 18% combined — confirmed against Praveen's live key,
    // 2026-09-01); IGST's rate is already the whole tax.
    const statedRate = partyLeg.gst_rate ?? (head === 'IGST' ? 18 : 9);
    const combinedRate = (head === 'IGST' ? statedRate : statedRate * 2) / 100;
    const base = Math.round(partyLeg.amount / (1 + combinedRate));
    const tax = partyLeg.amount - base;
    return head === 'IGST'
      ? { vendorAccount: partyLeg.correct_account, total: partyLeg.amount, base, cgst: null, sgst: null, igst: tax, baseLines: [] }
      : { vendorAccount: partyLeg.correct_account, total: partyLeg.amount, base, cgst: tax / 2, sgst: tax / 2, igst: null, baseLines: [] };
  }

  const headAmount = (head: string) => {
    const matched = taxLegs.filter((leg) => new RegExp(`\\b${head}\\b`, 'i').test(leg.correct_account));
    return matched.length > 0 ? matched.reduce((sum, leg) => sum + leg.amount, 0) : null;
  };
  return {
    vendorAccount: partyLeg.correct_account,
    total: partyLeg.amount + tdsWithheld,
    base: baseLegs.reduce((sum, leg) => sum + leg.amount, 0),
    cgst: headAmount('cgst'),
    sgst: headAmount('sgst'),
    igst: headAmount('igst'),
    baseLines: baseLegs.map((leg) => ({ account: leg.correct_account, amount: leg.amount })),
  };
}

// "On 12-May-2024, ...", "12 May 2024", "12/05/2024": the first date in a
// transaction line. Null when it names none.
export function extractTransactionDate(description: string): { day: number; monthIndex: number; year: number } | null {
  const MONTH_ABBREVS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const named = /\b(\d{1,2})[-\s/]*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*[-\s/]*(\d{4})\b/i.exec(description);
  if (named) {
    return { day: Number(named[1]), monthIndex: MONTH_ABBREVS.indexOf(named[2].toLowerCase()), year: Number(named[3]) };
  }
  const numeric = /\b(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b/.exec(description);
  if (numeric) {
    return { day: Number(numeric[1]), monthIndex: Number(numeric[2]) - 1, year: Number(numeric[3]) };
  }
  return null;
}

export function formatInvoiceDate(date: { day: number; monthIndex: number; year: number }): string {
  return `${String(date.day).padStart(2, '0')}-${MONTH_NAMES_SHORT[date.monthIndex]}-${date.year}`;
}

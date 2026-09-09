import type { BankStatementContent } from '@/lib/schemas/source-document';

// The company's bank account as given in the diagnostic pack's Company
// Master sheet (Blossom Retail Pvt Ltd). Printed on every generated bank
// statement so the PDF reads like a real statement download and can be
// parsed by tools that key on the account number (AI Accountant refused
// the statement without it, Praveen, 2026-09-09).
export const COMPANY_BANK_ACCOUNT = {
  bankName: 'HDFC Bank Ltd',
  branch: 'Indiranagar, Bengaluru',
  accountNumber: '12345067891234',
  ifsc: 'HDFC0001234',
  accountType: 'Current Account',
} as const;

export type StatementSummary = {
  openingBalance: number;
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
};

// Derived purely from the statement lines: opening = first line's running
// balance before its own movement; closing = last line's running balance.
// Lines are stored in statement order, so the first line is the earliest.
export function summarizeStatement(content: BankStatementContent): StatementSummary {
  const first = content.transactions[0];
  const last = content.transactions[content.transactions.length - 1];
  const openingBalance = first.balance - (first.credit ?? 0) + (first.debit ?? 0);
  let totalDebits = 0;
  let totalCredits = 0;
  for (const transaction of content.transactions) {
    totalDebits += transaction.debit ?? 0;
    totalCredits += transaction.credit ?? 0;
  }
  return { openingBalance, totalDebits, totalCredits, closingBalance: last.balance };
}

export function formatStatementAmount(value: number): string {
  return value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

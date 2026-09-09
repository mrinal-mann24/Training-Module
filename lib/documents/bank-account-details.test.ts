import { describe, expect, it } from 'vitest';
import { summarizeStatement } from './bank-account-details';

describe('summarizeStatement', () => {
  it('derives opening, totals and closing from the running balances', () => {
    const summary = summarizeStatement({
      accountHolderName: 'Blossom Retail Pvt Ltd',
      period: '08-Feb-2025 to 24-Feb-2025',
      transactions: [
        { date: '08-Feb-2025', narration: 'CASH DEPOSIT/CD25020806/CASH', debit: null, credit: 12000, balance: 1164200 },
        { date: '11-Feb-2025', narration: 'NEFT/N25021108/MUMBAI SUPPLIERS/MS-2201', debit: 30000, credit: null, balance: 1134200 },
        { date: '24-Feb-2025', narration: 'NEFT/N25022412/KOCHI MODERN/BR-207', debit: null, credit: 64900, balance: 1199100 },
      ],
    });
    expect(summary).toEqual({ openingBalance: 1152200, totalDebits: 30000, totalCredits: 76900, closingBalance: 1199100 });
  });

  it('opening balance accounts for a first line that is a withdrawal', () => {
    const summary = summarizeStatement({
      accountHolderName: 'Blossom Retail Pvt Ltd',
      period: '09-Jan-2025 to 09-Jan-2025',
      transactions: [{ date: '09-Jan-2025', narration: 'NEFT/N25010905/MUMBAI SUPPLIERS/MS/778', debit: 15000, credit: null, balance: 774790 }],
    });
    expect(summary.openingBalance).toBe(789790);
    expect(summary.closingBalance).toBe(774790);
  });
});

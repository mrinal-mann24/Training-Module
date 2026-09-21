import type { CalendarDate } from '@/lib/tutor/tax-rules';

// The learner-facing transaction line, built from the built voucher
// (2026-09-22, rebuild Stage 3). The text and the key cannot disagree
// because the text is derived from the key. Two registers: a document-
// backed line is a pointer (date, party, what happened, where to look, no
// figures); a plain line spells the entry out.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dateLabel(date: CalendarDate): string {
  return `${String(date.day).padStart(2, '0')}-${MONTHS[date.monthIndex]}-${date.year}`;
}

export const rupees = (value: number): string => `Rs ${Math.round(value).toLocaleString('en-IN')}`;

export type DescribedVoucher =
  | { kind: 'sale'; customer: string | null; documentNumber: string; lines: string; taxable: number; gst: number; gstLabel: string; total: number; advance: { ref: string; amount: number } | null }
  | { kind: 'purchase'; vendor: string; documentNumber: string; ledger: string; lines: string; taxable: number; gst: number; gstLabel: string; tds: { section: string; amount: number } | null; total: number; advance: { ref: string; amount: number } | null; reverseCharge: boolean }
  | { kind: 'rcm_journal'; vendor: string; documentNumber: string; taxable: number; gst: number; gstLabel: string; ratePercent: number }
  | { kind: 'receipt'; customer: string; instrument: 'bank' | 'cash'; amount: number; allocation: string; tds: { section: string; amount: number } | null }
  | { kind: 'credit_note' | 'debit_note'; party: string; noteNumber: string; againstBill: string; lines: string; taxable: number; gst: number; gstLabel: string; total: number }
  | { kind: 'payment'; payee: string | null; expenseLedger: string | null; instrument: 'bank' | 'cash'; amount: number; allocation: string; tds: { section: string; amount: number } | null }
  | { kind: 'contra'; direction: 'cash_to_bank' | 'bank_to_cash'; amount: number }
  | { kind: 'depreciation'; assetLedger: string; months: number; ratePercent: number; amount: number };

export function describeVoucher(voucher: DescribedVoucher, date: CalendarDate, documentBacked: boolean): string {
  const on = `On ${dateLabel(date)},`;
  switch (voucher.kind) {
    case 'sale': {
      if (voucher.customer === null) {
        return documentBacked
          ? `${on} a counter sale was made for cash: post it from the attached cash memo.`
          : `${on} a counter sale was made for cash, ${voucher.lines}, taxable value ${rupees(voucher.taxable)} plus ${voucher.gstLabel} ${rupees(voucher.gst)}, ${rupees(voucher.total)} received in cash.`;
      }
      const advance = voucher.advance ? `, adjusting advance ${voucher.advance.ref} of ${rupees(voucher.advance.amount)}` : '';
      return documentBacked
        ? `${on} you raised Sales Invoice ${voucher.documentNumber} on ${voucher.customer}${advance}: post it from the attached sales invoice.`
        : `${on} you raised Sales Invoice ${voucher.documentNumber} on ${voucher.customer} for ${voucher.lines}, taxable value ${rupees(voucher.taxable)} plus ${voucher.gstLabel} ${rupees(voucher.gst)}, total ${rupees(voucher.total)}${advance}.`;
    }
    case 'purchase': {
      const advance = voucher.advance ? `, adjusting advance ${voucher.advance.ref} of ${rupees(voucher.advance.amount)}` : '';
      if (documentBacked) {
        return `${on} an invoice arrived from ${voucher.vendor} (Ref ${voucher.documentNumber})${advance}: post it from the attached invoice.`;
      }
      const gst = voucher.reverseCharge ? ' with no GST charged by the vendor (reverse charge applies)' : voucher.gst > 0 ? ` plus ${voucher.gstLabel} ${rupees(voucher.gst)}` : ' with no GST';
      const tds = voucher.tds ? `, TDS under ${voucher.tds.section} ${rupees(voucher.tds.amount)} deducted at booking` : '';
      return `${on} bill ${voucher.documentNumber} arrived from ${voucher.vendor} for ${voucher.lines} (${voucher.ledger}), taxable value ${rupees(voucher.taxable)}${gst}, total ${rupees(voucher.total)}${tds}${advance}.`;
    }
    case 'rcm_journal':
      // The bill's number and taxable value belong to the purchase line
      // before this one; the journal's line states only its own figures.
      return `${on} pass the reverse-charge journal for the bill of ${voucher.vendor} booked above: GST at ${voucher.ratePercent}% on its taxable value is payable by the company itself, ${voucher.gstLabel} ${rupees(voucher.gst)} in all, debited to the Input GST RCM ledgers and credited to the Output GST RCM ledgers (paid in cash with the month's GST, never set off).`;
    case 'receipt': {
      const where = voucher.instrument === 'bank' ? 'landed in the bank' : 'was received in cash';
      const tds = voucher.tds ? `, net of TDS under ${voucher.tds.section} ${rupees(voucher.tds.amount)} withheld by the customer (book it to TDS Receivable)` : '';
      return documentBacked
        ? `${on} a receipt from ${voucher.customer}${voucher.allocation}${tds} ${where}: post it from the bank statement.`
        : `${on} ${rupees(voucher.amount)} from ${voucher.customer}${voucher.allocation}${tds} ${where}.`;
    }
    case 'credit_note':
    case 'debit_note': {
      const gst = voucher.gst > 0 ? ` plus ${voucher.gstLabel} ${rupees(voucher.gst)} reversed` : '';
      return voucher.kind === 'credit_note'
        ? `${on} ${voucher.party} returned goods against Sales Invoice ${voucher.againstBill}: raise Credit Note ${voucher.noteNumber} for ${voucher.lines}, taxable value ${rupees(voucher.taxable)}${gst}, total ${rupees(voucher.total)}, allocated against that invoice.`
        : `${on} goods were returned to ${voucher.party} against bill ${voucher.againstBill}: raise Debit Note ${voucher.noteNumber} for ${voucher.lines}, taxable value ${rupees(voucher.taxable)}${gst}, total ${rupees(voucher.total)}, allocated against that bill.`;
    }
    case 'payment': {
      const tds = voucher.tds ? `, TDS under ${voucher.tds.section} ${rupees(voucher.tds.amount)} deducted` : '';
      if (voucher.payee === null) {
        return documentBacked
          ? `${on} a payment for ${voucher.expenseLedger ?? 'an expense'} went out from the bank: post it from the bank statement.`
          : `${on} ${rupees(voucher.amount)} was paid ${voucher.instrument === 'bank' ? 'from the bank' : 'in cash'} for ${voucher.expenseLedger ?? 'an expense'}${tds}.`;
      }
      const where = voucher.instrument === 'bank' ? 'went out from the bank' : 'was paid in cash';
      return documentBacked
        ? `${on} a payment to ${voucher.payee}${voucher.allocation} ${where}: post it from the bank statement.`
        : `${on} ${rupees(voucher.amount)} to ${voucher.payee}${voucher.allocation} ${where}${tds}.`;
    }
    case 'contra':
      return documentBacked
        ? voucher.direction === 'cash_to_bank'
          ? `${on} cash was deposited into the bank: post it from the bank statement.`
          : `${on} cash was withdrawn from the bank: post it from the bank statement.`
        : voucher.direction === 'cash_to_bank'
          ? `${on} ${rupees(voucher.amount)} of cash was deposited into the bank.`
          : `${on} ${rupees(voucher.amount)} was withdrawn from the bank into cash.`;
    case 'depreciation':
      return `${on} charge depreciation on ${voucher.assetLedger} for ${voucher.months === 1 ? 'the month' : `${voucher.months} months`} at ${voucher.ratePercent}% per annum on the ledger balance: ${rupees(voucher.amount)}, by journal.`;
    default: {
      const never: never = voucher;
      throw new Error(`Unknown voucher ${JSON.stringify(never)}`);
    }
  }
}

// "against bill INV-3001" / " (Ref ADV-C02)" for pointers and plain lines.
export function allocationPhrase(allocations: readonly { ref: string; kind: string; partPayment?: boolean }[]): string {
  const named = allocations.filter((allocation) => allocation.kind !== 'on_account');
  if (named.length === 0) return allocations.length > 0 ? ' on account' : '';
  const refs = named.map((allocation) => allocation.ref).join(', ');
  if (named.every((allocation) => allocation.kind === 'against')) {
    const part = named.some((allocation) => allocation.partPayment) ? ' (part payment)' : '';
    return ` against bill ${refs}${part}`;
  }
  return ` (Ref ${refs})`;
}

import { z } from 'zod';

export const DR_CR_VALUES = ['Dr', 'Cr'] as const;
export type DrOrCr = (typeof DR_CR_VALUES)[number];

const BillAllocationSchema = z.object({
  name: z.string(),
  amount: z.number(),
});
export type BillAllocation = z.infer<typeof BillAllocationSchema>;

const LedgerEntrySchema = z.object({
  ledgerName: z.string(),
  amount: z.number(),
  drOrCr: z.enum(DR_CR_VALUES),
  billAllocations: z.array(BillAllocationSchema),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

export const VoucherSchema = z.object({
  voucherType: z.string(),
  date: z.string(),
  // Extracted from the voucher's NARRATION tag (empty string when absent) —
  // added 2026-08-19 so narration presence can actually be scored instead of
  // always reporting missing (the previous documented parser limitation).
  narration: z.string(),
  ledgerEntries: z.array(LedgerEntrySchema),
});
export type Voucher = z.infer<typeof VoucherSchema>;

export const ParsedDayBookSchema = z.object({
  vouchers: z.array(VoucherSchema),
});
export type ParsedDayBook = z.infer<typeof ParsedDayBookSchema>;

const TrialBalanceLedgerSchema = z.object({
  ledgerName: z.string(),
  closingDebit: z.number(),
  closingCredit: z.number(),
});
export type TrialBalanceLedger = z.infer<typeof TrialBalanceLedgerSchema>;

export const ParsedTrialBalanceSchema = z.object({
  ledgers: z.array(TrialBalanceLedgerSchema),
});
export type ParsedTrialBalance = z.infer<typeof ParsedTrialBalanceSchema>;

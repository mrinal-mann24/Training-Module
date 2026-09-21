import type { AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';
import { documentNumberOf, partyLegOf } from '@/lib/db/queries/company';

// What is left of the LLM document generator. The bank statement has been
// built by code since 2026-09-03 (build-bank-statement.ts); the vendor
// invoice since 2026-09-22 (build-vendor-invoice.ts, rebuild Stage 5), which
// deleted generateVendorInvoiceDocument, its checks and re-stamping, and the
// prompt module. The credit-voucher numbering rule below is used by the
// generation checks and stays here.

function referenceOf(legs: ReadonlyArray<AnswerKeyEntry>): string | null {
  return legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
}

// Credit sales and credit purchases whose key carries no number of their
// own (2026-09-17). Such a voucher used to print a CM-yymmdd-seq "tax
// invoice" (sales) or a number the model invented (purchases), which the
// learner then allocated against and the key could not score. The
// generation checks call this and reject the batch; the document builders
// throw on the same condition as a backstop. A cash sale/purchase (no party
// leg) needs no number: a cash memo is numbered by code.
export type MissingBillNumber = { sequence: number; voucherType: 'Sales' | 'Purchase'; party: string };

export function missingBillNumbersInLegs(legs: ReadonlyArray<AnswerKeyEntry>): MissingBillNumber | null {
  if (legs.length === 0) return null;
  const voucherType = legs[0].voucher_type.trim().toLowerCase();
  if (voucherType !== 'sales' && voucherType !== 'purchase') return null;
  const party = partyLegOf([...legs], legs[0].voucher_type);
  if (!party) return null;
  if (documentNumberOf(referenceOf(legs))) return null;
  return {
    sequence: legs[0].sequence,
    voucherType: voucherType === 'sales' ? 'Sales' : 'Purchase',
    party: party.correct_account,
  };
}

export function missingBillNumbers(generated: GeneratedExercise): MissingBillNumber[] {
  const bySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of generated.answer_key.entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }
  return [...bySequence.values()]
    .map((legs) => missingBillNumbersInLegs(legs))
    .filter((missing): missing is MissingBillNumber => missing !== null)
    .sort((a, b) => a.sequence - b.sequence);
}

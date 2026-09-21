import { documentNumberOf } from '@/lib/db/queries/company';
import { COMPANY_DETAILS } from '@/lib/documents/company-details';
import { amountInWords, formatHsnSac, hsnSacFor, reverseChargeFromLegs, taxRatePercentOf } from '@/lib/documents/gst-invoice-fields';
import { deriveInvoiceFigures, extractTransactionDate, formatInvoiceDate } from '@/lib/documents/invoice-figures';
import { partyIdentityFor } from '@/lib/documents/party-directory';
import { reverseChargeCategoryFor } from '@/lib/tutor/tax-rules';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

// The vendor's bill for one Purchase transaction, built by code from the
// key (2026-09-22, rebuild Stage 5). Until now the model drafted it and
// code checked and re-stamped the figures, and the one thing the stamping
// could not fix was the GSTIN the model printed: the audit found ten bills
// whose printed state contradicted the vendor's one identity (Sharma Legal
// as Delhi, Deccan Traders as Telangana) while the key, rightly, charged
// CGST/SGST. Every fact here is the key's or the party master's: vendor
// name, GSTIN and address from the party's identity, number and date from
// the voucher, one line per expense leg (or the plan's own lines when they
// add up to the goods leg), tax from the GST legs, total from the party leg
// plus TDS withheld. Throws when the legs cannot be printed: a wrong
// document is never delivered.

export type VendorInvoiceLine = { description: string; quantity: number; rate: number };

const AMOUNT_TOLERANCE = 0.01;
const ROUND_OFF_PATTERN = /round(?:ing)?[\s-]*off/i;
const CASH_LEDGER_PATTERN = /^cash\b|cash-in-hand/i;

const round2 = (value: number): number => Math.round(value * 100) / 100;

function referenceOf(legs: ReadonlyArray<AnswerKeyEntry>): string | null {
  return legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
}

function lineDescriptionFor(account: string): string {
  if (/freight|delivery|transport|courier|carriage/i.test(account)) return 'Freight and delivery charges';
  if (/^purchases?\b|\b(goods|stock|trading|inventory)\b/i.test(account)) return 'Trading goods as per order';
  return account;
}

function hsn(account: string): { hsnSac?: string } {
  const code = formatHsnSac(hsnSacFor(account));
  return code ? { hsnSac: code } : {};
}

export function buildVendorInvoiceContent(
  legs: AnswerKeyEntry[],
  transactionDescription: string,
  companyName: string = COMPANY_DETAILS.name,
  options: { lines?: readonly VendorInvoiceLine[] } = {},
): VendorInvoiceContent {
  const sequence = legs[0]?.sequence ?? 0;
  const figures = deriveInvoiceFigures(legs);
  const vendor = partyIdentityFor(figures.vendorAccount);
  const date = extractTransactionDate(transactionDescription);
  if (!date) throw new Error(`Vendor invoice for transaction ${sequence}: no date in "${transactionDescription}".`);

  const isCashPurchase = CASH_LEDGER_PATTERN.test(figures.vendorAccount);
  const ownNumber = documentNumberOf(referenceOf(legs));
  if (!ownNumber && !isCashPurchase) {
    throw new Error(`Vendor invoice for transaction ${sequence}: the credit purchase from ${figures.vendorAccount} has no bill number of its own in the key.`);
  }
  const stamp = `${String(date.year).slice(-2)}${String(date.monthIndex + 1).padStart(2, '0')}${String(date.day).padStart(2, '0')}`;

  const legLines = figures.baseLines.filter((line) => !ROUND_OFF_PATTERN.test(line.account));
  const planned = options.lines ?? [];
  const plannedTotal = round2(planned.reduce((sum, line) => sum + round2(line.quantity * line.rate), 0));
  // The plan's own lines (quantity x rate) print when they add up to the
  // one goods leg; a service or expense bill prints one line per leg (one
  // expense leg, one printed line: Praveen posted MA/206's two printed
  // lines to two ledgers, 2026-09-04).
  const usePlanned = planned.length > 0 && legLines.length === 1 && Math.abs(plannedTotal - legLines[0].amount) < AMOUNT_TOLERANCE;
  const lineItems: VendorInvoiceContent['lineItems'] = usePlanned
    ? planned.map((line) => ({
        description: line.description,
        quantity: line.quantity,
        rate: round2(line.rate),
        amount: round2(line.quantity * line.rate),
        ...hsn(legLines[0].account),
      }))
    : legLines.length > 0
      ? legLines.map((line) => ({ description: lineDescriptionFor(line.account), quantity: 1, rate: round2(line.amount), amount: round2(line.amount), ...hsn(line.account) }))
      : [{ description: 'Trading goods as per order', quantity: 1, rate: round2(figures.base), amount: round2(figures.base), ...hsn('Purchases') }];

  const cgst = figures.cgst === null ? null : round2(figures.cgst);
  const sgst = figures.sgst === null ? null : round2(figures.sgst);
  const igst = figures.igst === null ? null : round2(figures.igst);
  const total = round2(figures.total);
  const taxable = round2(lineItems.reduce((sum, item) => sum + item.amount, 0));
  const hasRoundOff = legs.some((leg) => ROUND_OFF_PATTERN.test(leg.correct_account));
  const roundOff = hasRoundOff ? round2(total - taxable - (cgst ?? 0) - (sgst ?? 0) - (igst ?? 0)) : null;
  const computed = round2(taxable + (cgst ?? 0) + (sgst ?? 0) + (igst ?? 0) + (roundOff ?? 0));
  if (Math.abs(computed - total) > AMOUNT_TOLERANCE) {
    throw new Error(`Vendor invoice for transaction ${sequence}: lines ${computed} do not add up to the party total ${total}.`);
  }

  return {
    vendorName: figures.vendorAccount,
    vendorGSTIN: vendor.gstin,
    vendorAddress: vendor.address,
    invoiceNumber: ownNumber ?? `CB-${stamp}-${String(sequence).padStart(2, '0')}`,
    invoiceDate: formatInvoiceDate(date),
    lineItems,
    taxBreakup: { cgst_amount: cgst, sgst_amount: sgst, igst_amount: igst },
    totalAmount: total,
    ...(roundOff !== null ? { roundOff } : {}),
    buyerName: companyName,
    buyerGSTIN: COMPANY_DETAILS.gstin,
    buyerAddress: COMPANY_DETAILS.address,
    // Goods and services received at our Karnataka premises.
    placeOfSupply: COMPANY_DETAILS.state,
    placeOfSupplyCode: COMPANY_DETAILS.stateCode,
    // Rule 46: tax payable on reverse charge. The purchase voucher itself
    // carries no RCM ledger (the company's RCM journal follows it), so the
    // rulebook category decides as well as the legs.
    reverseCharge: reverseChargeFromLegs(legs) || reverseChargeCategoryFor({ party: figures.vendorAccount, expenseLedgers: legLines.map((line) => line.account) })?.mandatory === true,
    taxRatePercent: taxRatePercentOf(taxable, { cgst, sgst, igst }),
    amountInWords: amountInWords(total),
  };
}

// Rule 46 particulars (CGST Rules) for the invoices we print (2026-09-17):
// HSN/SAC per line, tax rate, place of supply with state code, whether tax
// is payable on reverse charge, the total in words, and both the supplier
// and the recipient block. All derived by code from the answer key; the
// model never supplies any of them.

export type HsnSac = { kind: 'HSN' | 'SAC'; code: string };

// HSN/SAC by ledger nature. The company trades home furnishings (the
// directory's vendors: Vizag Furnishings, Trichy Textiles, Rajasthan Home
// Decor), so trading goods default to HSN 6304 (other furnishing articles).
// Services use the SAC of their type. A ledger that matches nothing prints
// no code rather than a wrong one. First match wins, so services are listed
// before the goods patterns.
//
//   Ledger contains                               Code
//   rent                                          SAC 997212 (rental of non-residential property)
//   legal / professional / audit / consult        SAC 998211 (legal advisory and representation)
//   advertis / signage / marketing / promotion    SAC 998361 (advertising services)
//   freight / delivery / transport / courier      SAC 996511 (road transport of goods)
//   software / cloud / subscription / saas        SAC 997331 (licensing of software)
//   repair / maintenance                          SAC 998719 (maintenance and repair services)
//   cleaning / housekeeping                       SAC 998533 (cleaning services)
//   furniture / fixtures                          HSN 9403
//   computer / laptop / printer                   HSN 8471
//   machinery / equipment                         HSN 8479
//   stationery                                    HSN 4820
//   purchase / sales / goods / stock / trading    HSN 6304 (trading goods default)
export const TRADING_GOODS_HSN = '6304';

const HSN_SAC_TABLE: [RegExp, HsnSac][] = [
  [/\brent/i, { kind: 'SAC', code: '997212' }],
  [/legal|professional|audit|consult/i, { kind: 'SAC', code: '998211' }],
  [/advertis|signage|marketing|promotion/i, { kind: 'SAC', code: '998361' }],
  [/freight|delivery|transport|courier|carriage/i, { kind: 'SAC', code: '996511' }],
  [/software|cloud|subscription|saas/i, { kind: 'SAC', code: '997331' }],
  [/repair|maintenance/i, { kind: 'SAC', code: '998719' }],
  [/cleaning|cleaners|housekeeping/i, { kind: 'SAC', code: '998533' }],
  [/furniture|fixture/i, { kind: 'HSN', code: '9403' }],
  [/computer|laptop|printer/i, { kind: 'HSN', code: '8471' }],
  [/machinery|equipment/i, { kind: 'HSN', code: '8479' }],
  [/stationery/i, { kind: 'HSN', code: '4820' }],
  [/\b(purchases?|sales|goods|stock|trading|materials?|inventory)\b/i, { kind: 'HSN', code: TRADING_GOODS_HSN }],
];

// serviceSupply: a sale adjusting a service advance is not trading goods;
// with no service type to go on it prints no code.
export function hsnSacFor(account: string, options: { serviceSupply?: boolean } = {}): HsnSac | null {
  for (const [pattern, code] of HSN_SAC_TABLE) {
    if (!pattern.test(account)) continue;
    if (options.serviceSupply && code.kind === 'HSN') return null;
    return code;
  }
  return null;
}

// "HSN 6304" / "SAC 997212" as printed in the line's code column.
export function formatHsnSac(code: HsnSac | null): string | undefined {
  return code ? `${code.kind} ${code.code}` : undefined;
}

// Tax is payable on reverse charge when the key posts an RCM ledger.
const RCM_LEDGER_PATTERN = /\brcm\b|reverse\s*charge/i;
export function reverseChargeFromLegs(legs: ReadonlyArray<{ correct_account: string }>): boolean {
  return legs.some((leg) => RCM_LEDGER_PATTERN.test(leg.correct_account));
}

// Combined GST rate in percent (CGST 9 + SGST 9 = 18), from the printed
// figures. Null when the invoice carries no GST.
export function taxRatePercentOf(taxable: number, tax: { cgst: number | null; sgst: number | null; igst: number | null }): number | null {
  const total = (tax.cgst ?? 0) + (tax.sgst ?? 0) + (tax.igst ?? 0);
  if (taxable <= 0 || total <= 0) return null;
  return Math.round((total / taxable) * 10000) / 100;
}

// Indian-system amount in words: lakh and crore, rupees and paise.
// 106200.5 -> "Rupees One Lakh Six Thousand Two Hundred and Fifty Paise Only".
const ONES = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function belowHundred(value: number): string {
  if (value < 20) return ONES[value];
  const unit = value % 10;
  return unit === 0 ? TENS[Math.floor(value / 10)] : `${TENS[Math.floor(value / 10)]} ${ONES[unit]}`;
}

function belowThousand(value: number): string {
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  const parts: string[] = [];
  if (hundreds > 0) parts.push(`${ONES[hundreds]} Hundred`);
  if (rest > 0) parts.push(belowHundred(rest));
  return parts.join(' ');
}

function integerInWords(value: number): string {
  if (value === 0) return 'Zero';
  const crore = Math.floor(value / 10000000);
  const lakh = Math.floor(value / 100000) % 100;
  const thousand = Math.floor(value / 1000) % 100;
  const rest = value % 1000;
  const parts: string[] = [];
  if (crore > 0) parts.push(`${integerInWords(crore)} Crore`);
  if (lakh > 0) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand > 0) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest > 0) parts.push(belowThousand(rest));
  return parts.join(' ');
}

export function amountInWords(amount: number): string {
  const paiseTotal = Math.round(Math.abs(amount) * 100);
  const rupees = Math.floor(paiseTotal / 100);
  const paise = paiseTotal % 100;
  const sign = amount < 0 && paiseTotal > 0 ? 'Minus ' : '';
  const rupeePart = `Rupees ${integerInWords(rupees)}`;
  return paise > 0
    ? `${sign}${rupeePart} and ${belowHundred(paise)} Paise Only`
    : `${sign}${rupeePart} Only`;
}

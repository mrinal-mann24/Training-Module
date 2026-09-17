// Tax rules table (2026-09-17 audit): every TDS and GST rule the generator
// checks, in ONE pure, dated table. The company's timeline runs from
// 01-Apr-2024 through FY 2024-25 and FY 2025-26, and Finance Act 2025
// changed several TDS thresholds from 01-Apr-2025, so every lookup takes
// the voucher date and answers for the law in force on that date.
//
// Sources (checked 2026-09-17):
// - Income-tax Act 1961, ss. 194C, 194H, 194-I, 194J, 206AA, as amended by
//   the Finance (No. 2) Act 2024 and the Finance Act 2025.
// - Finance (No. 2) Act 2024: s. 194H rate 5% -> 2% w.e.f. 01-Oct-2024
//   (taxguru.in, "Budget 2024: Section 194H TDS Rate ... reduce to 2% WEF
//   October 1, 2024").
// - Finance Act 2025, TDS threshold rationalisation w.e.f. 01-Apr-2025
//   (Memorandum explaining the Finance Bill 2025, incometaxindia.gov.in
//   budgets-and-bills/2025/memo-2025.pdf; summarised by jurishour.in "TDS
//   provisions effective 1st April 2025" and taxgst.in "TDS Rates FY
//   2025-26"): s. 194J professional/technical fees 30,000 -> 50,000 per
//   financial year (aggregate, per category); s. 194-I rent 2,40,000 per
//   financial year -> 50,000 for a month or part of a month; s. 194H
//   commission 15,000 -> 20,000 per financial year. s. 194C unchanged
//   (30,000 single sum, 1,00,000 aggregate).
// - Rulebook 12.4 (lib/llm/grounding/rulebook.ts) quotes 50,000 for 194J,
//   which is the FY 2025-26 figure; this table follows the statute per FY.
// - GST: CGST Act 2017 / IGST Act 2017; rate schedules Notification
//   1/2017-Central Tax (Rate) (0, 0.25, 3, 5, 12, 18, 28 overall, CGST and
//   SGST each half, IGST the whole rate); from 22-Sep-2025 Notification
//   9/2025-Central Tax (Rate) adds the 40% slab (GST Council, 56th meeting).
// - Reverse charge: Notification 13/2017-Central Tax (Rate), entry 1 (goods
//   transport agency, unless the GTA opts to pay under forward charge) and
//   entry 2 (legal services by an individual advocate or a firm of advocates
//   to a business entity); Notification 10/2017-Integrated Tax (Rate), entry
//   1 and s. 5(3) IGST Act (import of services: IGST under reverse charge).
// - Reverse-charge tax is paid in cash: s. 49(4) CGST Act allows the
//   electronic credit ledger only for "output tax", and s. 2(82) excludes tax
//   payable under reverse charge from output tax.
// - Order of utilisation: s. 49(5) CGST Act, Rule 88A CGST Rules
//   (Notification 16/2019-Central Tax) and Circular 98/17/2019-GST: IGST
//   credit first against IGST, the remainder against CGST and SGST in any
//   order and proportion; CGST credit never against SGST, nor SGST against
//   CGST.

export type CalendarDate = { day: number; monthIndex: number; year: number };

export const COMPANY_STATE_CODE = '29'; // Karnataka

// Financial year starts 1 April. FY 2024-25 has startYear 2024.
export function financialYearOf(date: CalendarDate): { startYear: number; label: string } {
  const startYear = date.monthIndex >= 3 ? date.year : date.year - 1;
  return { startYear, label: `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}` };
}

function onOrAfter(date: CalendarDate, day: number, monthIndex: number, year: number): boolean {
  return Date.UTC(date.year, date.monthIndex, date.day) >= Date.UTC(year, monthIndex, day);
}

// ---------------------------------------------------------------- TDS

export type TdsSection = '194C' | '194J' | '194I' | '194H';
export const TDS_SECTIONS: readonly TdsSection[] = ['194C', '194J', '194I', '194H'];

// Payee type decides the 194C rate (1% individual/HUF, 2% others).
// 'unknown' when the party's constitution cannot be read.
export type PayeeType = 'individual_huf' | 'other' | 'unknown';

// 194J: 2% technical services, royalty for films, call centre; 10% every
// other professional fee. 194-I: 2% plant and machinery, 10% land,
// building or furniture.
export type TdsNature = 'professional' | 'technical' | 'land_building' | 'plant_machinery' | 'unknown';

// s. 206AA: a payee without a PAN suffers the higher of the section rate
// and 20%.
export const NO_PAN_TDS_RATE = 20;

export function effectiveTdsRate(sectionRate: number, panAvailable: boolean): number {
  return panAvailable ? sectionRate : Math.max(sectionRate, NO_PAN_TDS_RATE);
}

// The rates a deduction under this section may carry on this date. One
// rate when payee type and nature are known; every candidate otherwise.
export function tdsRatesFor(
  section: TdsSection,
  date: CalendarDate,
  context: { payeeType?: PayeeType; nature?: TdsNature } = {},
): number[] {
  switch (section) {
    case '194C':
      if (context.payeeType === 'individual_huf') return [1];
      if (context.payeeType === 'other') return [2];
      return [1, 2];
    case '194J':
      if (context.nature === 'technical') return [2];
      if (context.nature === 'professional') return [10];
      return [2, 10];
    case '194I':
      if (context.nature === 'plant_machinery') return [2];
      if (context.nature === 'land_building') return [10];
      return [2, 10];
    case '194H':
      // Finance (No. 2) Act 2024: 2% from 01-Oct-2024.
      return onOrAfter(date, 1, 9, 2024) ? [2] : [5];
    default: {
      const unreachable: never = section;
      throw new Error(`Unknown TDS section ${String(unreachable)}`);
    }
  }
}

export type TdsThreshold =
  // Deduct when a single sum exceeds `single` or the FY aggregate exceeds `aggregate`.
  | { kind: 'fy_aggregate'; aggregate: number; single?: number }
  // FY 2024-25 rent: deduct when the year's rent is LIKELY to exceed the limit.
  | { kind: 'fy_likely'; aggregate: number }
  // FY 2025-26 rent: deduct when the rent for a month or part of a month exceeds the limit.
  | { kind: 'per_month'; monthly: number };

export function tdsThresholdFor(section: TdsSection, date: CalendarDate): TdsThreshold {
  const fy2025 = financialYearOf(date).startYear >= 2025;
  switch (section) {
    case '194C':
      return { kind: 'fy_aggregate', aggregate: 100000, single: 30000 };
    case '194J':
      return { kind: 'fy_aggregate', aggregate: fy2025 ? 50000 : 30000 };
    case '194I':
      return fy2025 ? { kind: 'per_month', monthly: 50000 } : { kind: 'fy_likely', aggregate: 240000 };
    case '194H':
      return { kind: 'fy_aggregate', aggregate: fy2025 ? 20000 : 15000 };
    default: {
      const unreachable: never = section;
      throw new Error(`Unknown TDS section ${String(unreachable)}`);
    }
  }
}

export type TdsExposure = {
  // This bill's taxable base.
  bill: number;
  // The payee's FY aggregate under this section INCLUDING this bill.
  fyAggregate: number;
  // The payee's rent for this calendar month INCLUDING this bill (194-I).
  monthAggregate: number;
};

// Every threshold is "exceeds": a sum exactly at the limit carries no TDS.
export function isTdsRequired(section: TdsSection, date: CalendarDate, exposure: TdsExposure): boolean {
  const threshold = tdsThresholdFor(section, date);
  switch (threshold.kind) {
    case 'fy_aggregate':
      return exposure.fyAggregate > threshold.aggregate || (threshold.single !== undefined && exposure.bill > threshold.single);
    case 'fy_likely':
      // ASSUMPTION (2026-09-17): a rent bill is the monthly instalment of a
      // running lease, so the year's rent is likely to reach twelve times it.
      // Hero Rentals at 40,000 a month is likely to reach 4,80,000, so TDS
      // applies from the April bill (the pack's own #75).
      return Math.max(exposure.fyAggregate, exposure.bill * 12) > threshold.aggregate;
    case 'per_month':
      return exposure.monthAggregate > threshold.monthly;
    default: {
      const unreachable: never = threshold;
      throw new Error(`Unknown threshold ${JSON.stringify(unreachable)}`);
    }
  }
}

export function describeTdsThreshold(section: TdsSection, date: CalendarDate): string {
  const threshold = tdsThresholdFor(section, date);
  const rupees = (value: number) => `Rs ${value.toLocaleString('en-IN')}`;
  switch (threshold.kind) {
    case 'fy_aggregate':
      return threshold.single !== undefined
        ? `a single bill over ${rupees(threshold.single)} or the year's total over ${rupees(threshold.aggregate)}`
        : `the year's total for the payee over ${rupees(threshold.aggregate)}`;
    case 'fy_likely':
      return `the year's rent likely to exceed ${rupees(threshold.aggregate)} (a monthly lease: twelve times the monthly rent)`;
    case 'per_month':
      return `rent for a month or part of a month over ${rupees(threshold.monthly)}`;
    default: {
      const unreachable: never = threshold;
      throw new Error(`Unknown threshold ${JSON.stringify(unreachable)}`);
    }
  }
}

// Section 288B rounds amounts payable; the house practice (and TRACES) takes
// each deduction to the nearest rupee.
export function roundTdsAmount(amount: number): number {
  return Math.round(amount);
}

// "TDS Payable — u/s 194J", "tds_section: 194C", "194-I": the section named.
export function tdsSectionFromText(text: string | null | undefined): TdsSection | null {
  if (!text) return null;
  const match = /194\s*-?\s*([CJIH])\b/i.exec(text);
  return match ? (`194${match[1].toUpperCase()}` as TdsSection) : null;
}

// The section an expense ledger falls under when nothing names it.
export function inferTdsSectionFromLedger(expenseLedger: string): TdsSection | null {
  if (/\brent\b/i.test(expenseLedger)) return '194I';
  if (/legal|professional|audit|consult|advisory|accounting|technical services|royalty|\bfees?\b/i.test(expenseLedger)) return '194J';
  if (/repairs?|maintenance|contract|advertis|marketing|cleaning|housekeeping|interior|printing|logistic|freight|delivery|transport|security|catering|event|signage|works?\b/i.test(expenseLedger)) return '194C';
  if (/commission|brokerage/i.test(expenseLedger)) return '194H';
  return null;
}

export function inferTdsNature(section: TdsSection, texts: string[]): TdsNature {
  const joined = texts.join(' ');
  if (section === '194J') {
    if (/technical|royalty|call cent(?:re|er)|software support|it support/i.test(joined)) return 'technical';
    if (/legal|professional|audit|consult|advisory|accounting|architect|medical|chartered|\bca\b/i.test(joined)) return 'professional';
    return 'unknown';
  }
  if (section === '194I') {
    if (/machinery|equipment|plant|vehicle|generator|crane/i.test(joined)) return 'plant_machinery';
    if (/rent/i.test(joined)) return 'land_building';
    return 'unknown';
  }
  return 'unknown';
}

// Constitution from the party name when no identity record says it: a
// company, LLP or partnership ("& Associates", "& Co") is "other". A trade
// name ("Balaji Interiors") may be a sole proprietor, so it is not guessed.
export function inferPayeeType(partyName: string, entityType?: string | null): PayeeType {
  if (entityType) {
    if (/individual|proprietor|huf/i.test(entityType)) return 'individual_huf';
    if (/unknown/i.test(entityType)) return 'unknown';
    return 'other';
  }
  if (/\b(pvt|private|ltd|limited|llp|llc|inc|co|company|corporation|associates|partners)\b|&/i.test(partyName)) {
    return 'other';
  }
  return 'unknown';
}

// ---------------------------------------------------------------- GST

// Overall rates (CGST + SGST, or IGST).
const GST_SLABS_BASE = [0, 0.25, 3, 5, 12, 18, 28];

export function allowedGstRates(date: CalendarDate | null): number[] {
  // 40% slab from 22-Sep-2025 (Notification 9/2025-Central Tax (Rate)).
  if (date && onOrAfter(date, 22, 8, 2025)) return [...GST_SLABS_BASE, 40];
  return [...GST_SLABS_BASE];
}

export function isAllowedGstRate(combinedRate: number, date: CalendarDate | null): boolean {
  return allowedGstRates(date).some((rate) => Math.abs(rate - combinedRate) < 1e-9);
}

// The tax on a taxable value: intra-state splits the rate half and half,
// inter-state charges IGST at the whole rate.
export function gstSplit(base: number, combinedRate: number, interState: boolean): { cgst: number; sgst: number; igst: number } {
  const round2 = (value: number) => Math.round(value * 100) / 100;
  if (interState) return { cgst: 0, sgst: 0, igst: round2((base * combinedRate) / 100) };
  const half = round2((base * combinedRate) / 200);
  return { cgst: half, sgst: half, igst: 0 };
}

export type ReverseChargeCategory = {
  id: 'legal_advocate' | 'goods_transport_agency' | 'import_of_services';
  description: string;
  // Mandatory: the supplier may never charge GST forward. GTA may opt for
  // forward charge, so a forward-charged GTA bill is not a violation.
  mandatory: boolean;
  citation: string;
};

export const REVERSE_CHARGE_CATEGORIES: readonly ReverseChargeCategory[] = [
  {
    id: 'legal_advocate',
    description: 'legal services by an individual advocate or a firm of advocates to a business entity',
    mandatory: true,
    citation: 'Notification 13/2017-Central Tax (Rate), entry 2',
  },
  {
    id: 'goods_transport_agency',
    description: 'road transport of goods by a goods transport agency (unless the GTA opts for forward charge)',
    mandatory: false,
    citation: 'Notification 13/2017-Central Tax (Rate), entry 1',
  },
  {
    id: 'import_of_services',
    description: 'services imported from a supplier outside India (IGST under reverse charge)',
    mandatory: true,
    citation: 'Notification 10/2017-Integrated Tax (Rate), entry 1; s. 5(3) IGST Act',
  },
];

export function reverseChargeCategoryFor(context: { party: string; expenseLedgers: string[] }): ReverseChargeCategory | null {
  const find = (id: ReverseChargeCategory['id']) => REVERSE_CHARGE_CATEGORIES.find((category) => category.id === id) ?? null;
  const ledgers = context.expenseLedgers.join(' ');
  // An advocate is named by the party, not the ledger: "Legal &
  // Professional Charges" also books a CA firm's fee (Mehta & Associates),
  // which is forward charge.
  if (/\b(legal|advocates?|law|lawyers?|solicitors?|chambers)\b/i.test(context.party) || /advocate/i.test(ledgers)) {
    return find('legal_advocate');
  }
  if (/\b(gta|goods transport|roadways|transport co|carriers?)\b/i.test(context.party) || /\bgta\b|goods transport/i.test(ledgers)) {
    return find('goods_transport_agency');
  }
  if (/\b(llc|inc|gmbh|pte|plc)\b|import of services/i.test(`${context.party} ${ledgers}`) && /import|overseas|foreign/i.test(`${context.party} ${ledgers}`)) {
    return find('import_of_services');
  }
  return null;
}

// ---------------------------------------------------------------- prompt text

// The rules in force for a batch dated in this month, for the generation
// prompt. Written from the same table the checks read.
export function taxRulesSummaryFor(date: CalendarDate): string {
  const fy = financialYearOf(date).label;
  const lines = [
    `TDS (FY ${fy}; deduct at booking on the taxable value excluding GST, TDS amount rounded to the rupee; thresholds are "exceeds", so a total exactly at the limit carries no TDS):`,
    `- 194C contractor: 1% individual/HUF, 2% others; ${describeTdsThreshold('194C', date)}.`,
    `- 194J: 10% professional fees, 2% technical services/royalty/call centre; ${describeTdsThreshold('194J', date)}.`,
    `- 194I rent: 10% land/building/furniture, 2% plant and machinery; ${describeTdsThreshold('194I', date)}.`,
    `- 194H commission: ${tdsRatesFor('194H', date)[0]}%; ${describeTdsThreshold('194H', date)}.`,
    `- 206AA: a payee with no PAN suffers ${NO_PAN_TDS_RATE}% (or the section rate if higher).`,
    `GST: rates ${allowedGstRates(date).join(', ')}% only; intra-state (party in Karnataka, state code ${COMPANY_STATE_CODE}) CGST and SGST each exactly half the rate and always equal; inter-state IGST at the whole rate; never both on one invoice. Every party keeps one fixed state.`,
    'Reverse charge (the supplier charges no GST; the company pays the tax itself in cash through Output ... RCM ledgers and takes Input ... RCM credit): ' +
      REVERSE_CHARGE_CATEGORIES.map((category) => `${category.description}${category.mandatory ? '' : ' (optional)'}`).join('; ') +
      '. A bill from an advocate or law firm must never show GST charged by the supplier.',
  ];
  return lines.join('\n');
}

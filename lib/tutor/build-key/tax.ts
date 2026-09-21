import type { AnswerKeyEntry, GstHead } from '@/lib/schemas/exercise';
import { gstTreatmentFor, payeeTypeFor, panAvailableFor, type PartyRecord } from '@/lib/tutor/party-master';
import {
  effectiveTdsRate,
  gstSplit,
  inferTdsNature,
  inferTdsSectionFromLedger,
  isAllowedGstRate,
  isTdsRequired,
  roundTdsAmount,
  tdsRatesFor,
  type CalendarDate,
  type TdsSection,
} from '@/lib/tutor/tax-rules';

// GST and TDS legs computed from the party master and the dated rule
// table (2026-09-22, rebuild Stage 3). Nothing here reads what the model
// wrote beyond the taxable value and the slab.

export const round2 = (value: number): number => Math.round(value * 100) / 100;

export type GstLeg = { account: string; head: GstHead; rate: number; amount: number };

// The tax legs of a supply at the combined slab, split by the party's
// state: intra-state CGST and SGST at half the rate each, inter-state IGST
// at the whole rate. gst_rate on a CGST/SGST leg is that head's own rate.
export function gstLegsFor(
  taxable: number,
  combinedRate: number,
  party: Pick<PartyRecord, 'stateCode'> | null,
  direction: 'output' | 'input',
  date: CalendarDate,
): { legs: GstLeg[]; violation: string | null } {
  if (!isAllowedGstRate(combinedRate, date)) {
    return { legs: [], violation: `GST rate ${combinedRate}% is not a slab in force` };
  }
  if (combinedRate === 0) return { legs: [], violation: null };
  const interState = party !== null && gstTreatmentFor(party) === 'inter';
  const split = gstSplit(taxable, combinedRate, interState);
  const prefix = direction === 'output' ? 'Output' : 'Input';
  const legs: GstLeg[] = interState
    ? [{ account: `${prefix} IGST`, head: 'IGST', rate: combinedRate, amount: split.igst }]
    : [
        { account: `${prefix} CGST`, head: 'CGST', rate: combinedRate / 2, amount: split.cgst },
        { account: `${prefix} SGST`, head: 'SGST', rate: combinedRate / 2, amount: split.sgst },
      ];
  return { legs, violation: null };
}

export type TdsExposureTracker = {
  // `${payee lower}|${section}|${nature for 194J}` -> taxable base this FY,
  // seeded from the prior keys (tdsHistoryFromKeys) and advanced per bill.
  fy: Map<string, number>;
  // `${id}|${year}-${monthIndex}` -> this month's base (194-I per month).
  month: Map<string, number>;
};

export function newTdsTracker(history: ReadonlyMap<string, number>): TdsExposureTracker {
  return { fy: new Map(history), month: new Map() };
}

export type TdsDecision =
  | { applies: false; section: TdsSection | null }
  | { applies: true; section: TdsSection; rate: number; base: number; amount: number; account: string };

// Whether a bill for `expenseLedger` from `party` carries TDS on `date`,
// and the leg it carries. The exposure tracker is advanced whether or not
// TDS applies, exactly as checkTdsThresholds reads it.
export function tdsDecisionFor(params: {
  party: PartyRecord;
  expenseLedger: string;
  taxable: number;
  date: CalendarDate;
  tracker: TdsExposureTracker;
}): TdsDecision {
  const section = inferTdsSectionFromLedger(params.expenseLedger);
  if (!section) return { applies: false, section: null };
  const nature = inferTdsNature(section, [params.expenseLedger, params.party.ledgerName]);
  const id = `${params.party.ledgerName.trim().toLowerCase()}|${section}|${section === '194J' ? nature : ''}`;
  const fyAggregate = (params.tracker.fy.get(id) ?? 0) + params.taxable;
  params.tracker.fy.set(id, fyAggregate);
  const monthId = `${id}|${params.date.year}-${params.date.monthIndex}`;
  const monthAggregate = (params.tracker.month.get(monthId) ?? 0) + params.taxable;
  params.tracker.month.set(monthId, monthAggregate);
  const required = isTdsRequired(section, params.date, { bill: params.taxable, fyAggregate, monthAggregate });
  if (!required) return { applies: false, section };
  const rates = tdsRatesFor(section, params.date, { payeeType: payeeTypeFor(params.party), nature });
  const rate = effectiveTdsRate(rates[0], panAvailableFor(params.party));
  return {
    applies: true,
    section,
    rate,
    base: params.taxable,
    amount: roundTdsAmount((params.taxable * rate) / 100),
    account: `TDS Payable — u/s ${section}`,
  };
}

export type BuiltLeg = Omit<AnswerKeyEntry, 'concept_tags' | 'requires_source_document' | 'source_document_type'>;

export function gstEntry(sequence: number, voucherType: string, leg: GstLeg, drCr: 'Dr' | 'Cr'): BuiltLeg {
  return {
    sequence,
    correct_account: leg.account,
    dr_cr: drCr,
    amount: leg.amount,
    voucher_type: voucherType,
    gst_head: leg.head,
    gst_rate: leg.rate,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
  };
}

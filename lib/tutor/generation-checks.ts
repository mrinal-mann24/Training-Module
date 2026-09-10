import { normalizeBillReference, partyLegOf, splitBillReferences } from '@/lib/db/queries/company';
import type { AnswerKey, AnswerKeyEntry, GeneratedExercise } from '@/lib/schemas/exercise';

// Generation hygiene (2026-09-10 audits): three faults the checker could
// never catch because the answer key itself carried them.
// 1. A bill number reused from an earlier month (Yeshas, June: INV-024).
// 2. GST arithmetic off the rate (Garima, May: CGST and SGST of 5,000 each
//    on a 50,000 purchase, 10% a side).
// 3. TDS deducted below the year's threshold or missed above it (Praveen,
//    April 2025: 194C on the first advertising bill); rulebook 12.4.
// Each returns a retry message for the model, like the checks in
// generate-exercise.ts, and is a HARD violation: a batch with any of them
// is never delivered.

function groupBySequence(generated: GeneratedExercise): Map<number, AnswerKeyEntry[]> {
  const bySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of generated.answer_key.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  return bySequence;
}

const RAISING_VOUCHERS = /^(sales|purchase)$/i;

// Every bill number a sale or purchase has raised in the keys so far.
export function priorBillReferences(keys: AnswerKey[]): Set<string> {
  const refs = new Set<string>();
  for (const key of keys) {
    const bySequence = groupBySequence({ answer_key: key } as GeneratedExercise);
    for (const legs of bySequence.values()) {
      if (!RAISING_VOUCHERS.test(legs[0].voucher_type)) continue;
      const reference = legs.find((leg) => leg.bill_reference)?.bill_reference;
      if (!reference) continue;
      for (const ref of splitBillReferences(reference)) refs.add(normalizeBillReference(ref));
    }
  }
  return refs;
}

export function checkBillNumberUniqueness(generated: GeneratedExercise, priorRefs: Set<string>): string | null {
  const raised = new Set<string>();
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    if (!RAISING_VOUCHERS.test(legs[0].voucher_type)) continue;
    const reference = legs.find((leg) => leg.bill_reference)?.bill_reference;
    if (!reference) continue;
    for (const ref of splitBillReferences(reference)) {
      const normalized = normalizeBillReference(ref);
      if (priorRefs.has(normalized)) {
        violations.push(`transaction ${sequence} raises bill number ${ref}, which an earlier month already used`);
      } else if (raised.has(normalized)) {
        violations.push(`transaction ${sequence} raises bill number ${ref} twice in this batch`);
      }
      raised.add(normalized);
    }
  }
  if (violations.length === 0) return null;
  return `Bill numbers violated: ${violations.join('; ')}. Every invoice and bill number is unique across the whole year; use fresh numbers.`;
}

const GST_LEDGER = /gst/i;
const NON_BASE_LEDGER = /gst|tds|\bcash\b|\bbank\b|hdfc|round|discount/i;
const GST_TOLERANCE = 1;

function headOf(name: string): 'CGST' | 'SGST' | 'IGST' | null {
  if (/\bigst\b/i.test(name)) return 'IGST';
  if (/\bcgst\b/i.test(name)) return 'CGST';
  if (/\bsgst\b/i.test(name)) return 'SGST';
  return null;
}

// GST legs must equal the taxable base times the rate: CGST and SGST each
// half the rate, IGST the full rate. Multi-rate invoices (two legs of one
// head at different rates) are left alone; the base per rate is not
// identifiable from the legs.
export function checkGstArithmetic(generated: GeneratedExercise): string | null {
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    const type = legs[0].voucher_type.trim().toLowerCase();
    if (!/^(sales|purchase|credit note|debit note)$/.test(type)) continue;
    const gstLegs = legs.filter((leg) => GST_LEDGER.test(leg.correct_account) && headOf(leg.correct_account) !== null);
    if (gstLegs.length === 0) continue;
    const ratesByHead = new Map<string, Set<number>>();
    for (const leg of gstLegs) {
      const head = headOf(leg.correct_account)!;
      const set = ratesByHead.get(head) ?? new Set<number>();
      set.add(leg.gst_rate ?? 18);
      ratesByHead.set(head, set);
    }
    if ([...ratesByHead.values()].some((rates) => rates.size > 1)) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    const baseSide: 'Dr' | 'Cr' = type === 'sales' || type === 'debit note' ? 'Cr' : 'Dr';
    const base = legs
      .filter((leg) => leg !== party && leg.dr_cr === baseSide && !NON_BASE_LEDGER.test(leg.correct_account))
      .reduce((sum, leg) => sum + leg.amount, 0);
    if (base <= 0) continue;
    const posted = new Map<string, number>();
    for (const leg of gstLegs) {
      const head = headOf(leg.correct_account)!;
      posted.set(head, (posted.get(head) ?? 0) + leg.amount);
    }
    for (const [head, amount] of posted) {
      const rate = [...(ratesByHead.get(head) ?? [18])][0];
      const expected = head === 'IGST' ? (base * rate) / 100 : (base * rate) / 200;
      if (Math.abs(amount - expected) > GST_TOLERANCE) {
        violations.push(
          `transaction ${sequence}: ${head} is ${Math.round(amount)} on a taxable value of ${Math.round(base)} at ${rate}%, but should be ${Math.round(expected)} (${head === 'IGST' ? 'the full rate' : 'half the rate per head'})`,
        );
      }
    }
  }
  if (violations.length === 0) return null;
  return `GST arithmetic violated: ${violations.join('; ')}. Recompute every GST leg from the taxable value and the stated rate.`;
}

// TDS thresholds (rulebook 12.4): 194J professional 50,000 aggregate per
// year; 194C contractor 30,000 single or 1,00,000 aggregate; 194I rent
// 2,40,000 aggregate; 194H commission 15,000 aggregate. The section is
// inferred from the expense ledger of a purchase from a vendor.
export type TdsSection = '194J' | '194C' | '194I' | '194H';
const THRESHOLDS: Record<TdsSection, { aggregate: number; single?: number }> = {
  '194J': { aggregate: 50000 },
  '194C': { aggregate: 100000, single: 30000 },
  '194I': { aggregate: 240000 },
  '194H': { aggregate: 15000 },
};

export function inferTdsSection(expenseLedger: string): TdsSection | null {
  if (/\brent\b/i.test(expenseLedger)) return '194I';
  if (/legal|professional|audit|consult|advisory|accounting|\bfees?\b/i.test(expenseLedger)) return '194J';
  if (/repairs?|maintenance|contract|advertis|marketing|cleaning|housekeeping|interior|printing|logistic|freight|delivery|transport|security|catering|event|signage|works?\b/i.test(expenseLedger)) return '194C';
  if (/commission|brokerage/i.test(expenseLedger)) return '194H';
  return null;
}

export type TdsHistory = Map<string, number>; // `${vendor}|${section}` -> aggregate base this year

type TdsCase = { sequence: number; vendor: string; section: TdsSection; base: number; deducted: boolean };

function tdsCasesOf(entries: AnswerKeyEntry[]): TdsCase[] {
  const bySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  const cases: TdsCase[] = [];
  for (const [sequence, legs] of [...bySequence.entries()].sort((a, b) => a[0] - b[0])) {
    if (!/^purchase$/i.test(legs[0].voucher_type)) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    if (!party) continue;
    const expenseLegs = legs.filter((leg) => leg !== party && leg.dr_cr === 'Dr' && !NON_BASE_LEDGER.test(leg.correct_account) && !/^purchases?\b/i.test(leg.correct_account));
    if (expenseLegs.length === 0) continue;
    const explicit = legs.find((leg) => leg.tds_section)?.tds_section ?? null;
    const section = (explicit && /194[JCIH]/i.test(explicit) ? (explicit.match(/194[JCIH]/i)![0].toUpperCase() as TdsSection) : null) ?? inferTdsSection(expenseLegs[0].correct_account);
    if (!section) continue;
    const base = expenseLegs.reduce((sum, leg) => sum + leg.amount, 0);
    const deducted = explicit !== null || legs.some((leg) => /\btds\b/i.test(leg.correct_account));
    cases.push({ sequence, vendor: party.correct_account.trim().toLowerCase(), section, base, deducted });
  }
  return cases;
}

export function tdsHistoryFromKeys(keys: AnswerKey[]): TdsHistory {
  const history: TdsHistory = new Map();
  for (const key of keys) {
    for (const item of tdsCasesOf(key.entries)) {
      const id = `${item.vendor}|${item.section}`;
      history.set(id, (history.get(id) ?? 0) + item.base);
    }
  }
  return history;
}

export function checkTdsThresholds(generated: GeneratedExercise, history: TdsHistory): string | null {
  const running = new Map(history);
  const violations: string[] = [];
  for (const item of tdsCasesOf(generated.answer_key.entries)) {
    const id = `${item.vendor}|${item.section}`;
    const aggregate = (running.get(id) ?? 0) + item.base;
    running.set(id, aggregate);
    const threshold = THRESHOLDS[item.section];
    const crossed = aggregate >= threshold.aggregate || (threshold.single !== undefined && item.base >= threshold.single);
    if (item.deducted && !crossed) {
      violations.push(
        `transaction ${item.sequence} deducts TDS under ${item.section} for ${item.vendor} on ${Math.round(item.base)}, but the year's total with this bill is only ${Math.round(aggregate)} against a ${threshold.aggregate.toLocaleString('en-IN')} threshold${threshold.single ? ` (single bill ${threshold.single.toLocaleString('en-IN')})` : ''}: no TDS applies yet`,
      );
    } else if (!item.deducted && crossed) {
      violations.push(
        `transaction ${item.sequence} books ${Math.round(item.base)} from ${item.vendor} without TDS, but the year's total with this bill is ${Math.round(aggregate)}, past the ${item.section} threshold: TDS must be deducted at booking on the taxable base`,
      );
    }
  }
  if (violations.length === 0) return null;
  return `TDS thresholds violated: ${violations.join('; ')}. Apply the section thresholds on the running total for each payee.`;
}

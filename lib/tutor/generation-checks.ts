import { parseBillReferences, partyLegOf, type OpenBill } from '@/lib/db/queries/company';
import { looksLikeDate, normalizeDocumentNumber } from '@/lib/tutor/bill-reference';
import { extractTransactionDate } from '@/lib/documents/invoice-figures';
import type { AnswerKey, AnswerKeyEntry, ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';
import { BOOKS_BEGIN_MONTH_INDEX, BOOKS_BEGIN_YEAR } from '@/lib/tutor/timeline';
import {
  COMPANY_STATE_CODE,
  allowedGstRates,
  inferPayeeType,
  inferTdsNature,
  inferTdsSectionFromLedger,
  isTdsRequired,
  reverseChargeCategoryFor,
  roundTdsAmount,
  tdsRatesFor,
  tdsSectionFromText,
  tdsThresholdFor,
  type CalendarDate,
  type PayeeType,
  type TdsNature,
  type TdsSection as TaxRulesTdsSection,
} from '@/lib/tutor/tax-rules';

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
//
// 2026-09-17 audit: the rules themselves now come from the dated table in
// tax-rules.ts (FY 2024-25 and FY 2025-26 differ), and the checks no longer
// skip what they could not read: an unknown GST rate, a multi-rate invoice,
// a TDS leg on a Payment or Journal, a party new to the books, a bill number
// named only in the text.

type Entry = AnswerKeyEntry;

function groupBySequence(generated: Pick<GeneratedExercise, 'answer_key'>): Map<number, Entry[]> {
  const bySequence = new Map<number, Entry[]>();
  for (const entry of generated.answer_key.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  return new Map([...bySequence.entries()].sort((a, b) => a[0] - b[0]));
}

function typeOf(legs: Entry[]): string {
  return legs[0].voucher_type.trim().toLowerCase();
}

// Voucher dates, read from the transaction text the same way the documents
// read them. A batch with no date on a line is already a month violation;
// the fallback (the books' first day) only keeps these checks total.
export type DateOf = (sequence: number) => CalendarDate;

export function transactionDateOf(generated: Pick<GeneratedExercise, 'transactions'>, fallback?: CalendarDate): DateOf {
  const dates = new Map<number, CalendarDate>();
  for (const transaction of generated.transactions) {
    const date = extractTransactionDate(transaction.description);
    if (date) dates.set(transaction.sequence, date);
  }
  const defaultDate = fallback ?? { day: 1, monthIndex: BOOKS_BEGIN_MONTH_INDEX, year: BOOKS_BEGIN_YEAR };
  return (sequence) => dates.get(sequence) ?? defaultDate;
}

function formatDate(date: CalendarDate): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${String(date.day).padStart(2, '0')}-${months[date.monthIndex]}-${date.year}`;
}

const CASH_OR_BANK = /\bcash\b|cash-in-hand|\bbank\b|hdfc/i;

// ---------------------------------------------------------------- document numbers

// normalizeDocumentNumber and looksLikeDate live in bill-reference.ts since
// the Stage 0 refactor (2026-09-22); re-exported for their existing callers.
export { looksLikeDate, normalizeDocumentNumber };

function referenceOf(legs: Entry[]): string | null {
  return legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
}

const RAISES_OWN_NUMBER = /^(sales|purchase|credit note|debit note)$/;

// The numbers a voucher raises. Sales and purchases raise their document
// number; credit and debit notes raise the note number (a reference to a
// number already raised is the invoice the note is against); receipts and
// payments raise an advance reference. An advance named on the sale or
// purchase that adjusts it is not raised again.
function raisedNumbers(legs: Entry[], known: Set<string>): { own: string[]; advances: string[]; others: string[] } {
  const type = typeOf(legs);
  const parsed = parseBillReferences(referenceOf(legs));
  if (/^(sales|purchase)$/.test(type)) {
    const own = parsed.filter((item) => item.kind === 'bill').map((item) => item.ref);
    return { own, advances: [], others: parsed.filter((item) => item.kind !== 'bill').map((item) => item.ref) };
  }
  if (/^(credit note|debit note)$/.test(type)) {
    const own = parsed.filter((item) => item.kind === 'bill' && !known.has(normalizeDocumentNumber(item.ref))).map((item) => item.ref);
    return { own, advances: [], others: parsed.filter((item) => !own.includes(item.ref)).map((item) => item.ref) };
  }
  if (/^(receipt|payment)$/.test(type)) {
    return { own: [], advances: parsed.filter((item) => item.kind === 'advance').map((item) => item.ref), others: [] };
  }
  return { own: [], advances: [], others: [] };
}

// Every number a document or an advance has raised in the keys so far.
export function priorBillReferences(keys: AnswerKey[]): Set<string> {
  const refs = new Set<string>();
  for (const key of keys) {
    for (const legs of groupBySequence({ answer_key: key }).values()) {
      const { own, advances } = raisedNumbers(legs, refs);
      for (const ref of [...own, ...advances]) refs.add(normalizeDocumentNumber(ref));
    }
  }
  return refs;
}

// The same numbers as written, in first-raised order, for the prompt.
export function priorDocumentNumbers(keys: AnswerKey[]): string[] {
  const seen = new Set<string>();
  const numbers: string[] = [];
  for (const key of keys) {
    for (const legs of groupBySequence({ answer_key: key }).values()) {
      const { own, advances } = raisedNumbers(legs, seen);
      for (const ref of [...own, ...advances]) {
        const normalized = normalizeDocumentNumber(ref);
        if (seen.has(normalized)) continue;
        seen.add(normalized);
        numbers.push(ref);
      }
    }
  }
  return numbers;
}

export function checkBillNumberUniqueness(generated: GeneratedExercise, priorRefs: Set<string>): string | null {
  const raised = new Set<string>();
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    const type = typeOf(legs);
    const known = new Set([...priorRefs, ...raised]);
    const { own, advances, others } = raisedNumbers(legs, known);
    if (RAISES_OWN_NUMBER.test(type)) {
      const party = partyLegOf(legs, legs[0].voucher_type);
      const onCredit = party !== undefined && !CASH_OR_BANK.test(party.correct_account);
      if (own.length === 0 && others.length > 0 && /^(sales|purchase)$/.test(type)) {
        // Every printed invoice and bill needs its own number (2026-09-15).
        violations.push(
          `transaction ${sequence} adjusts ${others.join(', ')} but names no invoice or bill number of its own: write the advance first and the document's own number after it, like "ADV-C01 (Advance), INV-3001"`,
        );
      } else if (own.length === 0 && onCredit) {
        // 2026-09-17 audit: a credit sale, purchase or note with no number
        // cannot be tracked bill by bill, and its document prints no number.
        violations.push(
          `transaction ${sequence} is a credit ${legs[0].voucher_type} with ${party.correct_account} but names no ${type.includes('note') ? 'note' : 'invoice or bill'} number of its own: bill_reference must carry the document's own number`,
        );
      }
      if (own.length > 1) {
        // One document, one number: two own numbers means one of them is
        // really an advance or a settled bill written without its tag.
        violations.push(
          `transaction ${sequence} names ${own.join(', ')} as its own numbers: a document has exactly one; tag the advance it adjusts "(Advance)" and a bill it settles "(Against Ref)"`,
        );
      }
    }
    for (const ref of [...own, ...advances]) {
      const normalized = normalizeDocumentNumber(ref);
      if (looksLikeDate(ref)) {
        violations.push(`transaction ${sequence} numbers a document ${ref}, which is shaped like a date: use a number with no date in it, like INV-3104`);
      }
      if (priorRefs.has(normalized)) {
        violations.push(`transaction ${sequence} raises bill number ${ref}, which an earlier month already used`);
      } else if (raised.has(normalized)) {
        violations.push(`transaction ${sequence} raises bill number ${ref} twice in this batch`);
      }
      raised.add(normalized);
    }
  }
  if (violations.length === 0) return null;
  return `Bill numbers violated: ${violations.join('; ')}. Every invoice, bill, note and advance number is unique across the whole year (INV-18 and INV-018 are the same number); use fresh numbers.`;
}

// ---------------------------------------------------------------- GST

const GST_LEDGER = /gst/i;
const NON_BASE_LEDGER = /gst|tds|\bcash\b|\bbank\b|hdfc|round|discount/i;
const GST_TOLERANCE = 1;

type Head = 'CGST' | 'SGST' | 'IGST';

function headOf(name: string): Head | null {
  if (/\bigst\b/i.test(name)) return 'IGST';
  if (/\bcgst\b/i.test(name)) return 'CGST';
  if (/\bsgst\b/i.test(name)) return 'SGST';
  return null;
}

function isRcmLedger(name: string): boolean {
  return /\brcm\b|reverse charge/i.test(name);
}

function isGstLeg(leg: Entry): boolean {
  return GST_LEDGER.test(leg.correct_account) && headOf(leg.correct_account) !== null;
}

// The overall rate a leg's gst_rate means. Generated keys store the
// PER-HEAD rate on CGST/SGST legs (9 for 18% GST; every live key,
// 2026-09-11) and the whole rate on IGST; the authored pack and the
// prompt's older wording use the COMBINED rate (18 on each head). The
// per-head values (half of a slab) and the slabs never collide except at 0.
// Null when the figure is no GST rate at all.
export function combinedGstRate(head: Head, rate: number, date: CalendarDate | null = null): number | null {
  const slabs = allowedGstRates(date);
  const isSlab = (value: number) => slabs.some((slab) => Math.abs(slab - value) < 1e-9);
  const isPerHead = (value: number) => value !== 0 && slabs.some((slab) => Math.abs(slab / 2 - value) < 1e-9);
  if (head === 'IGST') {
    if (isSlab(rate)) return rate;
    if (isPerHead(rate)) return rate * 2;
    return null;
  }
  if (isPerHead(rate)) return rate * 2;
  if (isSlab(rate)) return rate;
  return null;
}

// The fraction of the taxable value a leg of this head carries.
export function perHeadFraction(head: Head, rate: number): number | null {
  const combined = combinedGstRate(head, rate, { day: 1, monthIndex: 0, year: 2100 });
  if (combined === null) return null;
  return head === 'IGST' ? combined / 100 : combined / 200;
}

function baseSideOf(type: string): 'Dr' | 'Cr' | null {
  if (/^(sales|debit note|receipt)$/.test(type)) return 'Cr';
  if (/^(purchase|credit note|payment)$/.test(type)) return 'Dr';
  return null;
}

function baseLegsOf(legs: Entry[], type: string, baseSide: 'Dr' | 'Cr'): Entry[] {
  const party = /^(sales|purchase|credit note|debit note)$/.test(type) ? partyLegOf(legs, legs[0].voucher_type) : undefined;
  return legs.filter((leg) => leg !== party && leg.dr_cr === baseSide && !NON_BASE_LEDGER.test(leg.correct_account));
}

function sum(legs: Entry[]): number {
  return legs.reduce((total, leg) => total + leg.amount, 0);
}

// A month-end set-off (Output against Input, or into GST Payable) is built
// and checked by month-end-journals.ts, not here.
function isSetOffJournal(legs: Entry[]): boolean {
  const gst = legs.filter(isGstLeg).filter((leg) => !isRcmLedger(leg.correct_account) && !/on advance/i.test(leg.correct_account));
  const touchesOutput = gst.some((leg) => /output/i.test(leg.correct_account));
  const touchesInput = gst.some((leg) => /input|itc/i.test(leg.correct_account));
  return (touchesOutput && touchesInput) || legs.some((leg) => /gst payable|cgst payable|sgst payable|igst payable/i.test(leg.correct_account));
}

// GST legs must equal the taxable value times the rate: CGST and SGST each
// half the rate (and always equal), IGST the full rate, never both regimes
// on one voucher, and the rate one GST actually has. A multi-rate invoice
// is checked through the taxable values its legs imply. Any voucher that
// carries GST legs is checked, not only sales and purchases.
export function checkGstArithmetic(generated: GeneratedExercise, options: { dateOf?: DateOf } = {}): string | null {
  const dateOf = options.dateOf ?? transactionDateOf(generated);
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    const type = typeOf(legs);
    const date = dateOf(sequence);
    const gstLegs = legs.filter(isGstLeg);

    if (gstLegs.length === 0) {
      // Pack-style metadata GST: gst_head/gst_rate on the party and base legs.
      const taxed = legs.find((leg) => leg.gst_head !== null);
      const baseSide = baseSideOf(type);
      if (!taxed || baseSide === null) continue;
      const heads = new Set(legs.map((leg) => leg.gst_head).filter((head): head is Head => head !== null));
      if (heads.has('IGST') && (heads.has('CGST') || heads.has('SGST'))) {
        violations.push(`transaction ${sequence} carries both IGST and CGST/SGST: a supply is either intra-state or inter-state`);
        continue;
      }
      if (taxed.gst_rate === null) {
        violations.push(`transaction ${sequence} names a GST head but no gst_rate`);
        continue;
      }
      const combined = combinedGstRate(taxed.gst_head as Head, taxed.gst_rate, date);
      if (combined === null) {
        violations.push(`transaction ${sequence}: gst_rate ${taxed.gst_rate} is not a GST rate (allowed: ${allowedGstRates(date).join(', ')}%)`);
        continue;
      }
      const base = sum(baseLegsOf(legs, type, baseSide));
      if (base <= 0) continue;
      const otherSide = legs.filter((leg) => leg.dr_cr !== baseSide);
      const stated = legs.find((leg) => leg.tds_rate !== null && leg.tds_base !== null);
      const tds = stated && baseSide === 'Dr' ? roundTdsAmount(((stated.tds_base ?? 0) * (stated.tds_rate ?? 0)) / 100) : 0;
      const expected = (base * (100 + combined)) / 100 - tds;
      if (Math.abs(sum(otherSide) - expected) > GST_TOLERANCE) {
        violations.push(
          `transaction ${sequence}: the other side totals ${Math.round(sum(otherSide))}, but a taxable value of ${Math.round(base)} at ${combined}% GST${tds ? ` less TDS ${tds}` : ''} gives ${Math.round(expected)}`,
        );
      }
      continue;
    }

    if (isSetOffJournal(legs)) continue;

    let rateProblem = false;
    const combinedOf = new Map<Entry, number>();
    for (const leg of gstLegs) {
      const head = headOf(leg.correct_account) as Head;
      if (leg.gst_rate === null) {
        violations.push(`transaction ${sequence}: the leg "${leg.correct_account}" carries no gst_rate`);
        rateProblem = true;
        continue;
      }
      const combined = combinedGstRate(head, leg.gst_rate, date);
      if (combined === null) {
        violations.push(
          `transaction ${sequence}: gst_rate ${leg.gst_rate} on "${leg.correct_account}" is not a GST rate (allowed overall rates on ${formatDate(date)}: ${allowedGstRates(date).join(', ')}%)`,
        );
        rateProblem = true;
        continue;
      }
      combinedOf.set(leg, combined);
    }

    // Never both regimes on one voucher (reverse-charge legs aside).
    const forwardHeads = new Set(gstLegs.filter((leg) => !isRcmLedger(leg.correct_account)).map((leg) => headOf(leg.correct_account)));
    if (forwardHeads.has('IGST') && (forwardHeads.has('CGST') || forwardHeads.has('SGST'))) {
      violations.push(`transaction ${sequence} carries both IGST and CGST/SGST legs: a supply is either intra-state or inter-state`);
      continue;
    }

    // CGST and SGST are always equal, per side and per rate.
    const pairKey = (leg: Entry) => `${leg.dr_cr}|${isRcmLedger(leg.correct_account)}|${combinedOf.get(leg) ?? 'x'}`;
    const cgstByKey = new Map<string, number>();
    const sgstByKey = new Map<string, number>();
    for (const leg of gstLegs) {
      const head = headOf(leg.correct_account);
      const bucket = head === 'CGST' ? cgstByKey : head === 'SGST' ? sgstByKey : null;
      if (bucket) bucket.set(pairKey(leg), (bucket.get(pairKey(leg)) ?? 0) + leg.amount);
    }
    for (const key of new Set([...cgstByKey.keys(), ...sgstByKey.keys()])) {
      const cgst = cgstByKey.get(key) ?? 0;
      const sgst = sgstByKey.get(key) ?? 0;
      if (Math.abs(cgst - sgst) > 0.5) {
        violations.push(`transaction ${sequence}: CGST ${Math.round(cgst)} and SGST ${Math.round(sgst)} differ; each is exactly half the tax`);
      }
    }
    if (rateProblem) continue;

    const baseSide = baseSideOf(type);
    // Reverse charge: the Output RCM tax mirrors the Input RCM credit, head by head.
    const rcmLegs = gstLegs.filter((leg) => isRcmLedger(leg.correct_account));
    if (rcmLegs.length > 0) {
      for (const head of ['CGST', 'SGST', 'IGST'] as Head[]) {
        const input = sum(rcmLegs.filter((leg) => headOf(leg.correct_account) === head && /input|itc/i.test(leg.correct_account)));
        const output = sum(rcmLegs.filter((leg) => headOf(leg.correct_account) === head && /output/i.test(leg.correct_account)));
        if (input > 0 && output > 0 && Math.abs(input - output) > 0.5) {
          violations.push(`transaction ${sequence}: Input ${head} RCM ${Math.round(input)} does not equal Output ${head} RCM ${Math.round(output)}`);
        }
      }
    }
    if (baseSide === null) continue;

    const sideLegs = gstLegs.filter((leg) => leg.dr_cr === baseSide);
    if (sideLegs.length === 0) continue;
    const baseLegs = baseLegsOf(legs, type, baseSide);
    const base = sum(baseLegs);
    if (base <= 0) continue;
    const rates = [...new Set(sideLegs.map((leg) => combinedOf.get(leg) as number))];

    if (rates.length === 1) {
      const posted = new Map<Head, number>();
      for (const leg of sideLegs) {
        const head = headOf(leg.correct_account) as Head;
        posted.set(head, (posted.get(head) ?? 0) + leg.amount);
      }
      const statedRate = sideLegs[0].gst_rate as number;
      for (const [head, amount] of posted) {
        const fraction = head === 'IGST' ? rates[0] / 100 : rates[0] / 200;
        const expected = base * fraction;
        if (Math.abs(amount - expected) > GST_TOLERANCE) {
          violations.push(
            `transaction ${sequence}: ${head} is ${Math.round(amount)} on a taxable value of ${Math.round(base)}, but at gst_rate ${statedRate} it should be ${Math.round(expected)} (${head === 'IGST' ? 'the whole rate' : `${fraction * 100}% for this head`})`,
          );
        }
      }
      continue;
    }

    // Multi-rate invoice (2026-09-17 audit: it used to be skipped). With a
    // rate on every base leg, each rate's base is known; otherwise the GST
    // legs of one head imply a taxable value per rate, and those must add
    // up to the taxable value.
    const referenceHead: Head = sideLegs.some((leg) => headOf(leg.correct_account) === 'IGST') ? 'IGST' : 'CGST';
    const fractionOf = (rate: number) => (referenceHead === 'IGST' ? rate / 100 : rate / 200);
    if (baseLegs.every((leg) => leg.gst_rate !== null)) {
      for (const rate of rates) {
        const rateBase = sum(baseLegs.filter((leg) => combinedGstRate(referenceHead, leg.gst_rate as number, date) === rate));
        for (const head of referenceHead === 'IGST' ? (['IGST'] as Head[]) : (['CGST', 'SGST'] as Head[])) {
          const amount = sum(sideLegs.filter((leg) => headOf(leg.correct_account) === head && combinedOf.get(leg) === rate));
          const expected = rateBase * fractionOf(rate);
          if (Math.abs(amount - expected) > GST_TOLERANCE) {
            violations.push(`transaction ${sequence}: ${head} at ${rate}% is ${Math.round(amount)}, but the ${rate}% taxable value ${Math.round(rateBase)} gives ${Math.round(expected)}`);
          }
        }
      }
      continue;
    }
    let implied = 0;
    for (const rate of rates) {
      const amount = sum(sideLegs.filter((leg) => headOf(leg.correct_account) === referenceHead && combinedOf.get(leg) === rate));
      implied += amount / fractionOf(rate);
    }
    const tolerance = rates.reduce((total, rate) => total + GST_TOLERANCE / fractionOf(rate), 0);
    if (Math.abs(implied - base) > tolerance) {
      violations.push(
        `transaction ${sequence}: the ${referenceHead} legs at ${rates.join('% and ')}% imply taxable values totalling ${Math.round(implied)}, but the taxable value is ${Math.round(base)}`,
      );
    }
  }
  if (violations.length === 0) return null;
  return `GST arithmetic violated: ${violations.join('; ')}. Recompute every GST leg from the taxable value and the stated rate.`;
}

// gst_head must agree with the ledger the leg names (2026-09-11): the
// party directory, the invoice figures and the month-end position read
// gst_head, while the arithmetic check and the scorer read the name. A leg
// called "Output IGST" with gst_head null would print a Karnataka address
// and a 29-series GSTIN on an inter-state invoice.
export function checkGstHeadMetadata(generated: GeneratedExercise): string | null {
  const violations: string[] = [];
  for (const entry of generated.answer_key.entries) {
    if (!GST_LEDGER.test(entry.correct_account)) continue;
    const named = headOf(entry.correct_account);
    if (named === null || entry.gst_head === named) continue;
    violations.push(
      `transaction ${entry.sequence}: the leg "${entry.correct_account}" must carry gst_head "${named}" (it ${entry.gst_head ? `says "${entry.gst_head}"` : 'is null'})`,
    );
  }
  if (violations.length === 0) return null;
  return `GST head metadata violated: ${violations.join('; ')}. Set gst_head on every GST ledger leg to the head its name states.`;
}

// Place of supply for EVERY party (2026-09-17 audit): the old consistency
// check only knew parties already in the books, so a new party could be
// taxed against the state its documents print. The party's state comes
// from its fixed identity; the GST follows the state, never the reverse.
export type StateCodeOf = (partyName: string) => string | null;

export function checkPlaceOfSupply(generated: GeneratedExercise, stateCodeOf: StateCodeOf): string | null {
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    const type = typeOf(legs);
    if (!/^(sales|purchase|credit note|debit note)$/.test(type)) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    if (!party || CASH_OR_BANK.test(party.correct_account)) continue;
    const heads = new Set<Head>();
    for (const leg of legs) {
      if (isRcmLedger(leg.correct_account)) continue;
      const head = isGstLeg(leg) ? headOf(leg.correct_account) : leg.gst_head;
      if (head) heads.add(head);
    }
    if (heads.size === 0) continue;
    const stateCode = stateCodeOf(party.correct_account);
    if (stateCode === null) continue;
    const intraState = stateCode === COMPANY_STATE_CODE;
    if (intraState && heads.has('IGST')) {
      violations.push(`transaction ${sequence} charges IGST, but ${party.correct_account} is in Karnataka (state code ${COMPANY_STATE_CODE}): CGST and SGST apply`);
    } else if (!intraState && (heads.has('CGST') || heads.has('SGST'))) {
      violations.push(`transaction ${sequence} charges CGST/SGST, but ${party.correct_account} is outside Karnataka (state code ${stateCode}): IGST applies`);
    }
  }
  if (violations.length === 0) return null;
  return `Place of supply violated: ${violations.join('; ')}. Each party has one fixed state; tax it by that state, or use a different party.`;
}

// Reverse charge (2026-09-17 audit; Notification 13/2017-CT(Rate) entry 2):
// an advocate's or law firm's bill to a business carries no GST from the
// supplier. The pack's Sharma Legal bill charged GST forward.
export function checkReverseCharge(generated: GeneratedExercise): string | null {
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    if (typeOf(legs) !== 'purchase') continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    if (!party) continue;
    const expenseLedgers = legs.filter((leg) => leg !== party && leg.dr_cr === 'Dr' && !NON_BASE_LEDGER.test(leg.correct_account)).map((leg) => leg.correct_account);
    const category = reverseChargeCategoryFor({ party: party.correct_account, expenseLedgers });
    if (!category || !category.mandatory) continue;
    const forward = legs.some((leg) => (isGstLeg(leg) && !isRcmLedger(leg.correct_account)) || (!isGstLeg(leg) && leg.gst_head !== null && !legs.some((other) => isRcmLedger(other.correct_account))));
    if (forward) {
      violations.push(
        `transaction ${sequence} books GST charged by ${party.correct_account}, but ${category.description} is under reverse charge (${category.citation}): the supplier's bill carries no GST, and the company books Input and Output GST RCM itself`,
      );
    }
  }
  if (violations.length === 0) return null;
  return `Reverse charge violated: ${violations.join('; ')}.`;
}

// ---------------------------------------------------------------- TDS

export type TdsSection = TaxRulesTdsSection;

export function inferTdsSection(expenseLedger: string): TdsSection | null {
  return inferTdsSectionFromLedger(expenseLedger);
}

// `${payee}|${section}|${nature}` -> aggregate taxable base this year.
export type TdsHistory = Map<string, number>;

type TdsCase = {
  sequence: number;
  vendor: string;
  section: TdsSection;
  nature: TdsNature;
  base: number;
  deducted: boolean;
};

function isTdsDeductionLeg(leg: Entry, type: string): boolean {
  if (!/\btds\b/i.test(leg.correct_account)) return false;
  if (type === 'receipt') return leg.dr_cr === 'Dr' && /receivable/i.test(leg.correct_account);
  return leg.dr_cr === 'Cr' && !/receivable/i.test(leg.correct_account);
}

function expenseLegsOf(legs: Entry[], type: string, party: Entry | undefined): Entry[] {
  return legs.filter(
    (leg) =>
      leg.dr_cr === 'Dr' &&
      (type === 'payment' || leg !== party) &&
      !NON_BASE_LEDGER.test(leg.correct_account) &&
      !/^purchases?\b/i.test(leg.correct_account),
  );
}

function payeeOf(legs: Entry[], type: string): Entry | undefined {
  if (type === 'purchase') return partyLegOf(legs, legs[0].voucher_type);
  if (type === 'journal') {
    return legs.find((leg) => leg.dr_cr === 'Cr' && !NON_BASE_LEDGER.test(leg.correct_account) && !/outstanding|provision|payable/i.test(leg.correct_account));
  }
  return undefined;
}

// Every voucher the threshold rule reads: a purchase of a service, a
// direct expense payment that settles no bill, and any Payment or Journal
// that carries a TDS deduction (2026-09-17 audit: those used to be skipped).
// The section comes from the TDS ledger or tds_section first, the expense
// ledger only when neither names it.
function tdsCasesOf(entries: Entry[]): TdsCase[] {
  const cases: TdsCase[] = [];
  for (const [sequence, legs] of groupBySequence({ answer_key: { entries } })) {
    const type = typeOf(legs);
    if (!/^(purchase|payment|journal)$/.test(type)) continue;
    const deductionLegs = legs.filter((leg) => isTdsDeductionLeg(leg, type));
    const deducted = deductionLegs.length > 0 || legs.some((leg) => leg.tds_section !== null);
    if (type === 'journal' && !deducted) continue;
    if (type === 'payment' && !deducted && referenceOf(legs) !== null) continue;
    const party = payeeOf(legs, type);
    const expenseLegs = expenseLegsOf(legs, type, party);
    if (expenseLegs.length === 0) continue;
    const named =
      tdsSectionFromText(deductionLegs[0]?.correct_account) ?? tdsSectionFromText(legs.find((leg) => leg.tds_section)?.tds_section);
    const section = named ?? inferTdsSectionFromLedger(expenseLegs[0].correct_account);
    if (!section) continue;
    const payee = party ?? expenseLegs[0];
    cases.push({
      sequence,
      vendor: payee.correct_account.trim().toLowerCase(),
      section,
      nature: inferTdsNature(section, [...expenseLegs.map((leg) => leg.correct_account), payee.correct_account]),
      base: sum(expenseLegs),
      deducted,
    });
  }
  return cases;
}

function historyKey(item: Pick<TdsCase, 'vendor' | 'section' | 'nature'>): string {
  // 194J's threshold runs per category (professional vs technical).
  return `${item.vendor}|${item.section}|${item.section === '194J' ? item.nature : ''}`;
}

export function tdsHistoryFromKeys(keys: AnswerKey[]): TdsHistory {
  const history: TdsHistory = new Map();
  for (const key of keys) {
    for (const item of tdsCasesOf(key.entries)) {
      const id = historyKey(item);
      history.set(id, (history.get(id) ?? 0) + item.base);
    }
  }
  return history;
}

export function checkTdsThresholds(generated: GeneratedExercise, history: TdsHistory, options: { dateOf?: DateOf } = {}): string | null {
  const dateOf = options.dateOf ?? transactionDateOf(generated);
  const running = new Map(history);
  const monthRunning = new Map<string, number>();
  const violations: string[] = [];
  for (const item of tdsCasesOf(generated.answer_key.entries)) {
    const date = dateOf(item.sequence);
    const id = historyKey(item);
    const fyAggregate = (running.get(id) ?? 0) + item.base;
    running.set(id, fyAggregate);
    const monthId = `${id}|${date.year}-${date.monthIndex}`;
    const monthAggregate = (monthRunning.get(monthId) ?? 0) + item.base;
    monthRunning.set(monthId, monthAggregate);
    const required = isTdsRequired(item.section, date, { bill: item.base, fyAggregate, monthAggregate });
    const threshold = tdsThresholdFor(item.section, date);
    const limit =
      threshold.kind === 'per_month'
        ? `${threshold.monthly.toLocaleString('en-IN')} a month`
        : `${threshold.aggregate.toLocaleString('en-IN')}${threshold.kind === 'fy_aggregate' && threshold.single ? ` (single bill ${threshold.single.toLocaleString('en-IN')})` : ''}`;
    if (item.deducted && !required) {
      violations.push(
        `transaction ${item.sequence} deducts TDS under ${item.section} for ${item.vendor} on ${Math.round(item.base)}, but the year's total with this bill is only ${Math.round(fyAggregate)} against a ${limit} threshold on ${formatDate(date)}: no TDS applies yet`,
      );
    } else if (!item.deducted && required) {
      violations.push(
        `transaction ${item.sequence} books ${Math.round(item.base)} from ${item.vendor} without TDS, but the year's total with this bill is ${Math.round(fyAggregate)}, past the ${item.section} threshold of ${limit} on ${formatDate(date)}: TDS must be deducted at booking on the taxable base`,
      );
    }
  }
  if (violations.length === 0) return null;
  return `TDS thresholds violated: ${violations.join('; ')}. Apply the section thresholds on the running total for each payee.`;
}

// The TDS leg must equal tds_base x tds_rate (2026-09-11), and since the
// 2026-09-17 audit the rate must be the section's rate for that payee and
// service on the voucher date, tds_base must be the taxable expense (never
// the GST-inclusive total), and the deduction is rounded to the rupee.
export type PayeeTypeOf = (partyName: string) => PayeeType;

export function checkTdsArithmetic(generated: GeneratedExercise, options: { dateOf?: DateOf; payeeTypeOf?: PayeeTypeOf } = {}): string | null {
  const dateOf = options.dateOf ?? transactionDateOf(generated);
  const payeeTypeOf = options.payeeTypeOf ?? ((name: string) => inferPayeeType(name));
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    const type = typeOf(legs);
    const deductionLegs = legs.filter((leg) => isTdsDeductionLeg(leg, type));
    const fieldLeg = legs.find((leg) => leg.tds_section !== null);
    if (deductionLegs.length === 0 && !fieldLeg) continue;

    const fromLedger = tdsSectionFromText(deductionLegs[0]?.correct_account);
    const fromField = tdsSectionFromText(fieldLeg?.tds_section);
    if (fromLedger && fromField && fromLedger !== fromField) {
      violations.push(`transaction ${sequence}: the TDS ledger says ${fromLedger} but tds_section says ${fromField}`);
    }
    const party = type === 'receipt' || type === 'purchase' ? partyLegOf(legs, legs[0].voucher_type) : payeeOf(legs, type);
    const expenseLegs = type === 'receipt' ? [] : expenseLegsOf(legs, type, party);
    const section = fromLedger ?? fromField ?? (expenseLegs[0] ? inferTdsSectionFromLedger(expenseLegs[0].correct_account) : null);

    const stated = legs.find((leg) => leg.tds_rate !== null && leg.tds_base !== null);
    if (!stated || stated.tds_rate === null || stated.tds_base === null) {
      if (deductionLegs.length > 0) {
        violations.push(`transaction ${sequence} deducts TDS but states no tds_base and tds_rate: put both on the TDS leg`);
      }
      continue;
    }

    if (section) {
      const date = dateOf(sequence);
      const payeeName = party?.correct_account ?? expenseLegs[0]?.correct_account ?? '';
      const nature = inferTdsNature(section, [...expenseLegs.map((leg) => leg.correct_account), payeeName]);
      const allowed = tdsRatesFor(section, date, { payeeType: payeeTypeOf(payeeName), nature });
      // 206AA's 20% is the only other rate a deduction may carry.
      if (!allowed.includes(stated.tds_rate) && stated.tds_rate !== 20) {
        violations.push(
          `transaction ${sequence}: TDS at ${stated.tds_rate}% is not the ${section} rate for ${payeeName || 'this payee'} on ${formatDate(date)} (${allowed.join('% or ')}%)`,
        );
      }
    }

    const expenseTotal = sum(expenseLegs);
    if (expenseTotal > 0 && Math.abs(stated.tds_base - expenseTotal) > 0.5) {
      violations.push(
        `transaction ${sequence}: tds_base is ${Math.round(stated.tds_base)}, but the taxable expense legs total ${Math.round(expenseTotal)}: TDS is on the value excluding GST`,
      );
    }

    if (deductionLegs.length > 0) {
      const expected = roundTdsAmount((stated.tds_base * stated.tds_rate) / 100);
      const posted = sum(deductionLegs);
      if (Math.abs(posted - expected) > 0.01) {
        violations.push(
          `transaction ${sequence}: the TDS leg is ${posted}, but tds_base ${Math.round(stated.tds_base)} at ${stated.tds_rate}% gives ${expected} (rounded to the rupee)`,
        );
      }
    }
  }
  if (violations.length === 0) return null;
  return `TDS arithmetic violated: ${violations.join('; ')}. Recompute the TDS leg from tds_base and tds_rate, and the net party or bank leg from it.`;
}

// ---------------------------------------------------------------- text vs key

// A bill-shaped token: capital letters, then digits or letters in groups
// joined by "-" or "/", with at least one digit ("INV-018", "MS/990",
// "BR/S/098", "ADV-C01", "CA26-101"). Words joined by a hyphen
// ("billboard-advertising") and dates are not bill numbers.
const BILL_TOKEN_PATTERN = /(?<![A-Za-z0-9/-])([A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+)(?![A-Za-z0-9]|[-/][A-Za-z0-9])/g;
const NOT_A_BILL = /^(?:GSTR|FORM|RULE|SEC|UPI|NEFT|IMPS|RTGS|UTR|COVID|PAN|TAN|GSTIN)\b|^(?:JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)[A-Z]*[-/]\d{2,4}$/i;

export function billTokensIn(text: string): string[] {
  const tokens: string[] = [];
  for (const match of text.matchAll(BILL_TOKEN_PATTERN)) {
    const token = match[1];
    if (!/\d/.test(token) || NOT_A_BILL.test(token)) continue;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

const RUPEE_IN_TEXT = /(?:₹|\bRs\.?|\bINR)\s*([\d,]+(?:\.\d+)?)/gi;
const TEXT_FIGURE_TOLERANCE = 1;
const THRESHOLD_FIGURES = [15000, 20000, 30000, 50000, 100000, 240000];

function subsetSums(amounts: number[]): number[] {
  if (amounts.length > 10) return [amounts.reduce((total, amount) => total + amount, 0)];
  const sums: number[] = [];
  for (let mask = 1; mask < 1 << amounts.length; mask++) {
    let total = 0;
    amounts.forEach((amount, index) => {
      if (mask & (1 << index)) total += amount;
    });
    sums.push(total);
  }
  return sums;
}

// What a transaction line tells the learner must be what the key scores
// (2026-09-17 audit, CRITICAL: fillBillReferencesFromText filled only empty
// references and never compared, so a line naming INV-062 could be scored
// against INV-061). Every bill-shaped token in any line must be one of that
// sequence's references; every rupee figure in a line without a document
// must be a figure of that sequence's key (a leg, a sum of legs, the TDS
// base or amount, a bill it settles and what remains on it, or a statutory
// threshold).
export function checkTextMatchesKey(generated: GeneratedExercise, openBills: OpenBill[] = []): string | null {
  const bySequence = groupBySequence(generated);
  const violations: string[] = [];
  const batchBills = new Map<string, number>();
  for (const legs of bySequence.values()) {
    if (!/^(sales|purchase)$/.test(typeOf(legs))) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    for (const parsed of parseBillReferences(referenceOf(legs))) {
      if (parsed.kind === 'bill' && party) batchBills.set(normalizeDocumentNumber(parsed.ref), party.amount);
    }
  }

  for (const transaction of generated.transactions) {
    const legs = bySequence.get(transaction.sequence) ?? [];
    const refs = new Map<string, string>();
    for (const leg of legs) {
      for (const parsed of parseBillReferences(leg.bill_reference)) refs.set(normalizeDocumentNumber(parsed.ref), parsed.ref);
    }
    for (const token of billTokensIn(transaction.description)) {
      if (refs.has(normalizeDocumentNumber(token))) continue;
      violations.push(
        `transaction ${transaction.sequence} names ${token} in its text, but its answer key's bill_reference is ${refs.size > 0 ? `"${[...refs.values()].join(', ')}"` : 'empty'}`,
      );
    }

    const documentBacked = legs.some((leg) => leg.requires_source_document && leg.source_document_type !== null);
    if (documentBacked || legs.length === 0) continue;
    const figures: number[] = [];
    for (const side of ['Dr', 'Cr'] as const) figures.push(...subsetSums(legs.filter((leg) => leg.dr_cr === side).map((leg) => leg.amount)));
    for (const leg of legs) {
      if (leg.tds_base !== null) figures.push(leg.tds_base);
      if (leg.tds_base !== null && leg.tds_rate !== null) figures.push(roundTdsAmount((leg.tds_base * leg.tds_rate) / 100));
      if (leg.gst_head !== null && leg.gst_rate !== null && !isGstLeg(leg)) {
        const combined = combinedGstRate(leg.gst_head, leg.gst_rate) ?? leg.gst_rate;
        figures.push((leg.amount * combined) / 100, (leg.amount * combined) / 200);
      }
    }
    const party = partyLegOf(legs, legs[0].voucher_type);
    const partyAmount = party ? party.amount : 0;
    for (const ref of refs.keys()) {
      const open = [...openBills.filter((bill) => normalizeDocumentNumber(bill.ref) === ref).map((bill) => Math.abs(bill.open)), batchBills.get(ref) ?? 0].filter((value) => value > 0);
      for (const value of open) figures.push(value, value - partyAmount);
    }
    figures.push(...THRESHOLD_FIGURES);
    for (const match of transaction.description.matchAll(RUPEE_IN_TEXT)) {
      const value = Number(match[1].replace(/,/g, ''));
      if (!Number.isFinite(value) || value === 0) continue;
      if (figures.some((figure) => Math.abs(figure - value) <= TEXT_FIGURE_TOLERANCE)) continue;
      const after = transaction.description.slice((match.index ?? 0) + match[0].length);
      if (/^\s*(?:per|each|\/|a (?:unit|piece|kg|litre|box))\b/i.test(after)) continue;
      violations.push(`transaction ${transaction.sequence} states ${match[0].trim()} in its text, but no figure of its answer key is ${value.toLocaleString('en-IN')}`);
    }
  }
  if (violations.length === 0) return null;
  return `Text and answer key disagree: ${violations.join('; ')}. The line the learner reads and the hidden key must carry the same bill numbers and figures.`;
}

// ---------------------------------------------------------------- concept tags

// A tag must name what the transaction actually drills (2026-09-17 audit):
// a tds_classification tag on a voucher with no TDS, or bill_by_bill on a
// voucher with no reference, is marked correct whatever the learner posts,
// and counts towards mastery for a concept never exercised.
const CONCEPT_EVIDENCE: Partial<Record<ConceptTag, { test: (legs: Entry[]) => boolean; needs: string }>> = {
  // A credit note is the sales-side return, a debit note the purchase-side one.
  sales_voucher_basics: { test: (legs) => /^(sales|credit note)$/.test(typeOf(legs)), needs: 'a Sales or Credit Note voucher' },
  purchase_voucher_basics: { test: (legs) => /^(purchase|debit note)$/.test(typeOf(legs)), needs: 'a Purchase or Debit Note voucher' },
  payment_voucher_basics: { test: (legs) => typeOf(legs) === 'payment', needs: 'a Payment voucher' },
  receipt_voucher_basics: { test: (legs) => typeOf(legs) === 'receipt', needs: 'a Receipt voucher' },
  contra_voucher_basics: { test: (legs) => typeOf(legs) === 'contra', needs: 'a Contra voucher' },
  journal_voucher_basics: { test: (legs) => typeOf(legs) === 'journal', needs: 'a Journal voucher' },
  gst_classification: { test: (legs) => legs.some((leg) => isGstLeg(leg) || leg.gst_head !== null), needs: 'GST legs' },
  tds_classification: {
    test: (legs) => legs.some((leg) => /\btds\b/i.test(leg.correct_account) || leg.tds_section !== null),
    needs: 'a TDS leg',
  },
  tds_on_receipt: {
    test: (legs) => typeOf(legs) === 'receipt' && legs.some((leg) => /\btds\b/i.test(leg.correct_account) && /receivable/i.test(leg.correct_account)),
    needs: 'a Receipt with a TDS Receivable leg',
  },
  bill_by_bill_referencing: { test: (legs) => referenceOf(legs) !== null, needs: 'a bill reference' },
  customer_advance: {
    test: (legs) => parseBillReferences(referenceOf(legs)).some((item) => item.kind === 'advance') || legs.some((leg) => /on advance/i.test(leg.correct_account)),
    needs: 'an Advance reference',
  },
  supplier_advance: {
    test: (legs) => parseBillReferences(referenceOf(legs)).some((item) => item.kind === 'advance'),
    needs: 'an Advance reference',
  },
  on_account_reference: {
    test: (legs) => parseBillReferences(referenceOf(legs)).some((item) => item.kind === 'on_account'),
    needs: 'an On Account reference',
  },
  multi_bill_settlement: { test: (legs) => parseBillReferences(referenceOf(legs)).length >= 2, needs: 'two or more bill references' },
  gst_set_off: { test: (legs) => typeOf(legs) === 'journal' && isSetOffJournal(legs), needs: 'a GST set-off journal' },
  gst_payment: { test: (legs) => legs.some((leg) => leg.dr_cr === 'Dr' && /gst payable|cgst payable|sgst payable|igst payable/i.test(leg.correct_account)), needs: 'a payment of GST Payable' },
  rcm_and_late_fee: {
    test: (legs) => legs.some((leg) => isRcmLedger(leg.correct_account) || /late fee|interest on (?:delayed )?gst|gst interest/i.test(leg.correct_account)),
    needs: 'reverse-charge GST legs or a GST late fee/interest leg',
  },
  fixed_assets_depreciation: {
    test: (legs) => legs.some((leg) => /depreciation|equipment|furniture|computer|machinery|vehicle|fixed asset|plant/i.test(leg.correct_account)),
    needs: 'a fixed asset or depreciation leg',
  },
};

export function checkConceptTagsMatchContent(generated: GeneratedExercise): string | null {
  const violations: string[] = [];
  for (const [sequence, legs] of groupBySequence(generated)) {
    const tags = new Set(legs.flatMap((leg) => leg.concept_tags));
    for (const tag of tags) {
      const evidence = CONCEPT_EVIDENCE[tag];
      if (evidence && !evidence.test(legs)) {
        violations.push(`transaction ${sequence} is tagged ${tag} but lacks ${evidence.needs}`);
      }
    }
  }
  if (violations.length === 0) return null;
  return `Concept tags violated: ${violations.join('; ')}. Tag each transaction only with the concepts it genuinely exercises.`;
}

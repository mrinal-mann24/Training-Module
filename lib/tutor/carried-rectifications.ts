import { z } from 'zod';
import type { AnswerKeyEntry, GeneratedExercise, GstHead } from '@/lib/schemas/exercise';
import { parseBillReferences } from '@/lib/tutor/bill-reference';
import { billTokensIn } from '@/lib/tutor/generation-checks';

// Carried rectifications (2026-09-22, rebuild Part B). A delivered batch that
// taught a wrong posting through our mistake is never rewritten: the key is
// what the learner was scored against and their books mirror it. The owner
// records the correcting journal (carried_rectifications table) and the
// learner's next batch carries it as a real transaction whose text and
// answer-key legs are built HERE, from the recorded legs, so the learner's
// line and the hidden key cannot disagree (the generator's text-vs-key
// rules are applied to the owner's sentence before anything is appended).

export const RectificationLegSchema = z.object({
  account: z.string().trim().min(1),
  dr_cr: z.enum(['Dr', 'Cr']),
  amount: z.number().positive().finite(),
  bill_reference: z.string().trim().min(1).nullable().optional(),
  narration: z.string().trim().min(1).nullable().optional(),
});
export type RectificationLeg = z.infer<typeof RectificationLegSchema>;

export const RectificationLegsSchema = z.array(RectificationLegSchema).min(2).max(12);

export type CarriedRectification = {
  id: string;
  // The owner's sentence for the learner: what was wrong and why, no date.
  learnerText: string;
  legs: RectificationLeg[];
};

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const RUPEE_IN_TEXT = /(?:₹|\bRs\.?|\bINR)\s*([\d,]+(?:\.\d+)?)/gi;
// The rectification is posted early in the month; Educational Mode redating
// (finalizeBatch) maps this to an allowed day.
const RECTIFICATION_DAY = 3;

const round2 = (value: number): number => Math.round(value * 100) / 100;

function rupees(amount: number): string {
  return Number.isInteger(amount) ? amount.toLocaleString('en-IN') : amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function dateLabel(day: number, monthIndex: number, year: number): string {
  return `${String(day).padStart(2, '0')}-${MONTH_ABBREVS[monthIndex]}-${year}`;
}

function gstHeadOf(account: string): GstHead | null {
  if (!/gst/i.test(account)) return null;
  if (/cgst/i.test(account)) return 'CGST';
  if (/sgst/i.test(account)) return 'SGST';
  if (/igst/i.test(account)) return 'IGST';
  return null;
}

// Why a recorded rectification cannot be carried, or null when it can. The
// generator's own checks would reject the batch three times and throw;
// refusing the row up front names the row instead.
export function validateRectification(rectification: CarriedRectification): string | null {
  const parsed = RectificationLegsSchema.safeParse(rectification.legs);
  if (!parsed.success) return `rectification ${rectification.id}: legs are malformed (${parsed.error.issues[0]?.message ?? 'schema'})`;
  const legs = parsed.data;
  const debit = round2(legs.filter((leg) => leg.dr_cr === 'Dr').reduce((sum, leg) => sum + leg.amount, 0));
  const credit = round2(legs.filter((leg) => leg.dr_cr === 'Cr').reduce((sum, leg) => sum + leg.amount, 0));
  if (Math.abs(debit - credit) > 0.005) return `rectification ${rectification.id}: debits ${debit} do not equal credits ${credit}`;
  if (legs.some((leg) => round2(leg.amount) !== leg.amount)) return `rectification ${rectification.id}: amounts must be in paise`;
  const text = rectification.learnerText.trim();
  if (text.length === 0) return `rectification ${rectification.id}: learner text is empty`;
  if (/\bOn\s+\d{1,2}-[A-Za-z]{3}-\d{4}\b|\b\d{1,2}(?:st|nd|rd|th)?\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\s+\d{4}\b/.test(text)) {
    return `rectification ${rectification.id}: learner text must not carry a date; the batch dates it`;
  }
  // The same rules the generator applies to the model's lines
  // (checkTextMatchesKey): every rupee figure is a leg amount or a side
  // total, every bill-shaped token is one of the legs' references.
  const figures = new Set([...legs.map((leg) => leg.amount), debit]);
  for (const match of text.matchAll(RUPEE_IN_TEXT)) {
    const value = Number(match[1].replace(/,/g, ''));
    if (![...figures].some((figure) => Math.abs(figure - value) <= 1)) {
      return `rectification ${rectification.id}: the text states ${match[0].trim()}, which is no leg amount`;
    }
  }
  const references = new Set(legs.flatMap((leg) => parseBillReferences(leg.bill_reference).map((parsed) => parsed.ref)));
  for (const token of billTokensIn(text)) {
    if (!references.has(token)) return `rectification ${rectification.id}: the text names ${token}, which is no leg's bill reference`;
  }
  return null;
}

// The learner's line: the owner's sentence, then the journal spelled out
// leg by leg so a documents-mode month-end note and a plain brief both
// carry every ledger and amount.
export function describeRectification(rectification: CarriedRectification, date: string): string {
  const legs = rectification.legs;
  const spell = (leg: RectificationLeg) => `${leg.dr_cr} ${leg.account} Rs ${rupees(leg.amount)}${leg.bill_reference ? `, bill reference ${leg.bill_reference}` : ''}`;
  const sentence = rectification.learnerText.trim();
  const ended = /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
  return `On ${date}, post a rectification journal. ${ended} Journal: ${[...legs.filter((leg) => leg.dr_cr === 'Dr'), ...legs.filter((leg) => leg.dr_cr === 'Cr')].map(spell).join('; ')}.`;
}

// Appends every rectification as its own Journal transaction after the
// model's (or the builder's) transactions, before the month-end journals
// and the final dating. Throws on a row that cannot be carried: a wrong
// correction must never reach a learner silently.
export function appendCarriedRectifications(
  generated: GeneratedExercise,
  rectifications: readonly CarriedRectification[],
  month: { monthIndex: number; year: number },
): GeneratedExercise {
  if (rectifications.length === 0) return generated;
  let transactions = [...generated.transactions];
  let entries: AnswerKeyEntry[] = [...generated.answer_key.entries];
  let sequence = Math.max(0, ...transactions.map((transaction) => transaction.sequence), ...entries.map((entry) => entry.sequence));
  const date = dateLabel(RECTIFICATION_DAY, month.monthIndex, month.year);

  for (const rectification of rectifications) {
    const problem = validateRectification(rectification);
    if (problem) throw new Error(`Carried rectification refused: ${problem}`);
    sequence += 1;
    transactions = [...transactions, { sequence, description: describeRectification(rectification, date) }];
    entries = [
      ...entries,
      ...rectification.legs.map(
        (leg): AnswerKeyEntry => ({
          sequence,
          correct_account: leg.account,
          dr_cr: leg.dr_cr,
          amount: leg.amount,
          voucher_type: 'Journal',
          gst_head: gstHeadOf(leg.account),
          gst_rate: null,
          tds_section: null,
          tds_rate: null,
          tds_base: null,
          bill_reference: leg.bill_reference ?? null,
          narration: leg.narration ?? rectification.learnerText.trim(),
          concept_tags: ['journal_voucher_basics'],
          requires_source_document: false,
          source_document_type: null,
        }),
      ),
    ];
  }
  const carried = [...(generated.answer_key.carried_rectification_ids ?? []), ...rectifications.map((rectification) => rectification.id)];
  return { ...generated, transactions, answer_key: { ...generated.answer_key, entries, carried_rectification_ids: carried } };
}

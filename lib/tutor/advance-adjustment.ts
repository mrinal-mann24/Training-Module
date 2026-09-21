import {
  documentNumberOf,
  openAdvancesFromKeys,
  parseBillReferences,
  partyLegOf,
  type OpenAdvance,
  type OpeningBalance,
} from '@/lib/db/queries/company';
import type { AnswerKey, GeneratedExercise } from '@/lib/schemas/exercise';
import { normalizeAccountName } from './account-names';

// Advances carried into a batch (2026-09-21). An advance paid to a supplier
// or received from a customer in an earlier month is adjusted by that
// party's next bill or invoice. Praveen's April pack paid Bharat Machinery
// Rs 50,000 as ADV-02; June's key raised the Rs 1,00,300 bill BM/2025-06
// as a plain new bill, so his correct "against the advance, balance as a new
// bill" posting was marked wrong. The key now names the advance first and
// the document's own number after it ("ADV-02 (Advance), BM/2025-06"), the
// same shape the model writes for an advance inside the batch.

// The advances still open at the start of the batch. An advance is capped by
// the party's opening balance on the advance's side: a supplier holding an
// advance is in debit, a customer who paid one is in credit. A party whose
// balance has already turned (Bharat Machinery after June, in credit
// Rs 50,300) has nothing left to adjust, even when an earlier key raised the
// bill without naming the advance.
export function advancesToAdjust(priorKeys: AnswerKey[], openingBalances: OpeningBalance[]): OpenAdvance[] {
  const netByParty = new Map<string, number>();
  for (const opening of openingBalances) {
    const party = normalizeAccountName(opening.account);
    netByParty.set(party, (netByParty.get(party) ?? 0) + (opening.dr_cr === 'Dr' ? opening.amount : -opening.amount));
  }

  const capLeft = new Map<string, number>();
  const result: OpenAdvance[] = [];
  for (const advance of openAdvancesFromKeys(priorKeys)) {
    const party = normalizeAccountName(advance.party);
    const capKey = `${party}|${advance.side}`;
    if (!capLeft.has(capKey)) {
      const net = netByParty.get(party) ?? 0;
      capLeft.set(capKey, advance.side === 'payable' ? Math.max(net, 0) : Math.max(-net, 0));
    }
    const open = Math.min(advance.open, capLeft.get(capKey) ?? 0);
    if (open < 0.5) continue;
    capLeft.set(capKey, (capLeft.get(capKey) ?? 0) - open);
    result.push({ ...advance, open: Math.round(open * 100) / 100 });
  }
  return result;
}

// Names the open advances on the batch's bills and invoices, oldest advance
// and earliest document first: a purchase adjusts the supplier's advance, a
// sale the customer's. A document that already names an advance or a bill it
// settles is left as the model wrote it, and a document with no number of
// its own is never touched (there is nothing to write after the advance).
export function adjustOpenAdvances(generated: GeneratedExercise, advances: OpenAdvance[]): GeneratedExercise {
  if (advances.length === 0) return generated;
  const remaining = advances.map((advance) => ({ ...advance }));
  const entries = generated.answer_key.entries;
  const replacements = new Map<number, { from: string; to: string }>();

  const sequences = [...new Set(entries.map((entry) => entry.sequence))].sort((a, b) => a - b);
  for (const sequence of sequences) {
    const legs = entries.filter((entry) => entry.sequence === sequence);
    const type = legs[0].voucher_type.trim().toLowerCase();
    const side = type === 'sales' ? 'receivable' : type === 'purchase' ? 'payable' : null;
    if (!side) continue;
    const party = partyLegOf(legs, legs[0].voucher_type);
    const reference = legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
    if (!party || !reference || documentNumberOf(reference) === null) continue;
    if (parseBillReferences(reference).some((parsed) => parsed.kind === 'advance' || parsed.kind === 'against')) continue;

    const partyName = normalizeAccountName(party.correct_account);
    let left = legs
      .filter((leg) => leg.correct_account === party.correct_account)
      .reduce((sum, leg) => sum + leg.amount, 0);
    const named: string[] = [];
    for (const advance of remaining) {
      if (left <= 0.005) break;
      if (advance.side !== side || advance.open < 0.5 || normalizeAccountName(advance.party) !== partyName) continue;
      const applied = Math.min(advance.open, left);
      advance.open -= applied;
      left -= applied;
      named.push(`${advance.ref} (Advance)`);
    }
    if (named.length > 0) replacements.set(sequence, { from: reference, to: `${named.join(', ')}, ${reference}` });
  }

  if (replacements.size === 0) return generated;
  return {
    ...generated,
    answer_key: {
      ...generated.answer_key,
      entries: entries.map((entry) => {
        const replacement = replacements.get(entry.sequence);
        return replacement && entry.bill_reference === replacement.from
          ? { ...entry, bill_reference: replacement.to }
          : entry;
      }),
    },
  };
}

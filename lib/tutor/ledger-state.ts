import { isBankLedger, partyLegOf, type OpenBill, type OpeningBalance } from '@/lib/db/queries/company';
import type { AnswerKey, AnswerKeyEntry } from '@/lib/schemas/exercise';
import { canonicalRef, normalizeBillReference, parseBillReferences } from './bill-reference';

// The company's books as one state (2026-09-22, rebuild Stage 1). Every
// consumer that needs "where the books stand" — the batch builder, the
// invariant check before a key is persisted, the correction scripts — reads
// it from here, and every voucher goes through the same applyVoucher, so
// replaying stored keys and building a new batch cannot drift apart.
//
// The bill-by-bill rules are those of company.ts's openBillsFromKeys
// (2026-09-03 to 2026-09-21), carried over unchanged so the first prefix-
// parity test over the interns' stored keys is exact; the difference is
// that advances are typed open items, not a side map, and that the state is
// incremental: a batch's own vouchers can be applied one by one and the open
// items read between them.

export type OpenItemKind = 'bill' | 'advance';
export type OpenItem = {
  party: string;
  ref: string;
  // canonicalRef(ref), the identity two references are compared by.
  key: string;
  kind: OpenItemKind;
  side: OpenBill['side'];
  open: number;
};

// A settlement uses the party's opening-balance bill of the pack when it
// names a reference no key raised (the pack's March bills, "MS-M1").
type OpeningRemaining = Map<string, number>;

export type LedgerState = {
  // Ledger -> signed balance, Dr positive, EVERY ledger including GST/TDS.
  balances: Map<string, number>;
  bills: Map<string, OpenBill>;
  advanceCredits: Map<string, number>;
  advanceInfo: Map<string, { party: string; ref: string; side: OpenBill['side'] }>;
  // Party credits with no bill of their own, applied oldest-first at read.
  credits: Map<string, number>;
  openingRemaining: OpeningRemaining;
  openingsSeeded: boolean;
  ledgerNames: Set<string>;
  // Bill id -> taxable value / party total when the bill was raised, so a
  // receipt net of TDS can put the deduction on the taxable value of what
  // it settles (Stage 6). Bills the keys never raised have no ratio.
  billTaxableRatio: Map<string, number>;
  // Sales invoices raised on a service income ledger: the only bills a
  // customer can lawfully pay net of TDS under 194J/194C.
  serviceBills: Set<string>;
};

const CASH_LEDGER = /^cash\b|cash-in-hand/i;
const NON_PARTY_ACCOUNT_PATTERN = /^(sales|purchases?|cash|sales returns?|purchase returns?)$|\bbank\b|hdfc|gst|tds/i;
const TAX_LEDGER_PATTERN = /gst|tds/i;
// Same carve-out as company.ts, so the two replays stay in step.
const TAX_WORDED_EXPENSE = /late fee|interest|penalt/i;

export function emptyLedgerState(): LedgerState {
  return {
    balances: new Map(),
    bills: new Map(),
    advanceCredits: new Map(),
    advanceInfo: new Map(),
    credits: new Map(),
    openingRemaining: new Map(),
    openingsSeeded: false,
    ledgerNames: new Set(),
    billTaxableRatio: new Map(),
    serviceBills: new Set(),
  };
}

// A deep copy, so a builder can apply a batch's own vouchers and read the
// open items between them without touching the replayed books.
export function cloneLedgerState(state: LedgerState): LedgerState {
  return {
    balances: new Map(state.balances),
    bills: new Map([...state.bills].map(([id, bill]) => [id, { ...bill }])),
    advanceCredits: new Map(state.advanceCredits),
    advanceInfo: new Map([...state.advanceInfo].map(([id, info]) => [id, { ...info }])),
    credits: new Map(state.credits),
    openingRemaining: new Map(state.openingRemaining),
    openingsSeeded: state.openingsSeeded,
    ledgerNames: new Set(state.ledgerNames),
    billTaxableRatio: new Map(state.billTaxableRatio),
    serviceBills: new Set(state.serviceBills),
  };
}

const SERVICE_INCOME_LEDGER = /service|consultanc|professional/i;

export function isServiceBill(state: LedgerState, party: string, ref: string): boolean {
  return state.serviceBills.has(billId(party, ref));
}

// Taxable value per rupee of a bill's total as raised, or null when the
// keys never raised it (an opening-balance bill).
export function billTaxableRatioOf(state: LedgerState, party: string, ref: string): number | null {
  return state.billTaxableRatio.get(billId(party, ref)) ?? null;
}

export function referenceKey(ref: string): string {
  return canonicalRef(ref) ?? normalizeBillReference(ref);
}

function billId(party: string, ref: string): string {
  return `${party}|${referenceKey(ref)}`;
}

function addBalance(state: LedgerState, account: string, drCr: 'Dr' | 'Cr', amount: number): void {
  if (!account) return;
  state.ledgerNames.add(account);
  state.balances.set(account, (state.balances.get(account) ?? 0) + (drCr === 'Dr' ? amount : -amount));
}

// A key's opening_balances are the company's CUMULATIVE position at the
// start of that batch (the pack's authored openings, the stamped
// carry-forward on every generated batch), so they reset the running
// balances before the batch's entries apply (netAnswerKeys, 2026-09-02).
// The first openings seen also seed the pack's opening-balance bills.
export function applyOpenings(state: LedgerState, openings: readonly OpeningBalance[]): void {
  if (openings.length === 0) return;
  state.balances = new Map();
  for (const opening of openings) addBalance(state, opening.account, opening.dr_cr, opening.amount);
  if (!state.openingsSeeded) {
    state.openingsSeeded = true;
    for (const opening of openings) {
      if (NON_PARTY_ACCOUNT_PATTERN.test(opening.account)) continue;
      state.openingRemaining.set(opening.account, opening.amount);
    }
  }
}

// One voucher: its legs, grouped by sequence by the caller.
export function applyVoucher(state: LedgerState, legs: readonly AnswerKeyEntry[]): void {
  for (const leg of legs) addBalance(state, leg.correct_account, leg.dr_cr, leg.amount);
  if (legs.length === 0) return;

  const party = partyLegOf([...legs], legs[0]?.voucher_type);
  const reference = legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
  if (!party || !reference) return;
  const type = legs[0].voucher_type;
  const raises = /^(sales|purchase)$/i.test(type);
  const settles = /^(receipt|payment|credit note|debit note)$/i.test(type);
  const journal = /^journal$/i.test(type);
  if (!raises && !settles && !journal) return;

  const side: OpenBill['side'] = /^(sales|receipt|credit note)$/i.test(type) ? 'receivable' : 'payable';
  const partyAmount = legs.filter((leg) => leg.correct_account === party.correct_account).reduce((sum, leg) => sum + leg.amount, 0);
  const parsedRefs = parseBillReferences(reference);
  const refs = parsedRefs.map((parsed) => parsed.ref);
  const { bills, advanceCredits } = state;

  if (journal) {
    // A journal allocated against an open bill moves it: the advance-GST
    // reversal of rulebook 9B credits the customer against the invoice, a
    // bad-debt write-off credits it in full. Several bills are cleared in
    // order, the last taking what is left. A journal has no party side, so
    // the party is the leg that owns the named bills. A reference that says
    // "New Ref" raises the bill on a party the books already know (a
    // carried rectification reopening a settled bill, 2026-09-22): its
    // side follows the leg, a debit being receivable.
    const knownParties = new Set([...bills.values()].map((bill) => bill.party));
    const owner =
      legs.find((leg) => parsedRefs.some((parsed) => bills.has(billId(leg.correct_account, parsed.ref)))) ??
      (parsedRefs.some((parsed) => parsed.newRef) ? legs.find((leg) => knownParties.has(leg.correct_account)) : undefined);
    if (!owner) return;
    const named = parsedRefs
      .map((parsed) => {
        const id = billId(owner.correct_account, parsed.ref);
        const existing = bills.get(id);
        if (existing || !parsed.newRef) return existing;
        const raised: OpenBill = { party: owner.correct_account, ref: parsed.ref, open: 0, side: owner.dr_cr === 'Dr' ? 'receivable' : 'payable' };
        bills.set(id, raised);
        return raised;
      })
      .filter((bill): bill is OpenBill => bill !== undefined);
    let left = legs.filter((leg) => leg.correct_account === owner.correct_account).reduce((sum, leg) => sum + leg.amount, 0);
    named.forEach((bill, index) => {
      const reducesBill = bill.side === 'receivable' ? owner.dr_cr === 'Cr' : owner.dr_cr === 'Dr';
      const applied = !reducesBill || index === named.length - 1 ? left : Math.min(left, Math.max(bill.open, 0));
      bill.open += reducesBill ? -applied : applied;
      left -= applied;
    });
    return;
  }

  if (raises) {
    // Only the document's own number is a bill. The advance it adjusts
    // ("ADV-C01 (Advance), INV-3001") was recorded as that reference's
    // credit when the advance moved, and is consumed by this document.
    const ownRefs = parsedRefs.filter((parsed) => parsed.kind === 'bill').map((parsed) => parsed.ref);
    const raisedRefs = ownRefs.length > 0 ? ownRefs : refs;
    const raisedBills: OpenBill[] = [];
    // The taxable value: the base-side legs that are neither the party nor
    // a tax ledger (Sales on a sale, the expense or Purchases on a bill).
    const baseLegs = legs.filter((leg) => leg.correct_account !== party.correct_account && leg.dr_cr !== party.dr_cr && !TAX_LEDGER_PATTERN.test(leg.correct_account));
    const taxable = baseLegs.reduce((sum, leg) => sum + leg.amount, 0);
    // The document's gross total: the party leg plus anything else on its
    // side (TDS withheld on a purchase), so the ratio is taxable / invoice.
    const gross = legs.filter((leg) => leg.dr_cr === party.dr_cr).reduce((sum, leg) => sum + leg.amount, 0);
    const service = /^sales$/i.test(type) && baseLegs.some((leg) => SERVICE_INCOME_LEDGER.test(leg.correct_account));
    for (const ref of raisedRefs) {
      const id = billId(party.correct_account, ref);
      const current = bills.get(id) ?? { party: party.correct_account, ref, open: 0, side };
      current.open += partyAmount / raisedRefs.length;
      bills.set(id, current);
      raisedBills.push(current);
      if (gross > 0 && taxable > 0) state.billTaxableRatio.set(id, Math.min(1, taxable / gross));
      if (service) state.serviceBills.add(id);
    }
    if (ownRefs.length > 0) {
      for (const parsed of parsedRefs) {
        if (parsed.kind === 'bill') continue;
        const id = billId(party.correct_account, parsed.ref);
        if (!advanceCredits.has(id)) continue;
        let credit = advanceCredits.get(id) ?? 0;
        for (const bill of raisedBills) {
          if (credit <= 0.005) break;
          const applied = Math.min(credit, Math.max(bill.open, 0));
          bill.open -= applied;
          credit -= applied;
        }
        advanceCredits.set(id, credit);
      }
    }
    return;
  }

  // A settlement naming several bills clears them IN ORDER; the last named
  // takes the remainder. A ref nobody raised: an advance is kept against its
  // own reference until the document that adjusts it arrives; anything else
  // goes to the party's opening-balance bill first, then becomes a credit.
  let remaining = partyAmount;
  refs.forEach((ref, index) => {
    const id = billId(party.correct_account, ref);
    const bill = bills.get(id);
    if (!bill) {
      if (index === refs.length - 1) {
        if (parsedRefs[index]?.kind === 'advance') {
          advanceCredits.set(id, (advanceCredits.get(id) ?? 0) + remaining);
          state.advanceInfo.set(id, { party: party.correct_account, ref, side });
          remaining = 0;
          return;
        }
        const openingLeft = state.openingRemaining.get(party.correct_account) ?? 0;
        if (openingLeft > 0.5) {
          const applied = Math.min(remaining, openingLeft);
          state.openingRemaining.set(party.correct_account, openingLeft - applied);
          remaining -= applied;
        }
        if (remaining > 0.005) {
          state.credits.set(party.correct_account, (state.credits.get(party.correct_account) ?? 0) + remaining);
        }
        remaining = 0;
      }
      return;
    }
    const applied = index === refs.length - 1 ? remaining : Math.min(remaining, Math.max(bill.open, 0));
    bill.open -= applied;
    remaining -= applied;
  });
}

export function groupBySequence(entries: readonly AnswerKeyEntry[]): Map<number, AnswerKeyEntry[]> {
  const bySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }
  return bySequence;
}

export function applyKey(state: LedgerState, key: AnswerKey): void {
  applyOpenings(state, key.opening_balances ?? []);
  for (const legs of groupBySequence(key.entries ?? []).values()) applyVoucher(state, legs);
}

export function replayKeys(keys: readonly AnswerKey[]): LedgerState {
  const state = emptyLedgerState();
  for (const key of keys) applyKey(state, key);
  return state;
}

// The open items as a settlement would see them now: leftover advances
// become party credits and every credit is applied to the party's open
// bills oldest first, on a copy, so reading never changes the state.
export function openItemsOf(state: LedgerState): OpenItem[] {
  const bills = new Map<string, OpenBill>();
  for (const [id, bill] of state.bills) bills.set(id, { ...bill });
  const credits = new Map(state.credits);
  const items: OpenItem[] = [];

  for (const [id, credit] of state.advanceCredits) {
    if (credit <= 0.005) continue;
    const info = state.advanceInfo.get(id);
    if (info && credit >= 0.5) {
      items.push({ party: info.party, ref: info.ref, key: referenceKey(info.ref), kind: 'advance', side: info.side, open: Math.round(credit * 100) / 100 });
    }
    const party = id.slice(0, id.lastIndexOf('|'));
    credits.set(party, (credits.get(party) ?? 0) + credit);
  }
  for (const [party, credit] of credits) {
    let left = credit;
    for (const bill of bills.values()) {
      if (left <= 0.005) break;
      if (bill.party !== party || bill.open < 0.5) continue;
      const applied = Math.min(left, bill.open);
      bill.open -= applied;
      left -= applied;
    }
  }
  const openBills = [...bills.values()]
    .filter((bill) => bill.open >= 0.5)
    .map((bill): OpenItem => ({ party: bill.party, ref: bill.ref, key: referenceKey(bill.ref), kind: 'bill', side: bill.side, open: Math.round(bill.open * 100) / 100 }));
  return [...openBills, ...items];
}

export function openBillsOf(state: LedgerState): OpenBill[] {
  return openItemsOf(state)
    .filter((item) => item.kind === 'bill')
    .map(({ party, ref, open, side }) => ({ party, ref, open, side }));
}

export function openAdvancesOf(state: LedgerState): OpenItem[] {
  return openItemsOf(state).filter((item) => item.kind === 'advance');
}

export function cashPositionOf(state: LedgerState): { cash: number; bank: number } {
  const position = { cash: 0, bank: 0 };
  for (const [account, signed] of state.balances) {
    if (CASH_LEDGER.test(account)) position.cash += signed;
    else if (isBankLedger(account)) position.bank += signed;
  }
  return position;
}

// The position shaped as the next batch's opening balances. Tax ledgers
// are left out by default, as openingBalancesFromNet does today; the
// rebuilt path carries them (Stage 1b).
export function openingBalancesOf(state: LedgerState, options: { includeTaxLedgers?: boolean } = {}): OpeningBalance[] {
  return [...state.balances.entries()]
    .filter(([account, signed]) => (options.includeTaxLedgers || !TAX_LEDGER_PATTERN.test(account) || TAX_WORDED_EXPENSE.test(account)) && Math.abs(signed) >= 0.005)
    .map(([account, signed]) => ({ account, dr_cr: signed > 0 ? ('Dr' as const) : ('Cr' as const), amount: Math.abs(signed) }));
}

import type { Settlement } from '@/lib/schemas/batch-plan';
import { referenceKey, type OpenItem } from '@/lib/tutor/ledger-state';
import type { Allocation } from '@/lib/tutor/bill-reference';

// Settlements resolved against the open items of the books (2026-09-22,
// rebuild Stage 3). A bill the books do not hold is a plan violation, never
// a built leg: the five audited "settled a nonexistent bill" keys cannot
// happen here.

const round2 = (value: number): number => Math.round(value * 100) / 100;

export type ResolvedSettlement =
  | { ok: true; allocations: Allocation[]; amount: number; kind: 'bills' | 'advance' | 'on_account' }
  | { ok: false; violation: string };

function describeOpen(items: OpenItem[]): string {
  return items.length === 0 ? 'no open bills' : items.map((item) => `${item.ref} (Rs ${Math.round(item.open).toLocaleString('en-IN')})`).join(', ');
}

export function resolveSettlement(params: {
  settlement: Settlement;
  party: string;
  side: OpenItem['side'];
  openItems: readonly OpenItem[];
  // Mints the next advance reference for this side.
  nextAdvanceRef: () => string;
}): ResolvedSettlement {
  const { settlement, party, side } = params;
  const partyBills = params.openItems.filter((item) => item.party === party && item.side === side && item.kind === 'bill');
  switch (settlement.mode) {
    case 'full': {
      const allocations: Allocation[] = [];
      const seen = new Set<string>();
      for (const named of settlement.bills) {
        const key = referenceKey(named);
        if (seen.has(key)) return { ok: false, violation: `${party}: bill ${named} named twice in one settlement` };
        seen.add(key);
        const bill = partyBills.find((item) => item.key === key);
        if (!bill) return { ok: false, violation: `${party}: no open bill ${named} to settle; open: ${describeOpen(partyBills)}` };
        allocations.push({ ref: bill.ref, kind: 'against', amount: round2(bill.open) });
      }
      return { ok: true, allocations, amount: round2(allocations.reduce((sum, allocation) => sum + allocation.amount, 0)), kind: 'bills' };
    }
    case 'part': {
      const bill = partyBills.find((item) => item.key === referenceKey(settlement.bill));
      if (!bill) return { ok: false, violation: `${party}: no open bill ${settlement.bill} to part-pay; open: ${describeOpen(partyBills)}` };
      if (settlement.amount >= bill.open - 0.005) {
        return { ok: false, violation: `${party}: a part payment of ${settlement.bill} must be below its balance of Rs ${Math.round(bill.open).toLocaleString('en-IN')} (use mode "full" to clear it)` };
      }
      return { ok: true, allocations: [{ ref: bill.ref, kind: 'against', amount: round2(settlement.amount), partPayment: true }], amount: round2(settlement.amount), kind: 'bills' };
    }
    case 'advance': {
      const ref = params.nextAdvanceRef();
      return { ok: true, allocations: [{ ref, kind: 'advance', amount: round2(settlement.amount) }], amount: round2(settlement.amount), kind: 'advance' };
    }
    case 'on_account':
      return { ok: true, allocations: [{ ref: 'On Account', kind: 'on_account', amount: round2(settlement.amount) }], amount: round2(settlement.amount), kind: 'on_account' };
    default: {
      const never: never = settlement;
      throw new Error(`Unknown settlement ${JSON.stringify(never)}`);
    }
  }
}

// The open advance a sale or purchase adjusts, by reference, on the party's
// side. Null when the books hold no such advance.
export function findOpenAdvance(params: { ref: string; party: string; side: OpenItem['side']; openItems: readonly OpenItem[] }): OpenItem | null {
  const key = referenceKey(params.ref);
  return params.openItems.find((item) => item.kind === 'advance' && item.party === params.party && item.side === params.side && item.key === key) ?? null;
}

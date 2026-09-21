import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerKey } from '@/lib/schemas/exercise';
import {
  documentNumberOf,
  normalizeBillReference,
  parseBillReferences,
  splitBillReferences,
  type BillReferenceKind,
  type ParsedBillReference,
} from '@/lib/tutor/bill-reference';

// Cash and bank ledger recognition. The company's Cash-in-Hand ledger is
// plainly "Cash"; its bank ledger carries the bank's name ("HDFC Bank —
// 1234"). Group rows ("Cash-in-Hand", "Bank Accounts") never appear in an
// answer key, only ledgers do.
const CASH_ACCOUNT_PATTERN = /^cash\b|cash-in-hand/i;
const BANK_ACCOUNT_PATTERN = /\bbank\b|hdfc/i;
// "Bank Charges", "Bank Interest", "Bank Commission" are expense/income
// ledgers, not the bank. Counting them as bank inflated the stated opening
// by the charges balance (1,070.34): Yeshas's Level 2 prompt/prose said
// 8,67,186 for a real 8,66,116, Praveen's Level 4 8,09,246 for 8,08,176
// (2026-09-03). The answer keys were never affected — only the position
// fed to the generator and printed for the learner.
const NON_BANK_LEDGER_PATTERN = /charge|commission|interest|fee|penalt/i;

export function isBankLedger(account: string): boolean {
  return BANK_ACCOUNT_PATTERN.test(account) && !NON_BANK_LEDGER_PATTERN.test(account);
}

export type CompanyCashPosition = { cash: number; bank: number };

// The company's expected Cash and Bank balances after everything the learner
// has been asked to post so far, computed by netting the ANSWER KEYS (the
// correct position), not the learner's own possibly-miskeyed exports — an
// exercise has to be solvable by someone who posted correctly.
//
// Added 2026-09-02 after a live report: a generated batch opened with
// "deposit cash into HDFC Bank" for ₹45,000 when the learner's correct cash
// on hand was ₹19,900, because batch generation had no visibility into
// balances at all (company_transaction_log stores voucher types and ledger
// names, never amounts). Netted over her real data this returns 19,900,
// and her delivered batch drives it to -20,100 — the impossibility she
// spotted.
// Netting rule for the company's position across its answer keys. A key's
// opening_balances are the company's CUMULATIVE position at the start of
// that batch: the pack's openings on the diagnostic, the stamped
// carry-forward on every generated batch. They therefore RESET the running
// position before that batch's entries are applied. Adding them on top of
// the earlier keys counted April twice — live 2026-09-02: both Level 3 keys
// opened with HDFC at 18.2L instead of 9.5L and Praveen's till at -35,200
// instead of -55,100, which he spotted against his own Tally (his books were
// right; the key was wrong). Keys without openings (older batches) simply
// add their movements on top.
export function netAnswerKeys(keys: AnswerKey[]): Map<string, number> {
  let net = new Map<string, number>();
  const apply = (account: string, drCr: 'Dr' | 'Cr', amount: number) => {
    if (!account) {
      return;
    }
    net.set(account, (net.get(account) ?? 0) + (drCr === 'Dr' ? amount : -amount));
  };
  for (const key of keys) {
    if (key.opening_balances && key.opening_balances.length > 0) {
      net = new Map<string, number>();
      for (const opening of key.opening_balances) {
        apply(opening.account, opening.dr_cr, opening.amount);
      }
    }
    for (const entry of key.entries ?? []) {
      apply(entry.correct_account, entry.dr_cr, entry.amount);
    }
  }
  return net;
}

export function cashPositionFromNet(net: Map<string, number>): CompanyCashPosition {
  const position: CompanyCashPosition = { cash: 0, bank: 0 };
  for (const [account, signed] of net) {
    if (CASH_ACCOUNT_PATTERN.test(account)) {
      position.cash += signed;
    } else if (isBankLedger(account)) {
      position.bank += signed;
    }
  }
  return position;
}

export async function loadAnswerKeys(supabase: SupabaseClient, learnerId: string): Promise<AnswerKey[]> {
  const { data, error } = await supabase
    .from('exercises')
    .select('answer_key')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return (data ?? [])
    .map((row) => (row as { answer_key: AnswerKey | null }).answer_key)
    .filter((key): key is AnswerKey => key !== null);
}

export async function getExpectedCashPosition(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<CompanyCashPosition> {
  return cashPositionFromNet(netAnswerKeys(await loadAnswerKeys(supabase, learnerId)));
}


// GST/TDS ledgers are excluded from the carried-forward opening position:
// the answer-key model holds GST and TDS as voucher-level METADATA
// (gst_head/tds_section), not as ledger legs, so their balances cannot be
// derived from the keys — which is exactly why checkTrialBalanceTieOut
// already exempts them from comparison.
const TAX_LEDGER_PATTERN = /gst|tds/i;
// A GST- or TDS-worded EXPENSE ("GST Late Fee and Interest") carries forward
// like any other ledger (account-names.ts isTaxLedgerName has the same rule).
const TAX_WORDED_EXPENSE = /late fee|interest|penalt/i;

export type OpeningBalance = { account: string; dr_cr: 'Dr' | 'Cr'; amount: number };

// The company's closing position across EVERY exercise so far, shaped as the
// opening balances of the next one. The learner works one continuous set of
// books — April's closing balances are May's opening balances — so a batch's
// expected closing has to be (carried-forward position + this batch's
// movements). Without this an adaptive batch's answer key described only its
// own movements while the learner's real Tally export is cumulative, so
// checkTrialBalanceTieOut failed even a flawless submission and capped every
// adaptive result at 'partial' (proved 2026-09-02: a 100%-correct May
// submission scored 100% with tb_tie_out false).
export function openingBalancesFromNet(net: Map<string, number>): OpeningBalance[] {
  return [...net.entries()]
    .filter(([account, signed]) => (!TAX_LEDGER_PATTERN.test(account) || TAX_WORDED_EXPENSE.test(account)) && Math.abs(signed) >= 0.005)
    .map(([account, signed]) => ({
      account,
      dr_cr: signed > 0 ? ('Dr' as const) : ('Cr' as const),
      amount: Math.abs(signed),
    }));
}

export async function getExpectedOpeningBalances(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<OpeningBalance[]> {
  return openingBalancesFromNet(netAnswerKeys(await loadAnswerKeys(supabase, learnerId)));
}

// Bill-by-bill state derived from the answer keys: every invoice/purchase
// bill a party leg carries a reference for, less the receipts/payments
// (and credit/debit notes) settled against it. Generated batches that say
// "against Bill X" / "full settlement of X" must point at one of these —
// the model invented DT-2216 (42,500) for Praveen's Level 4 when Deccan
// Traders' real open bill was DT/334 (69,620), and BR/S/098 / CS/612 for
// Yeshas's Level 2 with no such bills at all (2026-09-03). A learner
// posting bill-by-bill in Tally cannot allocate against a bill that does
// not exist, so the reference has to be real.
export type OpenBill = { party: string; ref: string; open: number; side: 'receivable' | 'payable' };

const NON_PARTY_ACCOUNT_PATTERN = /^(sales|purchases?|cash|sales returns?|purchase returns?)$|\bbank\b|hdfc|gst|tds/i;

// What a reference on a voucher IS (2026-09-15): the parser and the
// normalizers live in lib/tutor/bill-reference.ts since the Stage 0
// refactor (2026-09-22) and are re-exported here for their existing callers.
export {
  documentNumberOf,
  normalizeBillReference,
  parseBillReferences,
  splitBillReferences,
  type BillReferenceKind,
  type ParsedBillReference,
};

// The party on a voucher sits on a known side: the customer is DEBITED on a
// sale / credited on a receipt or credit note; the supplier is CREDITED on a
// purchase / debited on a payment or debit note. Picking "the first
// non-tax, non-bank leg" instead took the expense/asset leg of an April
// purchase ("Dr Office Equipment … Cr Deccan Traders", ref DT-115) as the
// party, so the open-bills list told the model "Office Equipment: DT-115
// outstanding" while Deccan Traders' settlement of DT-115 netted against
// nothing — and Praveen's Level 5 was generated around three bills that
// were paid in April (2026-09-03). Side first, name pattern second.
const PARTY_SIDE_BY_VOUCHER_TYPE: Record<string, 'Dr' | 'Cr'> = {
  sales: 'Dr',
  'credit note': 'Cr',
  receipt: 'Cr',
  purchase: 'Cr',
  'debit note': 'Dr',
  payment: 'Dr',
};

export function partyLegOf<T extends { correct_account: string; dr_cr?: 'Dr' | 'Cr' }>(
  legs: T[],
  voucherType?: string,
): T | undefined {
  const side = voucherType ? PARTY_SIDE_BY_VOUCHER_TYPE[voucherType.trim().toLowerCase()] : undefined;
  const candidates = side ? legs.filter((leg) => leg.dr_cr === side) : legs;
  return candidates.find((leg) => !NON_PARTY_ACCOUNT_PATTERN.test(leg.correct_account));
}

export function openBillsFromKeys(keys: AnswerKey[]): OpenBill[] {
  return replayBillsAndAdvances(keys).bills;
}

// An advance paid or received that no invoice or bill has adjusted yet
// (2026-09-21). Praveen's April pack paid Bharat Machinery Rs 50,000 as
// ADV-02; his June batch raised Bharat's bill BM/2025-06 without naming the
// advance, so the key marked his correct adjustment wrong. Generation reads
// these to name the advance on the next bill of the same party
// (lib/tutor/advance-adjustment.ts).
export type OpenAdvance = { party: string; ref: string; open: number; side: OpenBill['side'] };

export function openAdvancesFromKeys(keys: AnswerKey[]): OpenAdvance[] {
  return replayBillsAndAdvances(keys).advances;
}

function replayBillsAndAdvances(keys: AnswerKey[]): { bills: OpenBill[]; advances: OpenAdvance[] } {
  const bills = new Map<string, OpenBill>();
  // Per-party credits with no bill of their own — a debit note raised as a
  // New Ref, an advance receipt — are applied to that party's open bills
  // oldest-first at the end, so a party's listed balances add up to the
  // ledger balance the learner actually sees.
  const credits = new Map<string, number>();
  // Advances by party and reference, consumed by the invoice or bill that
  // names them (2026-09-15).
  const advanceCredits = new Map<string, number>();
  const advanceInfo = new Map<string, Omit<OpenAdvance, 'open'>>();
  const billId =(party: string, ref: string) => `${party}|${normalizeBillReference(ref)}`;
  // The pack's opening balances are bills too — "Mumbai Suppliers Cr
  // 1,20,000" is the March bill the April payment "against MS-M1" settles.
  // Kept aside (not listed as open bills, since an asset opening like Office
  // Equipment is not a bill) and consumed only when a settlement names a ref
  // the keys never raised. Read once, from the first key that carries
  // openings (the diagnostic); generated keys' openings are cumulative.
  const openingRemaining = new Map<string, number>();
  let openingsSeeded = false;

  for (const key of keys) {
    if (!openingsSeeded && (key.opening_balances ?? []).length > 0) {
      openingsSeeded = true;
      for (const opening of key.opening_balances ?? []) {
        if (NON_PARTY_ACCOUNT_PATTERN.test(opening.account)) continue;
        openingRemaining.set(opening.account, opening.amount);
      }
    }
    const bySequence = new Map<number, AnswerKey['entries']>();
    for (const entry of key.entries ?? []) {
      const legs = bySequence.get(entry.sequence) ?? [];
      legs.push(entry);
      bySequence.set(entry.sequence, legs);
    }
    for (const legs of bySequence.values()) {
      const party = partyLegOf(legs, legs[0]?.voucher_type);
      // The reference may sit on any leg (often only the party leg).
      const reference = legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
      if (!party || !reference) {
        continue;
      }
      const type = legs[0].voucher_type;
      const raises = /^(sales|purchase)$/i.test(type);
      const settles = /^(receipt|payment|credit note|debit note)$/i.test(type);
      const journal = /^journal$/i.test(type);
      if (!raises && !settles && !journal) {
        continue;
      }
      const side: OpenBill['side'] = /^(sales|receipt|credit note)$/i.test(type) ? 'receivable' : 'payable';
      const partyAmount = legs
        .filter((leg) => leg.correct_account === party.correct_account)
        .reduce((sum, leg) => sum + leg.amount, 0);
      const parsedRefs = parseBillReferences(reference);
      const refs = parsedRefs.map((parsed) => parsed.ref);

      if (journal) {
        // A journal allocated against an open bill moves it: the advance-GST
        // reversal of rulebook 9B credits the customer against the invoice,
        // a bad-debt write-off credits it in full.
        // Several bills are cleared in order, the last taking what is left.
        // A journal has no party side, so the party is the leg that owns the
        // named bills ("Dr Bad Debts Written Off / Cr Delhi Bazaar": Delhi
        // Bazaar), not the first non-tax leg.
        const owner = legs.find((leg) => parsedRefs.some((parsed) => bills.has(billId(leg.correct_account, parsed.ref))));
        if (!owner) {
          continue;
        }
        const named = parsedRefs
          .map((parsed) => bills.get(billId(owner.correct_account, parsed.ref)))
          .filter((bill): bill is OpenBill => bill !== undefined);
        let left = legs
          .filter((leg) => leg.correct_account === owner.correct_account)
          .reduce((sum, leg) => sum + leg.amount, 0);
        named.forEach((bill, index) => {
          const reducesBill = bill.side === 'receivable' ? owner.dr_cr === 'Cr' : owner.dr_cr === 'Dr';
          const applied = !reducesBill || index === named.length - 1 ? left : Math.min(left, Math.max(bill.open, 0));
          bill.open += reducesBill ? -applied : applied;
          left -= applied;
        });
        continue;
      }

      if (raises) {
        // Only the document's own number is a bill. The advance it adjusts
        // ("ADV-C01 (Advance), INV-3001") was recorded as that reference's
        // credit when the advance moved, and is consumed by this document
        // here, not by the party's oldest bill.
        const ownRefs = parsedRefs.filter((parsed) => parsed.kind === 'bill').map((parsed) => parsed.ref);
        const raisedRefs = ownRefs.length > 0 ? ownRefs : refs;
        const raisedBills: OpenBill[] = [];
        for (const ref of raisedRefs) {
          const id = billId(party.correct_account, ref);
          const current = bills.get(id) ?? { party: party.correct_account, ref, open: 0, side };
          current.open += partyAmount / raisedRefs.length;
          bills.set(id, current);
          raisedBills.push(current);
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
        continue;
      }

      // A settlement naming several bills clears them IN ORDER — "MS-B1,
      // MS-B2, MS-B3 (part)" pays B1 and B2 in full and the remainder off
      // B3. Splitting evenly left MS-B1 "open" with 1,45,000 when it was
      // fully paid in April (Praveen's Level 5, 2026-09-03). A settlement
      // naming a ref nobody raised (a New Ref debit note, an advance) is a
      // party credit, applied below.
      let remaining = partyAmount;
      refs.forEach((ref, index) => {
        const id = billId(party.correct_account, ref);
        const bill = bills.get(id);
        if (!bill) {
          if (index === refs.length - 1) {
            // An advance ("ADV-C01 (Advance)") is kept against its own
            // reference until the document that adjusts it arrives; one
            // never adjusted falls back to a party credit at the end.
            if (parsedRefs[index]?.kind === 'advance') {
              advanceCredits.set(id, (advanceCredits.get(id) ?? 0) + remaining);
              advanceInfo.set(id, { party: party.correct_account, ref, side });
              remaining = 0;
              return;
            }
            // A ref nobody raised in the keys: first the party's opening-
            // balance bill ("MS-M1", "INV-M-101" are the pack's March
            // bills), then whatever is left becomes a party credit.
            const openingLeft = openingRemaining.get(party.correct_account) ?? 0;
            if (openingLeft > 0.5) {
              const applied = Math.min(remaining, openingLeft);
              openingRemaining.set(party.correct_account, openingLeft - applied);
              remaining -= applied;
            }
            if (remaining > 0.005) {
              credits.set(party.correct_account, (credits.get(party.correct_account) ?? 0) + remaining);
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
  }

  const advances: OpenAdvance[] = [];
  for (const [id, credit] of advanceCredits) {
    if (credit <= 0.005) continue;
    const info = advanceInfo.get(id);
    if (info && credit >= 0.5) advances.push({ ...info, open: Math.round(credit * 100) / 100 });
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

  return {
    bills: [...bills.values()]
      // Only positive balances are open; anything at or below zero is settled.
      .filter((bill) => bill.open >= 0.5)
      .map((bill) => ({ ...bill, open: Math.round(bill.open * 100) / 100 })),
    advances,
  };
}

export async function getOpenBills(supabase: SupabaseClient, learnerId: string): Promise<OpenBill[]> {
  return openBillsFromKeys(await loadAnswerKeys(supabase, learnerId));
}

export type CompanyLedgerRegistryEntry = {
  ledger_name: string;
  ledger_type: string;
  first_used_exercise_id: string;
  created_at: string;
};

export type CompanyTransactionLogEntry = {
  id: string;
  exercise_id: string;
  voucher_summary: unknown;
  created_at: string;
};

// Every ledger/party name ever introduced into the learner's single
// persistent Tally company — read before generating a new exercise so the
// LLM can reuse an existing name or guarantee a genuinely new one, per the
// spec's confirmed persistent-company design constraint.
export async function getCompanyLedgerRegistry(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<CompanyLedgerRegistryEntry[]> {
  const { data, error } = await supabase
    .from('company_ledger_registry')
    .select('ledger_name, ledger_type, first_used_exercise_id, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

// Ignores a name that's already registered (unique on learner_id+ledger_name)
// rather than erroring — a generated exercise reusing an existing ledger name
// on purpose (realistic continuity) shouldn't fail the write.
export async function registerCompanyLedgers(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  ledgers: { ledgerName: string; ledgerType: string }[],
): Promise<void> {
  if (ledgers.length === 0) {
    return;
  }

  const { error } = await supabase
    .from('company_ledger_registry')
    .upsert(
      ledgers.map((ledger) => ({
        learner_id: learnerId,
        ledger_name: ledger.ledgerName,
        ledger_type: ledger.ledgerType,
        first_used_exercise_id: exerciseId,
      })),
      { onConflict: 'learner_id,ledger_name', ignoreDuplicates: true },
    );

  if (error) {
    throw error;
  }
}

// Most recent slice of what's been posted in the company, newest first —
// included in the next generation prompt as continuity context. Bounded so
// the prompt doesn't grow unboundedly as a learner's history lengthens.
const TRANSACTION_LOG_SLICE_SIZE = 10;

export async function getRecentCompanyTransactionLog(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<CompanyTransactionLogEntry[]> {
  const { data, error } = await supabase
    .from('company_transaction_log')
    .select('id, exercise_id, voucher_summary, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: false })
    .limit(TRANSACTION_LOG_SLICE_SIZE);

  if (error) {
    throw error;
  }

  return data ?? [];
}

// The learner's single persistent company name, read from the OLDEST log
// row — the pack assignment writes `company: pack.company_name` there
// (assign-pack-exercise.ts). The recent-slice query above returns the NEWEST
// rows, so the name silently fell out of the generation prompt once a
// learner accumulated 10+ log entries (user's 5-point batch review #5,
// 2026-09-01) — this reads it explicitly instead. Null when no pack has
// been assigned yet.
export async function getCompanyName(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('company_transaction_log')
    .select('voucher_summary')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  const summary = data?.voucher_summary;
  if (summary && typeof summary === 'object' && 'company' in summary && typeof summary.company === 'string') {
    return summary.company;
  }
  return null;
}

export async function appendCompanyTransactionLog(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
  voucherSummary: unknown,
): Promise<void> {
  const { error } = await supabase.from('company_transaction_log').insert({
    learner_id: learnerId,
    exercise_id: exerciseId,
    voucher_summary: voucherSummary,
  });

  if (error) {
    throw error;
  }
}

// Everything the batch generator knows about the learner's company, read in
// ONE place (2026-09-03). The prompt and the deterministic checks both
// consume this object, so a fact cannot be given to the model and forgotten
// by the checks (or vice versa) — every hallucination so far was a fact
// that existed in the books but was missing from, or wrong in, what the
// model was told.
// Whether a party is taxed intra-state (CGST+SGST) or inter-state (IGST),
// derived from how the keys have taxed that party so far. A party's state
// never changes, but the model gave Deccan Traders (Karnataka, CGST+SGST in
// three earlier batches) IGST as "Telangana" in Yeshas's Level 3
// (2026-09-03) — self-consistent within the batch, contradicting the books.
export type PartyTaxClass = 'intra' | 'inter';

export function partyTaxClassesFromKeys(keys: AnswerKey[]): Map<string, PartyTaxClass> {
  const classes = new Map<string, PartyTaxClass>();
  for (const key of keys) {
    const bySequence = new Map<number, AnswerKey['entries']>();
    for (const entry of key.entries ?? []) {
      const legs = bySequence.get(entry.sequence) ?? [];
      legs.push(entry);
      bySequence.set(entry.sequence, legs);
    }
    for (const legs of bySequence.values()) {
      if (!/^(sales|purchase)$/i.test(legs[0]?.voucher_type ?? '')) continue;
      const party = partyLegOf(legs, legs[0].voucher_type);
      if (!party || classes.has(party.correct_account)) continue;
      const heads = new Set(legs.map((leg) => leg.gst_head).filter((head): head is 'CGST' | 'SGST' | 'IGST' => head !== null));
      if (heads.has('IGST')) classes.set(party.correct_account, 'inter');
      else if (heads.has('CGST') || heads.has('SGST')) classes.set(party.correct_account, 'intra');
    }
  }
  return classes;
}

export type CompanyState = {
  companyName: string | null;
  ledgerRegistry: CompanyLedgerRegistryEntry[];
  recentTransactionLog: CompanyTransactionLogEntry[];
  cashPosition: CompanyCashPosition;
  openingBalances: OpeningBalance[];
  openBills: OpenBill[];
  partyTaxClasses: Map<string, PartyTaxClass>;
};

export async function getCompanyState(supabase: SupabaseClient, learnerId: string): Promise<CompanyState> {
  const [keys, ledgerRegistry, recentTransactionLog, companyName] = await Promise.all([
    loadAnswerKeys(supabase, learnerId),
    getCompanyLedgerRegistry(supabase, learnerId),
    getRecentCompanyTransactionLog(supabase, learnerId),
    getCompanyName(supabase, learnerId),
  ]);
  const net = netAnswerKeys(keys);
  return {
    companyName,
    ledgerRegistry,
    recentTransactionLog,
    cashPosition: cashPositionFromNet(net),
    openingBalances: openingBalancesFromNet(net),
    openBills: openBillsFromKeys(keys),
    partyTaxClasses: partyTaxClassesFromKeys(keys),
  };
}

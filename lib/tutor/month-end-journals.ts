import type { AnswerKey, AnswerKeyEntry, ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { educationalDaysFor } from '@/lib/tutor/educational-dates';

// Month-end GST journals with figures taken from the ledger (2026-09-10
// meeting: "GST set-off figures were invented, not taken from the books";
// "GST payment to government: never"). The model writes the month's story;
// this module appends the set-off journal and the payment to the
// government with amounts computed from every answer key so far, the same
// derivation the year-end true-up used, so a learner whose books equal the
// platform's finds exactly these figures in their own GST ledgers.
//
// Rulebook Section 13: input credit is utilised at month-end via journal in
// the statutory order, IGST first, then CGST/SGST; 9B JV 2: the balance
// payable is paid from the bank. Ledger names are the platform's
// ("Output CGST", "Input IGST", "GST Payable"); the scorer matches GST
// ledgers by head, so "Input CGST c/f" or "Output CGST 9%" score the same.
//
// 2026-09-17 audit:
// - Reverse-charge tax ("Output CGST RCM") is never set off against input
//   credit: s. 49(4) CGST Act allows the credit ledger only for output tax,
//   and s. 2(82) excludes reverse-charge tax from output tax. It is moved to
//   the payable in full and paid in cash. The matching "Input CGST RCM"
//   credit becomes usable only once that tax has been paid, which is at
//   the NEXT month's payment, so it is utilised from the next set-off on.
// - The utilisation minimises the cash payable within Rule 88A CGST Rules
//   and Circular 98/17/2019-GST: IGST credit first against IGST, the rest
//   against CGST and SGST in whatever split leaves the least to pay; CGST
//   credit against CGST then IGST, SGST credit against SGST then IGST, and
//   CGST credit never against SGST (s. 49(5)). The greedy order it replaces
//   paid Rs 100 in cash on output CGST 100 + SGST 100 against credit IGST
//   100 + CGST 100; the optimum pays nothing.
// - A payment the bank cannot fund is appended anyway and reported as a
//   shortfall, so generation retries instead of silently dropping it.

export type GstHead = 'CGST' | 'SGST' | 'IGST';
type HeadAmounts = Record<GstHead, number>;
export type GstPosition = {
  // Credit balances of the Output ledgers, per head (positive = owed).
  output: HeadAmounts;
  // Debit balances of the Input ledgers, per head (positive = credit available).
  input: HeadAmounts;
  // Credit balance of GST Payable, all heads together (positive = owed to the government).
  payable: number;
  // Credit balances of the reverse-charge Output ledgers ("Output CGST RCM").
  rcmOutput: HeadAmounts;
  // Debit balances of the reverse-charge Input ledgers ("Input CGST RCM").
  rcmInput: HeadAmounts;
};

const HEADS: GstHead[] = ['IGST', 'CGST', 'SGST'];
const round2 = (value: number): number => Math.round(value * 100) / 100;

function headOf(name: string): GstHead | null {
  if (/\bigst\b/i.test(name)) return 'IGST';
  if (/\bcgst\b/i.test(name)) return 'CGST';
  if (/\bsgst\b/i.test(name)) return 'SGST';
  return null;
}

function isGstLedger(name: string): boolean {
  return /gst/i.test(name);
}

function isRcm(name: string): boolean {
  return /\brcm\b|reverse charge/i.test(name);
}

const zero = (): HeadAmounts => ({ CGST: 0, SGST: 0, IGST: 0 });

export function emptyGstPosition(): GstPosition {
  return { output: zero(), input: zero(), payable: 0, rcmOutput: zero(), rcmInput: zero() };
}

// Applies one ledger movement (Dr positive) to the position.
function applyLedger(position: GstPosition, name: string, signedDr: number): void {
  const head = headOf(name);
  // "GST Payable", and per-head "CGST Payable" where the company keeps them.
  if (/payable/i.test(name)) {
    position.payable = round2(position.payable - signedDr);
    return;
  }
  if (head === null) return;
  const output = /\boutput\b/i.test(name);
  const input = /\b(input|itc)\b/i.test(name) || /c\/f/i.test(name);
  if (isRcm(name)) {
    if (output) position.rcmOutput[head] = round2(position.rcmOutput[head] - signedDr);
    else if (input) position.rcmInput[head] = round2(position.rcmInput[head] + signedDr);
    return;
  }
  if (output) {
    position.output[head] = round2(position.output[head] - signedDr);
  } else if (input) {
    position.input[head] = round2(position.input[head] + signedDr);
  }
}

// The authored pack carries GST as metadata (gst_head/gst_rate on the
// party and base legs), generated keys as real ledger legs. Both feed the
// same position. Metadata GST = base x rate on the base side of the
// voucher: sales/credit notes touch Output, purchases/debit notes Input.
export function gstPositionFromKeys(keys: AnswerKey[]): GstPosition {
  const position = emptyGstPosition();
  for (const key of keys) {
    for (const opening of key.opening_balances ?? []) {
      if (!isGstLedger(opening.account)) continue;
      applyLedger(position, opening.account, opening.dr_cr === 'Dr' ? opening.amount : -opening.amount);
    }
    const bySequence = new Map<number, AnswerKeyEntry[]>();
    for (const entry of key.entries) {
      const group = bySequence.get(entry.sequence) ?? [];
      group.push(entry);
      bySequence.set(entry.sequence, group);
    }
    for (const legs of bySequence.values()) {
      const ledgerLegs = legs.filter((leg) => isGstLedger(leg.correct_account));
      if (ledgerLegs.length > 0) {
        for (const leg of ledgerLegs) applyLedger(position, leg.correct_account, leg.dr_cr === 'Dr' ? leg.amount : -leg.amount);
        continue;
      }
      const taxed = legs.find((leg) => leg.gst_head !== null);
      if (!taxed) continue;
      const type = legs[0].voucher_type.trim().toLowerCase();
      const outputSide = type === 'sales' || type === 'credit note';
      const baseSide: 'Dr' | 'Cr' = type === 'sales' || type === 'debit note' ? 'Cr' : 'Dr';
      const base = legs.filter((leg) => leg.dr_cr === baseSide).reduce((sum, leg) => sum + leg.amount, 0);
      const rate = taxed.gst_rate ?? 18;
      const gst = round2((base * rate) / 100);
      const sign = type === 'credit note' || type === 'debit note' ? -1 : 1;
      const bucket = outputSide ? position.output : position.input;
      if (taxed.gst_head === 'IGST') {
        bucket.IGST = round2(bucket.IGST + sign * gst);
      } else {
        bucket.CGST = round2(bucket.CGST + sign * round2(gst / 2));
        bucket.SGST = round2(bucket.SGST + sign * round2(gst / 2));
      }
    }
  }
  return position;
}

export type JournalLeg = { account: string; dr_cr: 'Dr' | 'Cr'; amount: number };

// Credit utilisation: utilisation[creditHead][outputHead].
export type Utilisation = Record<GstHead, HeadAmounts>;

// The Rule 88A utilisation that leaves the least output unpaid.
// IGST credit goes first against IGST output, and must be used as fully as
// the liability allows before any CGST or SGST credit is touched. Its
// remainder u is split x to CGST and u - x to SGST; the cash left is a
// convex, piecewise-linear function of x, so its minimum is at one of the
// breakpoints tried below. Ties keep the larger CGST share (the order the
// greedy journal used).
export function optimiseSetOff(output: HeadAmounts, credit: HeadAmounts): { utilisation: Utilisation; cash: number } {
  const utilisationFor = (x: number): { utilisation: Utilisation; cash: number } => {
    const out = { ...output };
    const cred = { ...credit };
    const use: Utilisation = { IGST: zero(), CGST: zero(), SGST: zero() };
    const take = (from: GstHead, to: GstHead, amount: number) => {
      const applied = round2(Math.max(0, Math.min(amount, cred[from], out[to])));
      if (applied <= 0) return;
      use[from][to] = round2(use[from][to] + applied);
      cred[from] = round2(cred[from] - applied);
      out[to] = round2(out[to] - applied);
    };
    take('IGST', 'IGST', cred.IGST);
    take('IGST', 'CGST', x);
    take('IGST', 'SGST', cred.IGST);
    take('IGST', 'CGST', cred.IGST);
    take('CGST', 'CGST', cred.CGST);
    take('CGST', 'IGST', cred.CGST);
    take('SGST', 'SGST', cred.SGST);
    take('SGST', 'IGST', cred.SGST);
    return { utilisation: use, cash: round2(out.IGST + out.CGST + out.SGST) };
  };
  const afterIgst = Math.max(0, credit.IGST - Math.min(credit.IGST, output.IGST));
  const usable = Math.min(afterIgst, output.CGST + output.SGST);
  const low = Math.max(0, usable - output.SGST);
  const high = Math.min(usable, output.CGST);
  const clamp = (value: number) => round2(Math.min(high, Math.max(low, value)));
  const candidates = [...new Set([high, low, clamp(output.CGST - credit.CGST), clamp(usable - (output.SGST - credit.SGST))])].sort((a, b) => b - a);
  let best = utilisationFor(candidates[0]);
  for (const x of candidates.slice(1)) {
    const next = utilisationFor(x);
    if (next.cash < best.cash - 0.001) best = next;
  }
  return best;
}

export type SetOffOptions = {
  // RCM input credit whose tax was paid before this set-off (usable now).
  eligibleRcmInput?: HeadAmounts;
  // Transfer each head to "CGST Payable" etc. instead of one "GST Payable".
  perHeadPayable?: boolean;
};

export function payableLedgerFor(head: GstHead, perHeadPayable: boolean): string {
  return perHeadPayable ? `${head} Payable` : 'GST Payable';
}

// Output credit balances are utilised against input credit (regular first,
// then eligible RCM credit) in the least-cash Rule 88A split; whatever
// output remains, and all reverse-charge output, is transferred to the
// payable; whatever input remains is carried forward. Null when there is
// nothing to journal.
export function buildGstSetOff(position: GstPosition, options: SetOffOptions = {}): { legs: JournalLeg[]; after: GstPosition } | null {
  const eligibleRcm: HeadAmounts = options.eligibleRcmInput
    ? {
        CGST: Math.max(0, Math.min(options.eligibleRcmInput.CGST, position.rcmInput.CGST)),
        SGST: Math.max(0, Math.min(options.eligibleRcmInput.SGST, position.rcmInput.SGST)),
        IGST: Math.max(0, Math.min(options.eligibleRcmInput.IGST, position.rcmInput.IGST)),
      }
    : zero();
  const output = { ...position.output };
  const input = { ...position.input };
  const rcmInput = { ...position.rcmInput };
  const rcmOutput = { ...position.rcmOutput };
  const credit: HeadAmounts = {
    CGST: round2(Math.max(0, input.CGST) + eligibleRcm.CGST),
    SGST: round2(Math.max(0, input.SGST) + eligibleRcm.SGST),
    IGST: round2(Math.max(0, input.IGST) + eligibleRcm.IGST),
  };
  const positiveOutput: HeadAmounts = { CGST: Math.max(0, output.CGST), SGST: Math.max(0, output.SGST), IGST: Math.max(0, output.IGST) };
  const { utilisation } = optimiseSetOff(positiveOutput, credit);

  const legs: JournalLeg[] = [];
  const order: [GstHead, GstHead][] = [
    ['IGST', 'IGST'],
    ['IGST', 'CGST'],
    ['IGST', 'SGST'],
    ['CGST', 'CGST'],
    ['CGST', 'IGST'],
    ['SGST', 'SGST'],
    ['SGST', 'IGST'],
  ];
  for (const [from, to] of order) {
    const amount = utilisation[from][to];
    if (amount < 0.5) continue;
    legs.push({ account: `Output ${to}`, dr_cr: 'Dr', amount });
    // Regular credit first, then the RCM credit already paid for.
    const regular = round2(Math.min(amount, Math.max(0, input[from])));
    if (regular >= 0.005) {
      legs.push({ account: `Input ${from}`, dr_cr: 'Cr', amount: regular });
      input[from] = round2(input[from] - regular);
    }
    const fromRcm = round2(amount - regular);
    if (fromRcm >= 0.005) {
      legs.push({ account: `Input ${from} RCM`, dr_cr: 'Cr', amount: fromRcm });
      rcmInput[from] = round2(rcmInput[from] - fromRcm);
    }
    output[to] = round2(output[to] - amount);
  }

  const transfers = new Map<string, number>();
  for (const head of HEADS) {
    if (output[head] >= 0.5) {
      legs.push({ account: `Output ${head}`, dr_cr: 'Dr', amount: output[head] });
      const ledger = payableLedgerFor(head, options.perHeadPayable ?? false);
      transfers.set(ledger, round2((transfers.get(ledger) ?? 0) + output[head]));
      output[head] = 0;
    }
  }
  // Reverse-charge tax: never utilised, always paid in cash.
  for (const head of HEADS) {
    if (rcmOutput[head] >= 0.5) {
      legs.push({ account: `Output ${head} RCM`, dr_cr: 'Dr', amount: rcmOutput[head] });
      const ledger = payableLedgerFor(head, options.perHeadPayable ?? false);
      transfers.set(ledger, round2((transfers.get(ledger) ?? 0) + rcmOutput[head]));
      rcmOutput[head] = 0;
    }
  }
  let transferred = 0;
  for (const [ledger, amount] of transfers) {
    legs.push({ account: ledger, dr_cr: 'Cr', amount });
    transferred = round2(transferred + amount);
  }
  if (legs.length === 0) return null;
  return { legs, after: { output, input, payable: round2(position.payable + transferred), rcmOutput, rcmInput } };
}

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function lastDayOf(monthIndex: number, year: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// The set-off's date (2026-09-16): licensed Tally takes the real month end,
// but Educational Mode never saves the 28th, 29th or 30th, so 30-Jun or
// 28-Feb made the set-off unpostable. Educational learners get the last
// ALLOWED day instead: the 31st where the month has one, else the 2nd. The
// payment (day 2) is appended first, so on a shared 2nd it still carries
// the lower sequence and precedes the set-off.
function setOffDay(licenseMode: LicenseMode, monthIndex: number, year: number): number {
  if (licenseMode === 'educational') {
    const allowed = educationalDaysFor(monthIndex, year);
    return allowed[allowed.length - 1];
  }
  return lastDayOf(monthIndex, year);
}

export function paymentDay(licenseMode: LicenseMode): number {
  return licenseMode === 'educational' ? 2 : 20;
}

function dateLabel(day: number, monthIndex: number, year: number): string {
  return `${String(day).padStart(2, '0')}-${MONTH_ABBREVS[monthIndex]}-${year}`;
}

function entryTemplate(sequence: number, leg: JournalLeg, voucherType: string, conceptTags: ConceptTag[]): AnswerKeyEntry {
  return {
    sequence,
    correct_account: leg.account,
    dr_cr: leg.dr_cr,
    amount: leg.amount,
    voucher_type: voucherType,
    gst_head: headOf(leg.account),
    gst_rate: null,
    tds_section: null,
    tds_rate: null,
    tds_base: null,
    bill_reference: null,
    narration: null,
    concept_tags: conceptTags,
    requires_source_document: false,
    source_document_type: null,
  };
}

// A model-written GST set-off (a journal touching both an Output and an
// Input or Payable ledger) or GST payment (a payment debiting GST Payable).
// Their figures are the ones the audits found invented; the code-built
// versions below replace them.
function isModelGstJournal(legs: AnswerKeyEntry[]): boolean {
  const type = legs[0].voucher_type.trim().toLowerCase();
  const names = legs.map((leg) => leg.correct_account);
  // A reverse-charge self-invoicing journal (Dr Input GST RCM / Cr Output
  // GST RCM, rulebook 13) also touches both sides, but it is one of the
  // month's transactions, not the month-end utilisation: keep it. Only a
  // journal whose GST legs are ALL reverse-charge is one (2026-09-17).
  const gstNames = names.filter((name) => isGstLedger(name) && headOf(name) !== null);
  if (gstNames.length > 0 && gstNames.every(isRcm) && !names.some((name) => /payable/i.test(name))) return false;
  if (type === 'journal') {
    const touchesOutput = names.some((name) => /output/i.test(name) && headOf(name) !== null);
    const touchesInputOrPayable = names.some((name) => (/input|itc/i.test(name) && headOf(name) !== null) || /gst payable/i.test(name));
    return touchesOutput && touchesInputOrPayable;
  }
  if (type === 'payment') {
    return legs.some((leg) => leg.dr_cr === 'Dr' && /gst payable/i.test(leg.correct_account));
  }
  return false;
}

export type MonthEndParams = {
  priorKeys: AnswerKey[];
  concepts: ConceptTag[];
  month: { monthIndex: number; year: number };
  licenseMode: LicenseMode;
  bankAccount: string;
  // Bank balance after the model's own transactions. A payment above it is
  // still appended and reported as paymentShortfall.
  bankAfterBatch: number;
  // The company's ledger names: per-head payable ledgers ("CGST Payable",
  // "SGST Payable", "IGST Payable") are used when all three exist; otherwise
  // the single "GST Payable" the rulebook's 9B journal names.
  ledgerNames?: string[];
};

export type MonthEndResult = {
  generated: GeneratedExercise;
  appended: { setOff: boolean; payment: boolean };
  // The payment the batch's bank balance cannot fund; null when it can.
  paymentShortfall: { payable: number; bank: number } | null;
};

function hasPerHeadPayables(ledgerNames: string[] | undefined): boolean {
  const names = new Set((ledgerNames ?? []).map((name) => name.trim().toLowerCase()));
  return HEADS.every((head) => names.has(`${head.toLowerCase()} payable`));
}

// What each payable ledger holds, from the keys' movements.
function payableBalances(keys: AnswerKey[]): Map<string, number> {
  const balances = new Map<string, number>();
  const apply = (account: string, signedCr: number) => {
    if (!/payable/i.test(account) || !isGstLedger(account)) return;
    balances.set(account, round2((balances.get(account) ?? 0) + signedCr));
  };
  for (const key of keys) {
    for (const opening of key.opening_balances ?? []) apply(opening.account, opening.dr_cr === 'Cr' ? opening.amount : -opening.amount);
    for (const entry of key.entries) apply(entry.correct_account, entry.dr_cr === 'Cr' ? entry.amount : -entry.amount);
  }
  return balances;
}

export function appendMonthEndJournals(generated: GeneratedExercise, params: MonthEndParams): MonthEndResult {
  const wantsSetOff = params.concepts.includes('gst_set_off');
  const wantsPayment = params.concepts.includes('gst_payment');
  const appended = { setOff: false, payment: false };
  if (!wantsSetOff && !wantsPayment) {
    return { generated, appended, paymentShortfall: null };
  }

  // Drop the model's own attempts, renumber what remains.
  const bySequence = new Map<number, AnswerKeyEntry[]>();
  for (const entry of generated.answer_key.entries) {
    const group = bySequence.get(entry.sequence) ?? [];
    group.push(entry);
    bySequence.set(entry.sequence, group);
  }
  const dropped = new Set<number>();
  for (const [sequence, legs] of bySequence) if (isModelGstJournal(legs)) dropped.add(sequence);
  const kept = generated.transactions.filter((transaction) => !dropped.has(transaction.sequence)).sort((a, b) => a.sequence - b.sequence);
  const renumber = new Map<number, number>(kept.map((transaction, index) => [transaction.sequence, index + 1]));
  let transactions = kept.map((transaction) => ({ ...transaction, sequence: renumber.get(transaction.sequence) ?? transaction.sequence }));
  let entries = generated.answer_key.entries
    .filter((entry) => !dropped.has(entry.sequence))
    .map((entry) => ({ ...entry, sequence: renumber.get(entry.sequence) ?? entry.sequence }));

  const { monthIndex, year } = params.month;
  const priorPosition = gstPositionFromKeys(params.priorKeys);
  const perHeadPayable = hasPerHeadPayables(params.ledgerNames);
  let paymentShortfall: MonthEndResult['paymentShortfall'] = null;

  if (wantsPayment && priorPosition.payable >= 1) {
    const amount = priorPosition.payable;
    if (amount > params.bankAfterBatch + 0.005) {
      paymentShortfall = { payable: amount, bank: params.bankAfterBatch };
    }
    const day = paymentDay(params.licenseMode);
    const sequence = transactions.length + 1;
    const rupees = Math.round(amount).toLocaleString('en-IN');
    transactions = [
      ...transactions,
      {
        sequence,
        description: `On ${dateLabel(day, monthIndex, year)}, pay the GST liability for the previous month to the government from the bank: Rs ${rupees}, being the balance standing in ${perHeadPayable ? 'the CGST, SGST and IGST Payable ledgers' : 'GST Payable'} (challan paid online).`,
      },
    ];
    // Each payable ledger is cleared by its own debit; one bank credit.
    const balances = [...payableBalances(params.priorKeys).entries()].filter(([, balance]) => balance >= 0.5);
    const debitLegs: JournalLeg[] =
      balances.length > 0 && Math.abs(balances.reduce((sum, [, balance]) => sum + balance, 0) - amount) < 0.5
        ? balances.map(([account, balance]) => ({ account, dr_cr: 'Dr' as const, amount: balance }))
        : [{ account: 'GST Payable', dr_cr: 'Dr', amount }];
    entries = [
      ...entries,
      ...debitLegs.map((leg) => entryTemplate(sequence, leg, 'Payment', ['gst_payment', 'payment_voucher_basics'])),
      entryTemplate(sequence, { account: params.bankAccount, dr_cr: 'Cr', amount }, 'Payment', ['gst_payment', 'payment_voucher_basics']),
    ];
    appended.payment = true;
  }

  if (wantsSetOff) {
    const position = gstPositionFromKeys([...params.priorKeys, { entries, opening_balances: [] }]);
    // RCM credit booked in earlier months has had its tax paid by now (the
    // earlier set-off moved it to the payable, paid in this month's
    // payment); this month's RCM credit waits for next month.
    const setOff = buildGstSetOff(position, { eligibleRcmInput: priorPosition.rcmInput, perHeadPayable });
    if (setOff) {
      const sequence = transactions.length + 1;
      transactions = [
        ...transactions,
        {
          sequence,
          description: `On ${dateLabel(setOffDay(params.licenseMode, monthIndex, year), monthIndex, year)}, pass the month-end GST set-off journal: utilise the input tax credit against the output GST balance in the statutory order (IGST credit first, then CGST and SGST, never CGST credit against SGST), leaving the least possible to pay, and transfer the net amount payable, together with any reverse-charge tax (always paid in cash), to ${perHeadPayable ? 'the CGST, SGST and IGST Payable ledgers' : 'GST Payable'}. Take every figure from your own GST ledger balances at month end.`,
        },
      ];
      entries = [
        ...entries,
        ...setOff.legs.map((leg) => entryTemplate(sequence, leg, 'Journal', ['gst_set_off', 'journal_voucher_basics'])),
      ];
      appended.setOff = true;
    }
  }

  return {
    generated: { ...generated, transactions, answer_key: { ...generated.answer_key, entries } },
    appended,
    paymentShortfall,
  };
}

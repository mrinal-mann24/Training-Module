import type { AnswerKey, AnswerKeyEntry, ConceptTag, GeneratedExercise } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';

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

export type GstHead = 'CGST' | 'SGST' | 'IGST';
export type GstPosition = {
  // Credit balances of the Output ledgers, per head (positive = owed).
  output: Record<GstHead, number>;
  // Debit balances of the Input ledgers, per head (positive = credit available).
  input: Record<GstHead, number>;
  // Credit balance of GST Payable (positive = owed to the government).
  payable: number;
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

function emptyPosition(): GstPosition {
  return { output: { CGST: 0, SGST: 0, IGST: 0 }, input: { CGST: 0, SGST: 0, IGST: 0 }, payable: 0 };
}

// Applies one ledger movement (Dr positive) to the position.
function applyLedger(position: GstPosition, name: string, signedDr: number): void {
  const head = headOf(name);
  if (/payable/i.test(name) && head === null) {
    position.payable = round2(position.payable - signedDr);
    return;
  }
  if (head === null) return;
  if (/\b(output)\b/i.test(name)) {
    position.output[head] = round2(position.output[head] - signedDr);
  } else if (/\b(input|itc)\b/i.test(name) || /c\/f/i.test(name)) {
    position.input[head] = round2(position.input[head] + signedDr);
  }
}

// The authored pack carries GST as metadata (gst_head/gst_rate on the
// party and base legs), generated keys as real ledger legs. Both feed the
// same position. Metadata GST = base x rate on the base side of the
// voucher: sales/credit notes touch Output, purchases/debit notes Input.
export function gstPositionFromKeys(keys: AnswerKey[]): GstPosition {
  const position = emptyPosition();
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

// Statutory set-off order: IGST credit against IGST, then CGST, then SGST
// output; CGST credit against CGST then IGST; SGST credit against SGST then
// IGST. Whatever output remains is transferred to GST Payable; whatever
// input remains is carried forward. Returns null when there is no output
// liability to set off.
export function buildGstSetOff(position: GstPosition): { legs: JournalLeg[]; after: GstPosition } | null {
  const output = { ...position.output };
  const input = { ...position.input };
  const legs: JournalLeg[] = [];
  const utilise = (inputHead: GstHead, outputHead: GstHead) => {
    const amount = round2(Math.min(input[inputHead], output[outputHead]));
    if (amount < 0.5) return;
    legs.push({ account: `Output ${outputHead}`, dr_cr: 'Dr', amount });
    legs.push({ account: `Input ${inputHead}`, dr_cr: 'Cr', amount });
    input[inputHead] = round2(input[inputHead] - amount);
    output[outputHead] = round2(output[outputHead] - amount);
  };
  utilise('IGST', 'IGST');
  utilise('IGST', 'CGST');
  utilise('IGST', 'SGST');
  utilise('CGST', 'CGST');
  utilise('CGST', 'IGST');
  utilise('SGST', 'SGST');
  utilise('SGST', 'IGST');

  let transferred = 0;
  for (const head of HEADS) {
    if (output[head] >= 0.5) {
      legs.push({ account: `Output ${head}`, dr_cr: 'Dr', amount: output[head] });
      transferred = round2(transferred + output[head]);
      output[head] = 0;
    }
  }
  if (transferred >= 0.5) {
    legs.push({ account: 'GST Payable', dr_cr: 'Cr', amount: transferred });
  }
  if (legs.length === 0) return null;
  return { legs, after: { output, input, payable: round2(position.payable + transferred) } };
}

const MONTH_ABBREVS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function lastDayOf(monthIndex: number, year: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
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
  // Bank balance after the model's own transactions, so the payment never
  // overdraws.
  bankAfterBatch: number;
};

export type MonthEndResult = {
  generated: GeneratedExercise;
  appended: { setOff: boolean; payment: boolean };
};

export function appendMonthEndJournals(generated: GeneratedExercise, params: MonthEndParams): MonthEndResult {
  const wantsSetOff = params.concepts.includes('gst_set_off');
  const wantsPayment = params.concepts.includes('gst_payment');
  const appended = { setOff: false, payment: false };
  if (!wantsSetOff && !wantsPayment) {
    return { generated, appended };
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
  let transactions = kept.map((transaction) => ({ ...transaction, sequence: renumber.get(transaction.sequence)! }));
  let entries = generated.answer_key.entries
    .filter((entry) => !dropped.has(entry.sequence))
    .map((entry) => ({ ...entry, sequence: renumber.get(entry.sequence)! }));

  const { monthIndex, year } = params.month;
  const priorPosition = gstPositionFromKeys(params.priorKeys);
  let bank = params.bankAfterBatch;

  if (wantsPayment && priorPosition.payable >= 1 && priorPosition.payable <= bank) {
    const amount = priorPosition.payable;
    const day = params.licenseMode === 'educational' ? 2 : 20;
    const sequence = transactions.length + 1;
    const rupees = Math.round(amount).toLocaleString('en-IN');
    transactions = [
      ...transactions,
      {
        sequence,
        description: `On ${dateLabel(day, monthIndex, year)}, pay the GST liability for the previous month to the government from the bank: Rs ${rupees}, being the balance standing in GST Payable (challan paid online).`,
      },
    ];
    entries = [
      ...entries,
      entryTemplate(sequence, { account: 'GST Payable', dr_cr: 'Dr', amount }, 'Payment', ['gst_payment', 'payment_voucher_basics']),
      entryTemplate(sequence, { account: params.bankAccount, dr_cr: 'Cr', amount }, 'Payment', ['gst_payment', 'payment_voucher_basics']),
    ];
    bank = round2(bank - amount);
    appended.payment = true;
  }

  if (wantsSetOff) {
    const position = gstPositionFromKeys([...params.priorKeys, { entries, opening_balances: [] }]);
    const setOff = buildGstSetOff(position);
    if (setOff) {
      const sequence = transactions.length + 1;
      transactions = [
        ...transactions,
        {
          sequence,
          description: `On ${dateLabel(lastDayOf(monthIndex, year), monthIndex, year)}, pass the month-end GST set-off journal: utilise the input tax credit against the month's output GST in the statutory order (IGST first, then CGST, then SGST) and transfer the net amount payable to GST Payable. Take every figure from your own GST ledger balances at month end.`,
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
  };
}

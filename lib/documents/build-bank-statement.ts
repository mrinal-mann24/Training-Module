import type { GeneratedExercise } from '@/lib/schemas/exercise';
import type { BankStatementContent } from '@/lib/schemas/source-document';
import { isBankLedger, partyLegOf, splitBillReferences } from '@/lib/db/queries/company';
import { extractTransactionDate, formatInvoiceDate } from '@/lib/llm/prompts/source-document';

// The bank statement is built by CODE from the answer key, not by the model
// (2026-09-03). The model-written statement carried a running balance it
// invented (1.25L on a 9L account), reference numbers that did not match
// the key's narrations, and — before the open-bills guard — bill numbers
// nobody could allocate against. Everything on the statement now comes
// from the books: each line is a bank-side leg of the batch, the balance
// walks from the company's real opening bank balance, and the reference
// is generated once and written into both the statement line and the
// answer key's narration (applyBankReferences).

type Entry = GeneratedExercise['answer_key']['entries'][number];

export type BuiltBankStatement = {
  content: BankStatementContent;
  referenceBySequence: Map<number, string>;
};

type BankMovement = {
  sequence: number;
  date: { day: number; monthIndex: number; year: number };
  amount: number;
  inflow: boolean;
  voucherType: string;
  party: string | null;
  billReference: string | null;
};

const CASH_LEDGER_PATTERN = /^cash\b|cash-in-hand/i;

function counterpartyCode(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 &]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24);
}

function yymmdd(date: BankMovement['date']): string {
  return `${String(date.year).slice(-2)}${String(date.monthIndex + 1).padStart(2, '0')}${String(date.day).padStart(2, '0')}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatRupees(value: number): string {
  return `Rs ${Math.round(value).toLocaleString('en-IN')}`;
}

// The statement's reference for one movement — real-bank shaped, unique per
// batch line (date + sequence), and carrying the bill reference where the
// key has one so the learner can allocate bill-by-bill from the statement.
export function bankReferenceFor(movement: BankMovement): string {
  const stamp = `${yymmdd(movement.date)}${String(movement.sequence).padStart(2, '0')}`;
  if (/^contra$/i.test(movement.voucherType)) {
    return movement.inflow ? `CASH DEPOSIT/CD${stamp}/CASH` : `CASH WITHDRAWAL/CW${stamp}/CASH`;
  }
  const party = movement.party ? counterpartyCode(movement.party) : 'PARTY';
  const tail = movement.billReference ?? (movement.inflow ? 'RCP' : 'PMT');
  return `NEFT/N${stamp}/${party}/${tail}`;
}

export function collectBankMovements(generated: GeneratedExercise): BankMovement[] {
  const descriptionBySequence = new Map<number, string>();
  for (const transaction of generated.transactions) {
    descriptionBySequence.set(transaction.sequence, transaction.description);
  }
  const bySequence = new Map<number, Entry[]>();
  for (const entry of generated.answer_key.entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }

  const movements: BankMovement[] = [];
  for (const [sequence, legs] of bySequence) {
    const bankLeg = legs.find((leg) => isBankLedger(leg.correct_account));
    if (!bankLeg) {
      continue;
    }
    const date = extractTransactionDate(descriptionBySequence.get(sequence) ?? '');
    if (!date) {
      continue;
    }
    const party = partyLegOf(legs.filter((leg) => !CASH_LEDGER_PATTERN.test(leg.correct_account)));
    const reference = legs[0].bill_reference;
    movements.push({
      sequence,
      date,
      amount: round2(bankLeg.amount),
      inflow: bankLeg.dr_cr === 'Dr',
      voucherType: legs[0].voucher_type,
      party: party?.correct_account ?? null,
      billReference: reference ? (splitBillReferences(reference)[0] ?? null) : null,
    });
  }

  return movements.sort((a, b) => {
    const da = Date.UTC(a.date.year, a.date.monthIndex, a.date.day);
    const db = Date.UTC(b.date.year, b.date.monthIndex, b.date.day);
    return da - db || a.sequence - b.sequence;
  });
}

// ONE statement covering every bank movement in the batch (a real statement
// lists everything, and the balance column only holds if nothing is
// skipped), walked from the company's real opening bank balance.
export function buildBankStatementContent(params: {
  companyName: string;
  openingBankBalance: number;
  generated: GeneratedExercise;
}): BuiltBankStatement | null {
  const movements = collectBankMovements(params.generated);
  if (movements.length === 0) {
    return null;
  }

  const referenceBySequence = new Map<number, string>();
  let balance = round2(params.openingBankBalance);
  const transactions = movements.map((movement) => {
    const reference = bankReferenceFor(movement);
    referenceBySequence.set(movement.sequence, reference);
    balance = round2(balance + (movement.inflow ? movement.amount : -movement.amount));
    return {
      date: formatInvoiceDate(movement.date),
      narration: reference,
      debit: movement.inflow ? null : movement.amount,
      credit: movement.inflow ? movement.amount : null,
      balance,
    };
  });

  return {
    content: {
      accountHolderName: params.companyName,
      period: `${transactions[0].date} to ${transactions[transactions.length - 1].date}`,
      transactions,
    },
    referenceBySequence,
  };
}

// Rewrites the answer key's narration for every sequence on the statement
// so the reference the learner is told to copy "verbatim" is the one the
// statement actually prints.
export function applyBankReferences(
  generated: GeneratedExercise,
  referenceBySequence: Map<number, string>,
): GeneratedExercise {
  if (referenceBySequence.size === 0) {
    return generated;
  }
  const movements = new Map(collectBankMovements(generated).map((movement) => [movement.sequence, movement]));
  const entries = generated.answer_key.entries.map((entry) => {
    const reference = referenceBySequence.get(entry.sequence);
    const movement = movements.get(entry.sequence);
    if (!reference || !movement) {
      return entry;
    }
    const against = movement.billReference ? `, against ${movement.billReference}` : '';
    let narration: string;
    if (/^contra$/i.test(movement.voucherType)) {
      narration = movement.inflow
        ? `Cash deposited into bank, ${formatRupees(movement.amount)}, Ref ${reference}.`
        : `Cash withdrawn from bank, ${formatRupees(movement.amount)}, Ref ${reference}.`;
    } else if (movement.inflow) {
      narration = `Received ${formatRupees(movement.amount)} from ${movement.party ?? 'party'} via bank, Ref ${reference}${against}.`;
    } else {
      narration = `Paid ${formatRupees(movement.amount)} to ${movement.party ?? 'party'} via bank, Ref ${reference}${against}.`;
    }
    return { ...entry, narration };
  });
  return { ...generated, answer_key: { ...generated.answer_key, entries } };
}

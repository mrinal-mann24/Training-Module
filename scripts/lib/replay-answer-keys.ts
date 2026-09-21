// Replays a learner's stored answer keys in timeline order and re-runs the
// generator's own checks on each one, with the context the generator would
// have had at the time (rebuilt from the keys before it). Pure: no database
// access, no writes. Used by scripts/audit-answer-keys.ts (read-only audit)
// and by the correction and verification scripts (2026-09-22 plan, Part B).
//
// Nothing here trusts a claim about a key: a defect counts only when one of
// the generator's checks reproduces it from the data.

import {
  cashPositionFromNet,
  documentNumberOf,
  netAnswerKeys,
  normalizeBillReference,
  partyLegOf,
  openAdvancesFromKeys,
  openBillsFromKeys,
  openingBalancesFromNet,
  partyTaxClassesFromKeys,
  type OpenAdvance,
  type OpenBill,
  type OpeningBalance,
} from '@/lib/db/queries/company';
import { exerciseMonthForModule, runGenerationChecks, type ExerciseMonth } from '@/lib/tutor/generate-exercise';
import { priorBillReferences, tdsHistoryFromKeys } from '@/lib/tutor/generation-checks';
import { gstPositionFromKeys, type GstPosition } from '@/lib/tutor/month-end-journals';
import { EXERCISE_DIFFICULTY_LEVELS, type AnswerKey, type GeneratedExercise } from '@/lib/schemas/exercise';

export type StoredDocument = { doc_type: string; structured_data: unknown };

export type StoredExerciseRow = {
  id: string;
  created_at: string;
  kind: string;
  scenario: unknown;
  answer_key: AnswerKey | null;
  // exercise_source_documents of this exercise, when the caller loaded them.
  documents?: StoredDocument[];
};

type InvoiceData = {
  invoiceNumber?: string;
  totalAmount?: number;
  vendorGSTIN?: string | null;
  buyerGSTIN?: string | null;
  taxBreakup?: { cgst_amount?: number | null; sgst_amount?: number | null; igst_amount?: number | null };
};

type StoredScenario = {
  scenario?: string;
  transactions?: { sequence: number; description: string }[];
  difficulty_level?: string;
  variant?: string;
  documents_only?: boolean;
};

export type OpeningDrift = { account: string; stored: number; recomputed: number };

export type KeyReport = {
  ordinal: number;
  exerciseId: string;
  createdAt: string;
  kind: string;
  month: ExerciseMonth;
  // The month the scenario text names, when it names one ("May 2025: ...").
  scenarioMonth: string | null;
  hard: string[];
  soft: string[];
  // The documents the learner received against the key: printed number,
  // total, and the GST head the printed GSTIN's state implies. The
  // generator's place-of-supply check reads the state from the party NAME,
  // so a document printed with an out-of-state GSTIN while the key charges
  // CGST/SGST (Praveen's SL/119, MA/206, HR/101) is visible only here.
  documentMismatches: string[];
  // A balance-sheet ledger driven past its balance by this key (Garima's
  // May 2025 Suspense journal of 39,900 against a 5,000 balance). Only
  // ledgers that must never change sign are checked: Suspense, Prepaid,
  // Outstanding, TDS/GST Payable, Cash.
  overdrawnLedgers: string[];
  // Stored opening_balances against the position replayed from the keys
  // before this one (signed, Dr positive). Empty when the key carries no
  // openings (the pack's are authored) or when they agree.
  openingDrift: OpeningDrift[];
  cashBefore: { cash: number; bank: number };
  openBillsBefore: OpenBill[];
  openAdvancesBefore: OpenAdvance[];
};

export type ReplayReport = {
  learnerId: string;
  keys: KeyReport[];
  // created_at ties make the timeline order arbitrary: a hard stop.
  createdAtTies: string[][];
  // Ledger names that appear in exactly one key (phantom-ledger detection).
  singleKeyLedgers: { account: string; exerciseId: string }[];
  openBillsAtEnd: OpenBill[];
  openAdvancesAtEnd: OpenAdvance[];
  gstAtEnd: GstPosition;
  closingBalances: OpeningBalance[];
};

const MONTH_LABEL = /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/;

function toGenerated(row: StoredExerciseRow, key: AnswerKey): GeneratedExercise {
  const scenario = (row.scenario ?? {}) as StoredScenario;
  const level = EXERCISE_DIFFICULTY_LEVELS.find((candidate) => candidate === scenario.difficulty_level) ?? 'L1';
  return {
    scenario: scenario.scenario ?? '',
    transactions: scenario.transactions ?? [],
    difficulty_level: level,
    variant: scenario.variant === 'B' ? 'B' : 'A',
    ...(scenario.documents_only !== undefined ? { documents_only: scenario.documents_only } : {}),
    answer_key: key,
  };
}

const COMPANY_STATE_CODE = '29';
const rupees = (value: number): string => Math.round(value).toLocaleString('en-IN');

// Ledgers whose balance is a stock that a journal may only draw down to
// zero; a Dr-natured ledger going Cr (or the reverse) is a phantom entry.
const ONE_SIDED_LEDGER = /suspense|prepaid|outstanding|payable|^cash\b|cash-in-hand/i;

function documentMismatchesOf(row: StoredExerciseRow, key: AnswerKey): string[] {
  const documents = row.documents ?? [];
  if (documents.length === 0) return [];
  const messages: string[] = [];
  const bySequence = new Map<number, AnswerKey['entries']>();
  for (const entry of key.entries) {
    const legs = bySequence.get(entry.sequence) ?? [];
    legs.push(entry);
    bySequence.set(entry.sequence, legs);
  }
  const invoices = documents
    .filter((doc) => doc.doc_type === 'vendor_invoice' || doc.doc_type === 'sales_invoice')
    .map((doc) => ({ type: doc.doc_type, data: (doc.structured_data ?? {}) as InvoiceData }));

  for (const [sequence, legs] of bySequence) {
    const type = legs[0].voucher_type.trim().toLowerCase();
    if (type !== 'sales' && type !== 'purchase') continue;
    const reference = legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
    const own = documentNumberOf(reference);
    const party = partyLegOf(legs, legs[0].voucher_type);
    if (!own || !party) continue;
    const wanted = type === 'sales' ? 'sales_invoice' : 'vendor_invoice';
    const ofType = invoices.filter((invoice) => invoice.type === wanted);
    // Batches before documents mode carried no sales invoices at all, and a
    // voucher the key marks as document-backed is the only one that must
    // have a printed document.
    if (ofType.length === 0) continue;
    const document = ofType.find((invoice) => normalizeBillReference(invoice.data.invoiceNumber ?? '') === normalizeBillReference(own));
    if (!document) {
      if (!legs.some((leg) => leg.requires_source_document)) continue;
      messages.push(`transaction ${sequence}: key number ${own} appears on no ${wanted.replace('_', ' ')} (printed: ${ofType.map((invoice) => invoice.data.invoiceNumber ?? '?').join(', ')})`);
      continue;
    }
    // A vendor bill prints the gross amount; the key credits the party net of
    // TDS, so the TDS legs are added back before comparing.
    const tdsWithheld = legs.filter((leg) => leg.dr_cr === party.dr_cr && leg !== party && /\btds\b/i.test(leg.correct_account)).reduce((sum, leg) => sum + leg.amount, 0);
    const total = document.data.totalAmount ?? 0;
    if (Math.abs(total - (party.amount + tdsWithheld)) >= 0.5) {
      messages.push(`transaction ${sequence}: ${own} prints total ${rupees(total)}, key party leg is ${rupees(party.amount)}${tdsWithheld ? ` plus TDS ${rupees(tdsWithheld)}` : ''}`);
    }
    const gstin = type === 'sales' ? document.data.buyerGSTIN : document.data.vendorGSTIN;
    const heads = new Set(legs.map((leg) => leg.gst_head).filter((head): head is 'CGST' | 'SGST' | 'IGST' => head !== null));
    if (gstin && /^\d{2}/.test(gstin) && heads.size > 0) {
      const intra = gstin.slice(0, 2) === COMPANY_STATE_CODE;
      if (intra && heads.has('IGST')) messages.push(`transaction ${sequence}: ${own} prints GSTIN ${gstin} (Karnataka) but the key charges IGST`);
      if (!intra && (heads.has('CGST') || heads.has('SGST'))) {
        messages.push(`transaction ${sequence}: ${own} prints GSTIN ${gstin} (state ${gstin.slice(0, 2)}) but the key charges CGST/SGST`);
      }
    }
    const tax = document.data.taxBreakup;
    const gstLegs = legs.filter((leg) => /gst/i.test(leg.correct_account));
    // Keys from before 2026-09-11 hold GST as metadata on the party leg with
    // no GST ledger legs; only a key that posts GST legs can be compared.
    if (tax && gstLegs.length > 0) {
      const printedTax = (tax.cgst_amount ?? 0) + (tax.sgst_amount ?? 0) + (tax.igst_amount ?? 0);
      const keyTax = gstLegs.reduce((sum, leg) => sum + leg.amount, 0);
      if (Math.abs(printedTax - keyTax) >= 0.5) {
        messages.push(`transaction ${sequence}: ${own} prints GST ${rupees(printedTax)}, key GST legs total ${rupees(keyTax)}`);
      }
    }
  }
  return messages;
}

function overdrawnLedgersOf(before: Map<string, number>, key: AnswerKey): string[] {
  const running = new Map(before);
  const messages: string[] = [];
  const entries = [...key.entries].sort((a, b) => a.sequence - b.sequence);
  for (const entry of entries) {
    if (!ONE_SIDED_LEDGER.test(entry.correct_account)) continue;
    const opening = before.get(entry.correct_account) ?? 0;
    const previous = running.get(entry.correct_account) ?? 0;
    const next = previous + (entry.dr_cr === 'Dr' ? entry.amount : -entry.amount);
    running.set(entry.correct_account, next);
    // A ledger that had a balance and is now pushed past zero to the other side.
    if (Math.abs(opening) >= 0.5 && Math.sign(next) !== 0 && Math.sign(next) !== Math.sign(opening) && Math.abs(next) >= 0.5) {
      messages.push(`transaction ${entry.sequence}: ${entry.correct_account} held ${rupees(opening)} before this key and is driven to ${rupees(next)}`);
    }
  }
  return messages;
}

function signed(opening: OpeningBalance): number {
  return opening.dr_cr === 'Dr' ? opening.amount : -opening.amount;
}

function openingDriftOf(stored: OpeningBalance[] | undefined, recomputed: OpeningBalance[]): OpeningDrift[] {
  if (!stored || stored.length === 0) return [];
  const drift: OpeningDrift[] = [];
  const storedBy = new Map(stored.map((opening) => [opening.account, signed(opening)]));
  const recomputedBy = new Map(recomputed.map((opening) => [opening.account, signed(opening)]));
  for (const account of new Set([...storedBy.keys(), ...recomputedBy.keys()])) {
    const a = storedBy.get(account) ?? 0;
    const b = recomputedBy.get(account) ?? 0;
    if (Math.abs(a - b) >= 0.5) drift.push({ account, stored: a, recomputed: b });
  }
  return drift.sort((x, y) => Math.abs(y.stored - y.recomputed) - Math.abs(x.stored - x.recomputed));
}

export function replayLearnerKeys(learnerId: string, rows: StoredExerciseRow[], companyName = 'Blossom Retail Pvt Ltd'): ReplayReport {
  const ordered = [...rows].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  const byCreatedAt = new Map<string, string[]>();
  for (const row of ordered) {
    const ids = byCreatedAt.get(row.created_at) ?? [];
    ids.push(row.id);
    byCreatedAt.set(row.created_at, ids);
  }
  const createdAtTies = [...byCreatedAt.values()].filter((ids) => ids.length > 1);

  const withKeys = ordered.filter((row): row is StoredExerciseRow & { answer_key: AnswerKey } => row.answer_key !== null);
  const keys = withKeys.map((row) => row.answer_key);
  const ledgerUse = new Map<string, Set<string>>();
  const reports: KeyReport[] = [];

  withKeys.forEach((row, ordinal) => {
    const priorKeys = keys.slice(0, ordinal);
    const yearStartIndex = Math.floor(ordinal / 12) * 12;
    const net = netAnswerKeys(priorKeys);
    const generated = toGenerated(row, row.answer_key);
    const scenarioMatch = MONTH_LABEL.exec(generated.scenario);
    const month = exerciseMonthForModule(ordinal + 1);
    const context = {
      month,
      cashPosition: cashPositionFromNet(net),
      // The pack (ordinal 0) settles the authored opening-balance bills the
      // keys never raised; the generator passes null there too.
      openBills: ordinal === 0 ? null : openBillsFromKeys(priorKeys),
      partyTaxClasses: partyTaxClassesFromKeys(priorKeys),
      priorRefs: priorBillReferences(priorKeys),
      tdsHistory: tdsHistoryFromKeys(priorKeys.slice(yearStartIndex)),
      documentsMode: generated.documents_only === true,
      companyName,
    };
    const { hard, soft } = runGenerationChecks(generated, context);
    for (const entry of row.answer_key.entries) {
      const uses = ledgerUse.get(entry.correct_account) ?? new Set<string>();
      uses.add(row.id);
      ledgerUse.set(entry.correct_account, uses);
    }
    reports.push({
      ordinal,
      exerciseId: row.id,
      createdAt: row.created_at,
      kind: row.kind,
      month,
      scenarioMonth: scenarioMatch ? `${scenarioMatch[1]} ${scenarioMatch[2]}` : null,
      hard,
      soft,
      documentMismatches: documentMismatchesOf(row, row.answer_key),
      overdrawnLedgers: overdrawnLedgersOf(net, row.answer_key),
      // The pack's openings are authored, not replayed: no drift to measure.
      openingDrift: ordinal === 0 ? [] : openingDriftOf(row.answer_key.opening_balances, openingBalancesFromNet(net)),
      cashBefore: context.cashPosition,
      openBillsBefore: context.openBills ?? [],
      openAdvancesBefore: ordinal === 0 ? [] : openAdvancesFromKeys(priorKeys),
    });
  });

  return {
    learnerId,
    keys: reports,
    createdAtTies,
    singleKeyLedgers: [...ledgerUse.entries()]
      .filter(([, ids]) => ids.size === 1)
      .map(([account, ids]) => ({ account, exerciseId: [...ids][0] })),
    openBillsAtEnd: openBillsFromKeys(keys),
    openAdvancesAtEnd: openAdvancesFromKeys(keys),
    gstAtEnd: gstPositionFromKeys(keys),
    closingBalances: openingBalancesFromNet(netAnswerKeys(keys)),
  };
}

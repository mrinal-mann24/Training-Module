import type { SupabaseClient } from '@supabase/supabase-js';
import { buildBankStatementContent, applyBankReferences } from '@/lib/documents/build-bank-statement';
import {
  appendCompanyTransactionLog,
  getCompanyState,
  isBankLedger,
  loadAnswerKeys,
  registerCompanyLedgers,
} from '@/lib/db/queries/company';
import { getPendingRectifications, markRectificationsCarried } from '@/lib/db/queries/carried-rectifications';
import { insertExercise } from '@/lib/db/queries/exercises';
import { buildBatchPlanPrompt, buildBatchPlanRetryPrompt, type BatchPlanParams } from '@/lib/llm/prompts/batch-plan';
import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import { batchPlanFromWire } from '@/lib/schemas/batch-plan-wire';
import type { ConceptTag, ExerciseDifficultyLevel, GeneratedExercise } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { classifyLedger, normalizeAccountName, partyAccountsOf } from '@/lib/tutor/account-names';
import { buildAnswerKey } from '@/lib/tutor/build-key';
import { eventMenuFor, supportsConcepts } from '@/lib/tutor/build-key/event-menu';
import { appendCarriedRectifications } from '@/lib/tutor/carried-rectifications';
import { applyDocumentsMode } from '@/lib/tutor/documents-mode';
import { educationalDaysFor } from '@/lib/tutor/educational-dates';
import {
  attachSourceDocuments,
  checkBatchComposition,
  exerciseMonthForModule,
  finalizeBatch,
  planSourceDocuments,
  prepareSourceDocuments,
  stampOpeningPosition,
} from '@/lib/tutor/generate-exercise';
import { priorDocumentNumbers, tdsHistoryFromKeys } from '@/lib/tutor/generation-checks';
import { assertKeyValid } from '@/lib/tutor/key-invariants';
import { applyKey, cashPositionOf, cloneLedgerState, openItemsOf, openingBalancesOf, replayKeys } from '@/lib/tutor/ledger-state';
import type { WeakConceptTarget } from '@/lib/tutor/mastery';
import { buildPartyMaster } from '@/lib/tutor/party-master';

// The planned generator (2026-09-22, rebuild Stage 4). The model writes the
// month's story as commercial events (lib/schemas/batch-plan.ts); code
// builds every ledger leg from the books (lib/tutor/build-key), appends the
// month-end journals, dates the batch, builds the documents, and runs the
// final invariant on the object that is persisted. A plan the books cannot
// support is sent back for a new story; nothing is ever patched after the
// checks. Same exercises row as the legacy generator, so the chat, scoring,
// coaching and hints are untouched.

const MAX_ATTEMPTS = 3;
const DEFAULT_COMPANY = 'Blossom Retail Pvt Ltd';

export type PlannedExerciseOutcome = { id: string } | 'unsupported';

// Everything up to, and excluding, the first write: the books are read, the
// model plans, code builds and checks. Split from the persistence below so
// scripts/dry-run-planned-batch.ts can run the real pipeline against a
// learner's real books and save nothing.
export type PlannedBatch = {
  exercise: GeneratedExercise;
  companyName: string;
  statementContent: NonNullable<ReturnType<typeof buildBankStatementContent>>['content'] | null;
  codeBuiltDocuments: Parameters<typeof prepareSourceDocuments>[5];
  documentLines: Map<number, { description: string; quantity: number; rate: number }[]>;
  rectificationIds: string[];
  // What each rejected attempt was sent back for (empty when the first plan held).
  rejectedAttempts: string[][];
};

export async function buildPlannedBatch(
  supabase: SupabaseClient,
  learnerId: string,
  target: WeakConceptTarget,
  difficultyLevel: ExerciseDifficultyLevel,
  recentStrengthDescriptions: string[],
  batchPlan: { strengths: ConceptTag[]; weaknesses: ConceptTag[] } | null,
  licenseMode: LicenseMode,
  exerciseOrdinal: number,
  documentsMode: boolean,
): Promise<PlannedBatch | 'unsupported'> {
  const concepts: ConceptTag[] = [
    target.conceptTag,
    ...(target.escalationActive || !batchPlan ? [] : [...batchPlan.strengths, ...batchPlan.weaknesses]),
  ];
  if (!supportsConcepts(concepts)) return 'unsupported';

  const [company, priorKeys] = await Promise.all([getCompanyState(supabase, learnerId), loadAnswerKeys(supabase, learnerId)]);
  const rectifications = await getPendingRectifications(supabase, learnerId, priorKeys);
  const companyName = company.companyName ?? DEFAULT_COMPANY;
  const state = replayKeys(priorKeys);
  const month = exerciseMonthForModule(exerciseOrdinal);
  const registryNames = company.ledgerRegistry.map((entry) => entry.ledger_name);
  const partyKeys = new Set<string>();
  for (const key of priorKeys) for (const party of partyAccountsOf(key.entries)) partyKeys.add(party);
  const partyNames = registryNames.filter((name) => partyKeys.has(normalizeAccountName(name)));
  const master = buildPartyMaster(partyNames);
  const menu = eventMenuFor(difficultyLevel, concepts, target.escalationActive);
  const bankAccount = company.openingBalances.find((opening) => isBankLedger(opening.account))?.account ?? 'HDFC Bank — 1234';
  const yearStartIndex = Math.floor((exerciseOrdinal - 1) / 12) * 12;
  const tdsHistory = tdsHistoryFromKeys(priorKeys.slice(yearStartIndex));
  const position = cashPositionOf(state);

  const params: BatchPlanParams = {
    companyName,
    monthLabel: month.label,
    month: { day: 1, monthIndex: month.monthIndex, year: month.year },
    difficultyLevel,
    targetConcept: target.conceptTag,
    strengthConcepts: target.escalationActive || !batchPlan ? [] : batchPlan.strengths,
    weaknessConcepts: target.escalationActive || !batchPlan ? [] : batchPlan.weaknesses,
    recentStrengthDescriptions,
    escalationActive: target.escalationActive,
    menu,
    postingDays: licenseMode === 'educational' ? educationalDaysFor(month.monthIndex, month.year) : 'any',
    parties: partyNames.map((name) => ({ name, state: master.resolve(name).state, role: 'unknown' as const })),
    openItems: openItemsOf(state),
    cash: position.cash,
    bank: position.bank,
    bankAccount,
    usedDocumentNumbers: priorDocumentNumbers(priorKeys),
    ledgerNames: registryNames.filter((name) => {
      const kind = classifyLedger(name, partyKeys);
      return kind === 'profit_and_loss' || (kind === 'balance_sheet' && /equipment|furniture|fixture|computer|machinery|vehicle|plant/i.test(name));
    }),
    tdsExposure: [...tdsHistory.entries()].map(([id, paidSoFar]) => {
      const [payee, section] = id.split('|');
      return { payee, section, paidSoFar };
    }),
    documentsMode,
  };

  let violations: string[] = [];
  let finalExercise: GeneratedExercise | null = null;
  let documentsPlan: ReturnType<typeof applyDocumentsMode> | null = null;
  let statement: ReturnType<typeof buildBankStatementContent> = null;
  // The plan's line items per sale/purchase, for the printed vendor invoice.
  let documentLines: Map<number, { description: string; quantity: number; rate: number }[]> = new Map();
  const rejectedAttempts: string[][] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS && finalExercise === null; attempt += 1) {
    if (violations.length > 0) rejectedAttempts.push(violations);
    const { messages, jsonSchema } = violations.length === 0 ? buildBatchPlanPrompt(params) : buildBatchPlanRetryPrompt(params, violations);
    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'batch-plan',
      learnerId,
      callType: 'batch-plan',
      extraMetadata: { targetConceptTag: target.conceptTag, reason: target.reason, attempt },
    });
    // The model answers in the flat wire shape; the typed plan is derived
    // and validated in code (lib/schemas/batch-plan-wire.ts).
    const converted = batchPlanFromWire(raw);
    if (!converted.ok) {
      violations = converted.violations;
      continue;
    }
    const parsed = { data: converted.plan };

    const built = buildAnswerKey({
      plan: parsed.data,
      state,
      master,
      menu,
      month: { monthIndex: month.monthIndex, year: month.year },
      difficultyLevel,
      licenseMode,
      bankAccount,
      usedDocumentNumbers: params.usedDocumentNumbers,
      tdsHistory,
      documentsMode,
    });
    if (built.generated === null) {
      violations = built.violations;
      continue;
    }
    documentLines = built.documentLines;

    // The composition rules bound the MODEL's events; a journal code derived
    // from one of them (reverse charge on a legal bill) is not the model's to
    // count, and used to push a full plan over the limit (dry run, Yeshas).
    const derived = new Set(built.derivedSequences);
    const planned: GeneratedExercise = {
      ...built.generated,
      transactions: built.generated.transactions.filter((transaction) => !derived.has(transaction.sequence)),
      answer_key: { ...built.generated.answer_key, entries: built.generated.answer_key.entries.filter((entry) => !derived.has(entry.sequence)) },
    };
    const composition = checkBatchComposition(planned, target.escalationActive || !batchPlan ? null : batchPlan, target.escalationActive);
    if (composition) {
      violations = [composition];
      continue;
    }

    // Carried rectifications (2026-09-22): the owner's correcting journals
    // for an earlier month ride in this batch, after the built vouchers and
    // before the month-end journals, so the bank walk, the dating and the
    // final invariant all see them.
    const withRectifications = appendCarriedRectifications(built.generated, rectifications, { monthIndex: month.monthIndex, year: month.year });

    // Month-end journals with figures from the ledger, then the dates Tally
    // will save, then the cash walk again (the legacy finalizeBatch).
    const after = cloneLedgerState(state);
    applyKey(after, withRectifications.answer_key);
    const finalized = finalizeBatch(withRectifications, {
      licenseMode,
      month: { monthIndex: month.monthIndex, year: month.year },
      cashPosition: position,
      monthEnd: {
        priorKeys,
        concepts,
        month: { monthIndex: month.monthIndex, year: month.year },
        licenseMode,
        bankAccount,
        bankAfterBatch: cashPositionOf(after).bank,
        ledgerNames: registryNames,
      },
    });
    if (finalized.errors.length > 0) {
      violations = finalized.errors;
      continue;
    }

    const stamped: GeneratedExercise = {
      ...stampOpeningPosition(finalized.generated, position, company.openingBalances),
      answer_key: { ...finalized.generated.answer_key, opening_balances: openingBalancesOf(state), engine: 'planned' },
    };
    documentsPlan = documentsMode ? applyDocumentsMode(stamped, { companyName, monthLabel: month.label, priorKeys }) : null;
    const modeApplied = documentsPlan ? documentsPlan.generated : stamped;
    statement =
      planSourceDocuments(modeApplied).bankLines.length > 0
        ? buildBankStatementContent({ companyName, openingBankBalance: position.bank, generated: modeApplied })
        : null;
    const candidate = statement ? applyBankReferences(modeApplied, statement.referenceBySequence) : modeApplied;

    const failures = assertKeyValid({
      priorKeys,
      state,
      generated: candidate,
      master,
      month,
      licenseMode,
      companyName,
      documentsMode,
      ordinal: priorKeys.length,
    });
    if (failures.length > 0) {
      violations = failures.map((failure) => `${failure.code}: ${failure.message}`);
      continue;
    }
    finalExercise = candidate;
  }

  if (finalExercise === null) {
    const history = [...rejectedAttempts, violations].map((reasons, index) => `attempt ${index + 1}: ${reasons.join(' | ')}`).join(' || ');
    throw new Error(`Planned exercise generation failed after ${MAX_ATTEMPTS} attempts. ${history}`);
  }

  const codeBuiltDocuments = documentsPlan
    ? [
        ...documentsPlan.salesInvoices.map(({ sequence, content }) => ({ document: { doc_type: 'sales_invoice' as const, content }, seed: `sales:${sequence}` })),
        ...(documentsPlan.monthEndNotes ? [{ document: { doc_type: 'month_end_note' as const, content: documentsPlan.monthEndNotes }, seed: 'month-end-notes' }] : []),
        ...(documentsPlan.salesRegister ? [{ document: { doc_type: 'sales_register' as const, content: documentsPlan.salesRegister }, seed: 'sales-register' }] : []),
      ]
    : [];
  return {
    exercise: finalExercise,
    companyName,
    statementContent: statement?.content ?? null,
    codeBuiltDocuments,
    documentLines,
    rectificationIds: rectifications.map((rectification) => rectification.id),
    rejectedAttempts,
  };
}

export async function generatePlannedExercise(
  supabase: SupabaseClient,
  learnerId: string,
  target: WeakConceptTarget,
  difficultyLevel: ExerciseDifficultyLevel,
  kind: 'adaptive' | 'explain',
  recentStrengthDescriptions: string[],
  batchPlan: { strengths: ConceptTag[]; weaknesses: ConceptTag[] } | null,
  licenseMode: LicenseMode,
  exerciseOrdinal: number,
  documentsMode: boolean,
): Promise<PlannedExerciseOutcome> {
  // Nothing has been written while the batch is being built, so a failure
  // here (the model's provider refusing the request, three plans the books
  // reject) can safely hand the month to the legacy generator instead of
  // leaving the learner with a scored submission and no next batch
  // (pre-launch review, 2026-09-22). Failures AFTER this point are not
  // caught: the exercise row may exist, and the step's own retry guard
  // handles that.
  let built: PlannedBatch | 'unsupported';
  try {
    built = await buildPlannedBatch(supabase, learnerId, target, difficultyLevel, recentStrengthDescriptions, batchPlan, licenseMode, exerciseOrdinal, documentsMode);
  } catch (error) {
    console.error(`[planned-generator] learner ${learnerId}: could not build a batch, falling back to the legacy generator: ${error instanceof Error ? error.message : String(error)}`);
    return 'unsupported';
  }
  if (built === 'unsupported') return 'unsupported';
  const finalExercise = built.exercise;
  const documents = await prepareSourceDocuments(supabase, learnerId, finalExercise, built.companyName, built.statementContent, built.codeBuiltDocuments, built.documentLines);

  const { id } = await insertExercise(supabase, learnerId, kind, finalExercise);
  await markRectificationsCarried(supabase, built.rectificationIds, id);
  await attachSourceDocuments(supabase, id, documents);

  const newLedgers = finalExercise.answer_key.entries.map((entry) => ({ ledgerName: entry.correct_account, ledgerType: entry.voucher_type }));
  await registerCompanyLedgers(supabase, learnerId, id, newLedgers);
  await appendCompanyTransactionLog(supabase, learnerId, id, {
    voucherType: finalExercise.answer_key.entries[0]?.voucher_type ?? null,
    ledgers: newLedgers.map((ledger) => ledger.ledgerName),
    transactionCount: finalExercise.transactions.length,
    difficultyLevel: finalExercise.difficulty_level,
  });
  return { id };
}

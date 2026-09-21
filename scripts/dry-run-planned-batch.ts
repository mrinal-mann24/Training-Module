// Dry run of the planned generator for one learner: reads their real books,
// asks the real model for next month's plan, builds and checks the batch the
// way production does (lib/tutor/generate-planned-exercise.ts
// buildPlannedBatch), builds every document's content, and prints a review
// report. WRITES NOTHING: no exercise row, no PDF upload, no registry or log
// rows, no carried rectification consumed. It does call the model (a few
// paid requests) and traces them like any generation.
//
// It simulates the batch that follows the learner's latest exercise, i.e.
// what they will get once the current month is scored.
//
//   npx tsx scripts/dry-run-planned-batch.ts --learner <uuid> [--json out.json]
//
// Reads OPENROUTER/SUPABASE settings from .env.local; never prints secrets.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

function loadEnv(): void {
  const file = path.resolve(process.cwd(), '.env.local');
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

const rupees = (value: number): string => value.toLocaleString('en-IN', { maximumFractionDigits: 2 });

async function main(): Promise<void> {
  loadEnv();
  const learnerId = argValue('--learner');
  const jsonOut = argValue('--json');
  if (!learnerId) throw new Error('Usage: npx tsx scripts/dry-run-planned-batch.ts --learner <uuid> [--json out.json]');

  const { createServiceRoleClient } = await import('@/lib/supabase/service-role');
  const { getConceptAttempts, getConceptMasteryMap } = await import('@/lib/db/queries/mastery');
  const { countExercisesForLearner } = await import('@/lib/db/queries/exercises');
  const { selectWeakConcept } = await import('@/lib/tutor/mastery');
  const { selectBatchConcepts } = await import('@/lib/tutor/select-batch-concepts');
  const { isDocumentsModeUnlocked } = await import('@/lib/tutor/documents-mode');
  const { deriveBaseDifficultyLevel } = await import('@/lib/jobs/advance-learner');
  const { ACTIVE_CONCEPT_TAGS, EXERCISE_DIFFICULTY_LEVELS } = await import('@/lib/schemas/exercise');
  const { buildPlannedBatch } = await import('@/lib/tutor/generate-planned-exercise');
  const { buildVendorInvoiceContent } = await import('@/lib/documents/build-vendor-invoice');
  const { planSourceDocuments } = await import('@/lib/tutor/generate-exercise');
  const { partyIdentityFor } = await import('@/lib/documents/party-directory');
  const { loadAnswerKeys } = await import('@/lib/db/queries/company');
  const { replayKeys, applyKey, openItemsOf, cashPositionOf } = await import('@/lib/tutor/ledger-state');

  const supabase = createServiceRoleClient();

  const { data: profile, error: profileError } = await supabase.from('learner_profile').select('license_mode, generation_engine').eq('id', learnerId).single();
  if (profileError) throw profileError;
  const { data: latest, error: latestError } = await supabase
    .from('exercises')
    .select('id, created_at, scenario')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();
  if (latestError) throw latestError;
  const stored = (latest.scenario as { difficulty_level?: string } | null)?.difficulty_level;
  const previousLevel = EXERCISE_DIFFICULTY_LEVELS.find((level) => level === stored) ?? 'L1';

  const [allAttempts, currentMastery, priorExerciseCount] = await Promise.all([
    getConceptAttempts(supabase, learnerId),
    getConceptMasteryMap(supabase, learnerId),
    countExercisesForLearner(supabase, learnerId),
  ]);
  const target = selectWeakConcept(ACTIVE_CONCEPT_TAGS, allAttempts, currentMastery);
  if (!target) {
    console.log('Every concept is mastered: production would generate nothing.');
    return;
  }
  const level = deriveBaseDifficultyLevel(previousLevel);
  const batchPlan = selectBatchConcepts(target, allAttempts, currentMastery);
  const documentsMode = isDocumentsModeUnlocked(currentMastery.values());
  const licenseMode = (profile.license_mode as 'licensed' | 'educational' | null) ?? 'licensed';

  console.log(`Learner ${learnerId.slice(0, 8)}: engine=${profile.generation_engine}, license=${licenseMode}, latest exercise ${latest.id.slice(0, 8)} (${previousLevel})`);
  console.log(`Next batch: ordinal ${priorExerciseCount + 1}, level ${level}, target ${target.conceptTag}${target.escalationActive ? ' (ESCALATION)' : ''}, documents mode ${documentsMode}`);
  console.log(`Plan: strengths [${batchPlan.strengths.join(', ')}], weaknesses [${batchPlan.weaknesses.join(', ')}]`);

  const started = Date.now();
  const built = await buildPlannedBatch(
    supabase,
    learnerId,
    target,
    level,
    batchPlan.strengths.map((tag) => tag.replace(/_/g, ' ')),
    batchPlan,
    licenseMode,
    priorExerciseCount + 1,
    documentsMode,
  );
  if (built === 'unsupported') {
    console.log('UNSUPPORTED: production would fall back to the legacy generator for this batch.');
    return;
  }
  console.log(`\nBuilt in ${Math.round((Date.now() - started) / 1000)}s after ${built.rejectedAttempts.length} rejected attempt(s).`);
  built.rejectedAttempts.forEach((violations, index) => {
    console.log(`  Attempt ${index + 1} was rejected for:`);
    for (const violation of violations) console.log(`    - ${violation}`);
  });

  const exercise = built.exercise;
  console.log(`\nSCENARIO: ${exercise.scenario}`);
  console.log(`\n${exercise.transactions.length} transactions, ${exercise.answer_key.entries.length} legs:`);
  for (const transaction of exercise.transactions) {
    console.log(`\n[${transaction.sequence}] ${transaction.description}`);
    for (const leg of exercise.answer_key.entries.filter((entry) => entry.sequence === transaction.sequence)) {
      const extras = [
        leg.bill_reference ? `ref=${leg.bill_reference}` : null,
        leg.gst_head ? `${leg.gst_head}@${leg.gst_rate ?? '-'}` : null,
        leg.tds_section ? `TDS ${leg.tds_section} ${leg.tds_rate}% on ${leg.tds_base}` : null,
        leg.source_document_type ? `doc=${leg.source_document_type}` : null,
      ].filter(Boolean);
      console.log(`     ${leg.dr_cr} ${rupees(leg.amount).padStart(12)}  ${leg.correct_account}  [${leg.voucher_type}] ${extras.join(' ')}`);
    }
    const tags = exercise.answer_key.entries.find((entry) => entry.sequence === transaction.sequence)?.concept_tags ?? [];
    console.log(`     tags: ${tags.join(', ')}`);
  }

  // Every vendor invoice exactly as production would print it, against the
  // vendor's one identity.
  console.log('\nVENDOR INVOICES:');
  for (const invoice of planSourceDocuments(exercise).invoices) {
    const content = buildVendorInvoiceContent(invoice.legs, invoice.transactionDescription, built.companyName, { lines: built.documentLines.get(invoice.legs[0].sequence) });
    const identity = partyIdentityFor(content.vendorName);
    const heads = [content.taxBreakup.cgst_amount ? 'CGST+SGST' : null, content.taxBreakup.igst_amount ? 'IGST' : null].filter(Boolean).join('/') || 'no GST';
    const stateAgrees = heads === 'no GST' || (heads === 'IGST') === (identity.stateCode !== '29');
    console.log(`  ${content.invoiceNumber} ${content.vendorName} GSTIN ${content.vendorGSTIN} (${identity.state}) ${heads} total ${rupees(content.totalAmount)} RCM=${content.reverseCharge} lines=${content.lineItems.length} ${stateAgrees ? 'OK' : '!! STATE AND GST HEAD DISAGREE'}`);
  }
  console.log(`\nCODE-BUILT DOCUMENTS: ${built.codeBuiltDocuments?.map((item) => item.document.doc_type).join(', ') || 'none'}; bank statement lines: ${built.statementContent?.transactions.length ?? 0}`);

  const priorKeys = await loadAnswerKeys(supabase, learnerId);
  const state = replayKeys(priorKeys);
  const before = cashPositionOf(state);
  applyKey(state, exercise.answer_key);
  const after = cashPositionOf(state);
  console.log(`\nPOSITION: cash ${rupees(before.cash)} -> ${rupees(after.cash)}, bank ${rupees(before.bank)} -> ${rupees(after.bank)}`);
  console.log(`OPEN ITEMS AFTER: ${openItemsOf(state).length}; carried rectifications in this batch: ${built.rectificationIds.length}`);

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify({ exercise, rejectedAttempts: built.rejectedAttempts, statement: built.statementContent }, null, 2));
    console.log(`\nWrote ${jsonOut}`);
  }
  console.log('\nNothing was saved.');
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});

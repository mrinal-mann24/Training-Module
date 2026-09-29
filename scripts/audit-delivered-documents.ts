// Read-only audit of every document a learner has been given, across ALL
// their months: one GST number and one address per party, no number printed
// twice, every invoice adds up, every document agrees with its answer key,
// each bank statement opens where the last one closed, the company's own
// details never change. Writes nothing to the database or to storage.
//
//   npx tsx scripts/audit-delivered-documents.ts --learners <uuid>,<uuid>
//   npx tsx scripts/audit-delivered-documents.ts --learners <uuid> --with-next-month
//   npx tsx scripts/audit-delivered-documents.ts --learners <uuid> --json out.json
//
// --with-next-month also builds the learner's NEXT month with the real
// generator and the real model (a few paid requests), saves nothing, and
// audits its documents together with the delivered ones. That is the check
// that the generator in use today prints what the earlier months printed.
//
// Reads OPENROUTER/SUPABASE settings from .env.local; never prints secrets.

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuditDocument, AuditFinding, AuditMonth, AuditResult, MonthSource } from '@/lib/reports/document-audit';
import type { StoredExerciseRow } from './lib/replay-answer-keys';

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

type Entry = NonNullable<StoredExerciseRow['answer_key']>['entries'][number];

const SOURCE_LABEL: Record<MonthSource, string> = {
  pack: 'authored April pack',
  legacy: 'old generator (deleted)',
  planned: 'generator in use today',
  'dry-run': 'next month, built now and not saved',
};

// The next month exactly as production would build it, documents included,
// with nothing written (same steps as scripts/dry-run-planned-batch.ts).
async function buildNextMonth(supabase: SupabaseClient, learnerId: string, ordinal: number): Promise<AuditMonth | null> {
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
  const { partyLegOf } = await import('@/lib/db/queries/company');

  const { data: profile, error: profileError } = await supabase.from('learner_profile').select('license_mode').eq('id', learnerId).single();
  if (profileError) throw profileError;
  const { data: latest, error: latestError } = await supabase
    .from('exercises')
    .select('scenario')
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
  if (!target) return null;
  const batchPlan = selectBatchConcepts(target, allAttempts, currentMastery);
  const built = await buildPlannedBatch(
    supabase,
    learnerId,
    target,
    deriveBaseDifficultyLevel(previousLevel),
    batchPlan.strengths.map((tag) => tag.replace(/_/g, ' ')),
    batchPlan,
    (profile.license_mode as 'licensed' | 'educational' | null) ?? 'licensed',
    priorExerciseCount + 1,
    isDocumentsModeUnlocked(currentMastery.values()),
  );

  const documents: AuditDocument[] = planSourceDocuments(built.exercise).invoices.map((invoice) => ({
    docType: 'vendor_invoice',
    data: buildVendorInvoiceContent(invoice.legs, invoice.transactionDescription, built.companyName, { lines: built.documentLines.get(invoice.legs[0].sequence) }),
  }));
  for (const item of built.codeBuiltDocuments ?? []) documents.push({ docType: item.document.doc_type, data: item.document.content });
  if (built.statementContent) documents.push({ docType: 'bank_statement', data: built.statementContent });

  const bySequence = new Map<number, Entry[]>();
  for (const entry of built.exercise.answer_key.entries) bySequence.set(entry.sequence, [...(bySequence.get(entry.sequence) ?? []), entry]);
  const partyNames = [...bySequence.values()].map((legs) => partyLegOf(legs, legs[0].voucher_type)?.correct_account).filter((name): name is string => Boolean(name));

  return { ordinal, exerciseId: 'not-saved', label: 'next month', source: 'dry-run', documents, partyNames: [...new Set(partyNames)] };
}

function printResult(learnerId: string, result: AuditResult, months: AuditMonth[]): void {
  console.log(`\n=== Learner ${learnerId.slice(0, 8)}: ${months.length} months, ${result.documentsChecked} documents checked ===`);
  for (const source of ['pack', 'legacy', 'planned', 'dry-run'] as const) {
    const entry = result.bySource[source];
    if (entry.months === 0) continue;
    console.log(`  ${SOURCE_LABEL[source]}: ${entry.months} month(s), ${entry.documents} document(s), ${entry.findings} difference(s)`);
  }
  if (result.findings.length === 0) {
    console.log('  No differences.');
    return;
  }
  const byMonth = new Map<number, AuditFinding[]>();
  for (const finding of result.findings) byMonth.set(finding.ordinal, [...(byMonth.get(finding.ordinal) ?? []), finding]);
  for (const [ordinal, findings] of [...byMonth.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`\n  Month ${ordinal} (${findings[0].label}, ${SOURCE_LABEL[findings[0].source]})`);
    for (const finding of findings) console.log(`    ${finding.check.padEnd(16)} ${finding.message}`);
  }
  const moved = result.parties.filter((party) => party.gstins.length > 1);
  if (moved.length > 0) {
    console.log('\n  Parties printed with more than one GST number:');
    for (const party of moved) {
      console.log(`    ${party.party} (this party's GSTIN is ${party.directoryGstin})`);
      for (const value of party.gstins) console.log(`      ${value.value}  months ${value.months.join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  loadEnv();
  const learners = (argValue('--learners') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  if (learners.length === 0) throw new Error('Usage: npx tsx scripts/audit-delivered-documents.ts --learners <uuid>,<uuid> [--with-next-month] [--json out.json]');
  const withNextMonth = process.argv.includes('--with-next-month');
  const jsonOut = argValue('--json');

  const { createServiceRoleClient } = await import('@/lib/supabase/service-role');
  const { getCompanyName, partyLegOf } = await import('@/lib/db/queries/company');
  const { auditDeliveredDocuments } = await import('@/lib/reports/document-audit');
  const { replayLearnerKeys } = await import('./lib/replay-answer-keys');
  const supabase = createServiceRoleClient();
  const output: { learnerId: string; result: AuditResult }[] = [];

  for (const learnerId of learners) {
    const { data, error } = await supabase
      .from('exercises')
      .select('id, created_at, kind, scenario, answer_key')
      .eq('learner_id', learnerId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const rows = ((data ?? []) as StoredExerciseRow[]).filter((row) => row.answer_key !== null);
    const { data: docs, error: docError } = await supabase
      .from('exercise_source_documents')
      .select('exercise_id, doc_type, structured_data')
      .in('exercise_id', rows.map((row) => row.id));
    if (docError) throw docError;
    for (const row of rows) {
      row.documents = (docs ?? []).filter((doc) => doc.exercise_id === row.id).map((doc) => ({ doc_type: doc.doc_type as string, structured_data: doc.structured_data }));
    }

    const company = await getCompanyName(supabase, learnerId);
    const companyName = (typeof company === 'string' ? company : (company as { companyName?: string | null } | null)?.companyName) ?? 'Blossom Retail Pvt Ltd';
    const replay = replayLearnerKeys(learnerId, rows, companyName);
    const replayByExercise = new Map(replay.keys.map((key) => [key.exerciseId, key]));

    const months: AuditMonth[] = rows.map((row, index) => {
      const key = row.answer_key!;
      const bySequence = new Map<number, Entry[]>();
      for (const entry of key.entries) bySequence.set(entry.sequence, [...(bySequence.get(entry.sequence) ?? []), entry]);
      const partyNames = [...bySequence.values()].map((legs) => partyLegOf(legs, legs[0].voucher_type)?.correct_account).filter((name): name is string => Boolean(name));
      const source: MonthSource = row.kind === 'diagnostic' ? 'pack' : key.engine === 'planned' ? 'planned' : 'legacy';
      return {
        ordinal: index + 1,
        exerciseId: row.id,
        label: replayByExercise.get(row.id)?.month.label ?? row.created_at.slice(0, 10),
        source,
        documents: (row.documents ?? []).map((doc) => ({ docType: doc.doc_type, data: doc.structured_data })),
        partyNames: [...new Set(partyNames)],
      };
    });

    if (withNextMonth) {
      console.log(`\nBuilding the next month for ${learnerId.slice(0, 8)} with the real generator (nothing is saved)...`);
      const next = await buildNextMonth(supabase, learnerId, months.length + 1);
      if (next) months.push(next);
      else console.log('  Every topic is mastered: there is no next month to build.');
    }

    const result = auditDeliveredDocuments(months, companyName);
    for (const month of months) {
      for (const message of replayByExercise.get(month.exerciseId)?.documentMismatches ?? []) {
        result.findings.push({ check: 'KEY_VS_DOCUMENT', ordinal: month.ordinal, label: month.label, source: month.source, message });
        result.bySource[month.source].findings += 1;
      }
    }
    printResult(learnerId, result, months);
    output.push({ learnerId, result });
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(output, null, 2));
    console.log(`\nWrote ${jsonOut}`);
  }
  console.log('\nNothing was changed in the database.');
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});

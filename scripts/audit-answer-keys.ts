// Read-only audit of a learner's stored answer keys: every key is re-checked
// with the generator's own checks, in the context the generator would have
// had at the time (rebuilt from the keys before it). Prints one section per
// learner; writes nothing to the database.
//
//   npx tsx scripts/audit-answer-keys.ts --learners <id>,<id>,...
//   npx tsx scripts/audit-answer-keys.ts --learners <id> --json out.json
//   npx tsx scripts/audit-answer-keys.ts --learners <id> --dump <dir>   (raw rows, for local fixtures)
//
// Reads SUPABASE_SERVICE_ROLE_KEY / NEXT_PUBLIC_SUPABASE_URL from .env.local;
// never prints secrets.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { replayLearnerKeys, type ReplayReport, type StoredExerciseRow } from './lib/replay-answer-keys';

function loadEnv(): void {
  const file = path.resolve(process.cwd(), '.env.local');
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^"|"$/g, '');
    }
  }
}

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? '');
}

const rupees = (value: number): string => Math.round(value).toLocaleString('en-IN');

function printReport(report: ReplayReport): void {
  console.log(`\n=== Learner ${report.learnerId.slice(0, 8)}: ${report.keys.length} keys ===`);
  if (report.createdAtTies.length > 0) {
    console.log(`!! created_at TIES (timeline order is arbitrary, resolve before any write): ${JSON.stringify(report.createdAtTies)}`);
  }
  console.log('ordinal  exercise  created_at           kind        month           scenario says');
  for (const key of report.keys) {
    const mismatch = key.scenarioMonth && key.scenarioMonth !== key.month.label ? '  <-- MISMATCH' : '';
    console.log(
      `${String(key.ordinal).padStart(7)}  ${key.exerciseId.slice(0, 8)}  ${key.createdAt.slice(0, 19)}  ${key.kind.padEnd(10)}  ${key.month.label.padEnd(15)} ${key.scenarioMonth ?? '-'}${mismatch}`,
    );
  }
  for (const key of report.keys) {
    if (key.hard.length === 0 && key.soft.length === 0 && key.openingDrift.length === 0 && key.documentMismatches.length === 0 && key.overdrawnLedgers.length === 0) continue;
    console.log(`\n--- ordinal ${key.ordinal} (${key.month.label}, ${key.exerciseId.slice(0, 8)}) cash before ${rupees(key.cashBefore.cash)}, bank ${rupees(key.cashBefore.bank)}`);
    for (const message of key.hard) console.log(`  HARD  ${message}`);
    for (const message of key.soft) console.log(`  soft  ${message}`);
    for (const message of key.documentMismatches) console.log(`  DOC   ${message}`);
    for (const message of key.overdrawnLedgers) console.log(`  DRAIN ${message}`);
    for (const drift of key.openingDrift) {
      console.log(`  OPENING DRIFT  ${drift.account}: stored ${rupees(drift.stored)}, replay says ${rupees(drift.recomputed)}`);
    }
  }
  if (report.singleKeyLedgers.length > 0) {
    console.log('\nLedgers used in exactly one key:');
    for (const item of report.singleKeyLedgers) console.log(`  ${item.account}  (${item.exerciseId.slice(0, 8)})`);
  }
  console.log('\nOpen bills at the end of the chain:');
  for (const bill of report.openBillsAtEnd) console.log(`  ${bill.party}: ${bill.ref} ${rupees(bill.open)} (${bill.side})`);
  console.log('Open advances at the end of the chain:');
  for (const advance of report.openAdvancesAtEnd) console.log(`  ${advance.party}: ${advance.ref} ${rupees(advance.open)} (${advance.side})`);
  const totals = report.closingBalances.reduce(
    (sum, opening) => ({ dr: sum.dr + (opening.dr_cr === 'Dr' ? opening.amount : 0), cr: sum.cr + (opening.dr_cr === 'Cr' ? opening.amount : 0) }),
    { dr: 0, cr: 0 },
  );
  console.log(`Closing position (tax ledgers excluded by design): Dr ${rupees(totals.dr)}, Cr ${rupees(totals.cr)}`);
}

async function main(): Promise<void> {
  loadEnv();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing in .env.local');
  const learners = (arg('learners') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (learners.length === 0) throw new Error('Pass --learners <uuid>,<uuid>');
  const jsonOut = arg('json');
  const dumpDir = arg('dump');

  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const reports: ReplayReport[] = [];

  for (const learnerId of learners) {
    const { data, error } = await supabase
      .from('exercises')
      .select('id, created_at, kind, scenario, answer_key')
      .eq('learner_id', learnerId)
      .order('created_at', { ascending: true });
    if (error) throw error;
    const rows = (data ?? []) as StoredExerciseRow[];
    const { data: docs, error: docError } = await supabase
      .from('exercise_source_documents')
      .select('exercise_id, doc_type, structured_data')
      .in('exercise_id', rows.map((row) => row.id));
    if (docError) throw docError;
    for (const row of rows) {
      row.documents = (docs ?? [])
        .filter((doc) => doc.exercise_id === row.id)
        .map((doc) => ({ doc_type: doc.doc_type as string, structured_data: doc.structured_data }));
    }
    if (dumpDir) {
      mkdirSync(dumpDir, { recursive: true });
      writeFileSync(path.join(dumpDir, `${learnerId}.json`), JSON.stringify(rows, null, 2));
    }
    const report = replayLearnerKeys(learnerId, rows);
    reports.push(report);
    printReport(report);
  }

  if (jsonOut) {
    writeFileSync(jsonOut, JSON.stringify(reports, null, 2));
    console.log(`\nWrote ${jsonOut}`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

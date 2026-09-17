// Brings the live Variant A pack answer key's concept tags and GST heads in
// line with seed/blossom-variant-a/answer_key.json (2026-09-17 accuracy
// audit, round 2): #2 loses journal_voucher_basics, #44 and #58 lose
// tds_classification (no TDS on either voucher), and the #99 set-off legs get
// the gst_head their ledger names. Amounts, accounts, references and
// narrations are never touched.
//
// WRITES TO PRODUCTION STORAGE AND DATABASE with --confirm. Without it, a
// read-only dry run prints the plan.
//   node scripts/fix-pack-answer-key-tags.mjs            (dry run)
//   node scripts/fix-pack-answer-key-tags.mjs --confirm
//
// Order with --confirm, stopping at the first failure:
//   1. refuse if the exercise_packs row's columns or answer-key shape changed,
//      or if any entry differs from the seed in anything that identifies it
//      (sequence, account, side, amount, voucher type, references, TDS/GST
//      rate fields): the row is then not the key this fix was written for;
//   2. back up the row to packs/backup-tags/exercise_packs-<variant>.json
//      (never overwrites a different backup; verified by stored MD5);
//   3. update answer_key with only concept_tags and gst_head changed, guarded
//      on the row not having changed since it was read, then re-read and
//      compare with the seed.
// Idempotent: a row whose tags and heads already equal the seed is reported
// and skipped.
//
// Learner exercises copy the key at assignment and are deliberately left as
// they are (invariant 6: an answer key is immutable once an exercise uses it).
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VARIANT = 'A';
const BACKUP_ROOT = 'backup-tags';
const PACK_COLUMNS = ['answer_key', 'company_name', 'created_at', 'day1_message', 'expected_voucher_count', 'id', 'pack_files', 'variant'];
const ENTRY_KEYS = [
  'account_aliases', 'amount', 'bill_reference', 'concept_tags', 'correct_account', 'dr_cr', 'gst_head', 'gst_rate',
  'narration', 'requires_source_document', 'sequence', 'source_document_type', 'tds_base', 'tds_rate', 'tds_section',
  'voucher_type',
];
// Fields that identify an entry; any difference means the row is not the key
// this fix was written for. Narrations are left out on purpose: the live row
// may still carry the pre-2024 bank references (scripts/apply-pack-year-shift.mjs).
const IDENTITY_FIELDS = [
  'sequence', 'correct_account', 'dr_cr', 'amount', 'voucher_type', 'bill_reference', 'gst_rate', 'tds_section', 'tds_rate',
  'tds_base', 'requires_source_document', 'source_document_type',
];
const FIXED_FIELDS = ['concept_tags', 'gst_head'];

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// The fields this fix changes, as [path, before, after], and the updated key.
export function planTagFix(row, seed) {
  const columns = Object.keys(row).sort();
  if (!same(columns, PACK_COLUMNS)) throw new Error(`exercise_packs columns changed: ${columns.join(', ')}`);
  const key = row.answer_key;
  if (!key || !same(Object.keys(key).sort(), ['entries', 'opening_balances'])) {
    throw new Error('answer_key is not {entries, opening_balances}');
  }
  const entries = key.entries;
  if (!Array.isArray(entries) || entries.length !== seed.entries.length) {
    throw new Error(`answer_key has ${entries?.length} entries, the seed ${seed.entries.length}`);
  }
  if (!same(key.opening_balances, seed.opening_balances)) throw new Error('opening_balances differ from the seed');
  if (new Set(entries.map((entry) => entry.sequence)).size !== row.expected_voucher_count) {
    throw new Error('expected_voucher_count no longer matches the key');
  }

  const changes = [];
  const newEntries = entries.map((entry, index) => {
    if (!same(Object.keys(entry).sort(), ENTRY_KEYS)) {
      throw new Error(`answer_key.entries[${index}] keys changed: ${Object.keys(entry).sort().join(', ')}`);
    }
    const target = seed.entries[index];
    for (const field of IDENTITY_FIELDS) {
      if (!same(entry[field], target[field])) {
        throw new Error(`answer_key.entries[${index}].${field} is ${JSON.stringify(entry[field])}, the seed says ${JSON.stringify(target[field])}; refusing`);
      }
    }
    let next = entry;
    for (const field of FIXED_FIELDS) {
      if (same(entry[field], target[field])) continue;
      changes.push([`answer_key.entries[${index}] (seq ${entry.sequence} ${entry.correct_account}).${field}`, entry[field], target[field]]);
      next = { ...next, [field]: target[field] };
    }
    return next;
  });
  return { changes, answerKey: { ...key, entries: newEntries } };
}

async function downloadOrNull(supabase, objectPath) {
  const { data, error } = await supabase.storage.from('packs').download(objectPath);
  if (error) {
    const status = error.statusCode ?? error.status ?? error.originalError?.status;
    if (status === 404 || status === '404' || /not.?found|does not exist/i.test(error.message ?? '')) return null;
    throw new Error(`download ${objectPath}: ${error.message}`);
  }
  return Buffer.from(await data.arrayBuffer());
}

// Stored MD5 from Storage metadata (a CDN-served download can be stale, see
// apply-pack-year-shift.mjs).
async function remoteMd5(supabase, objectPath) {
  const folder = path.posix.dirname(objectPath);
  const name = path.posix.basename(objectPath);
  const { data, error } = await supabase.storage.from('packs').list(folder, { search: name });
  if (error) throw new Error(`list ${folder}: ${error.message}`);
  const entry = (data ?? []).find((item) => item.name === name);
  const etag = entry?.metadata?.eTag;
  return typeof etag === 'string' ? etag.replace(/"/g, '').toLowerCase() : null;
}

async function uploadVerified(supabase, objectPath, body, contentType) {
  const { error } = await supabase.storage.from('packs').upload(objectPath, body, { contentType, upsert: false, cacheControl: '60' });
  if (error) throw new Error(`upload ${objectPath}: ${error.message}`);
  const stored = await remoteMd5(supabase, objectPath);
  const expected = createHash('md5').update(body).digest('hex');
  if (stored !== expected) throw new Error(`verify ${objectPath}: stored MD5 ${stored} is not ${expected}`);
}

async function readRow(supabase) {
  const { data, error } = await supabase.from('exercise_packs').select('*').eq('variant', VARIANT);
  if (error) throw error;
  if (!data || data.length !== 1) throw new Error(`expected one exercise_packs row for variant ${VARIANT}, found ${data?.length ?? 0}`);
  return data[0];
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf-8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  const confirmed = process.argv.slice(2).includes('--confirm');
  const seed = JSON.parse(readFileSync(path.join(root, 'seed', 'blossom-variant-a', 'answer_key.json'), 'utf-8'));

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const row = await readRow(supabase);
  const { changes, answerKey } = planTagFix(row, seed);
  console.log(`exercise_packs variant ${row.variant} (${row.id}): ${changes.length} field change(s)`);
  for (const [field, before, after] of changes) {
    console.log(`  ${field}\n    - ${JSON.stringify(before)}\n    + ${JSON.stringify(after)}`);
  }
  if (changes.length === 0) {
    console.log('Tags and GST heads already match the seed (skip).');
    return;
  }
  if (!confirmed) {
    console.log('\nDry run: nothing written. Re-run with --confirm to apply.');
    return;
  }

  // Backup first.
  const backupPath = `${BACKUP_ROOT}/exercise_packs-${row.variant}.json`;
  const backupBody = Buffer.from(JSON.stringify(row, null, 2));
  const existing = await downloadOrNull(supabase, backupPath);
  if (existing && !same(JSON.parse(existing.toString('utf8')), row)) {
    throw new Error(`packs/${backupPath} exists with a different row; refusing to overwrite it`);
  }
  if (!existing) {
    await uploadVerified(supabase, backupPath, backupBody, 'application/json');
    console.log(`backed up the row to packs/${backupPath}`);
  }

  // Concurrency guard: the row must be exactly what was planned from.
  const current = await readRow(supabase);
  if (!same(current, row)) throw new Error('exercise_packs row changed while this script ran; nothing updated, re-run to see the new plan');
  const { data: updated, error } = await supabase
    .from('exercise_packs')
    .update({ answer_key: answerKey })
    .eq('id', row.id)
    .eq('day1_message', row.day1_message)
    .eq('expected_voucher_count', row.expected_voucher_count)
    .select('id');
  if (error) throw error;
  if (!updated || updated.length !== 1) throw new Error(`exercise_packs ${row.id} changed while this script ran; nothing updated`);

  const after = await readRow(supabase);
  const { changes: left } = planTagFix(after, seed);
  if (left.length > 0) throw new Error(`update did not take: ${left.length} field(s) still differ from the seed`);
  console.log(`updated exercise_packs variant ${row.variant} (${changes.length} change(s)); row backup packs/${backupPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

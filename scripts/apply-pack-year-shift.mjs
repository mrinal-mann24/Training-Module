// Moves the live Variant A diagnostic pack from the 2026 timeline to 2024:
// Storage objects packs/variant-a/* and packs/variant-a-edu/*, and the
// exercise_packs row (day1_message dates, answer-key narration bank refs).
//
// 2026-09-16: the simulated timeline moved to April 2024 on 2026-09-09
// (lib/tutor/timeline.ts; AI Accountant refuses future-dated vouchers), but
// the pack files still said April 2026 and the Day-1 message still told
// learners "Books Begin Date as 1-Apr-2026" while their profile says
// 2024-04-01. The shifted files are built and verified offline first:
//   python scripts/shift-pack-year.py <originals> <pack-2024>
//   python scripts/build-educational-pack.py <pack-2024> <pack-2024-edu>
//
// WRITES TO PRODUCTION STORAGE AND DATABASE with --confirm. Without it, a
// read-only dry run prints the plan and the database diff.
//   node scripts/apply-pack-year-shift.mjs "<pack-2024>" "<pack-2024-edu>"            (dry run)
//   node scripts/apply-pack-year-shift.mjs "<pack-2024>" "<pack-2024-edu>" --confirm
//
// Order with --confirm, stopping at the first failure:
//   1. refuse if a local file still carries a 2026 date token;
//   2. back up every live object that will be replaced to
//      packs/backup-2026/<folder>/<name> (never overwrites a different
//      backup; re-downloads each backup and compares sha256);
//   3. upload the replacements (upsert) and re-download to compare sha256;
//   4. back up the exercise_packs row to packs/backup-2026/exercise_packs-<variant>.json,
//      then update day1_message + answer_key narrations, guarded on the row
//      not having changed since it was read.
// Idempotent: a file whose live sha256 already equals the local file and a
// row with no 2026 token left are reported and skipped.
//
// Existing learner exercises copy the day1 message and key at assignment;
// they are handled separately by scripts/shift-existing-pack-exercises.sql.
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const FILE_NAMES = ['1-opening-tb.xlsx', '2-sales-register.xlsx', '3-purchase-register.xlsx', '4-bank-statement.xlsx'];
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const BACKUP_ROOT = 'backup-2026';
const PACK_COLUMNS = ['answer_key', 'company_name', 'created_at', 'day1_message', 'expected_voucher_count', 'id', 'pack_files', 'variant'];
const ENTRY_KEYS = [
  'account_aliases', 'amount', 'bill_reference', 'concept_tags', 'correct_account', 'dr_cr', 'gst_head', 'gst_rate',
  'narration', 'requires_source_document', 'sequence', 'source_document_type', 'tds_base', 'tds_rate', 'tds_section',
  'voucher_type',
];

const FROM_YEAR = 2026;
const TO_YEAR = 2024;
const MON3 = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const MONTH_FULL = 'January|February|March|April|May|June|July|August|September|October|November|December';

function validDate(year, month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Same rules as scripts/shift-pack-year.py (text side). Only tokens naming
// 2026 / yy 26 change, so a second pass is a no-op. Bill numbers such as
// CA26-101 or KM/2026/045 are not date tokens and stay.
const RULES = [
  [new RegExp(`\\b(\\d{1,2}-(?:${MON3})-)${FROM_YEAR}\\b`, 'gi'), (_m, head) => `${head}${TO_YEAR}`],
  [new RegExp(`\\b(\\d{1,2}-(?:${MONTH_FULL})-)${FROM_YEAR}\\b`, 'gi'), (_m, head) => `${head}${TO_YEAR}`],
  [new RegExp(`\\b((?:${MONTH_FULL}|${MON3})\\.?\\s+)${FROM_YEAR}\\b`, 'gi'), (_m, head) => `${head}${TO_YEAR}`],
  [new RegExp(`\\b(\\d{1,2}-(?:${MON3})-)${FROM_YEAR % 100}\\b(?!-)`, 'gi'), (_m, head) => `${head}${TO_YEAR % 100}`],
  [
    new RegExp(`(?<=/)(N|CD|CW)?${FROM_YEAR % 100}(\\d{2})(\\d{2})(\\d{2})(?=/)`, 'g'),
    (whole, prefix = '', mm, dd, line) =>
      validDate(FROM_YEAR, Number(mm), Number(dd)) && validDate(TO_YEAR, Number(mm), Number(dd))
        ? `${prefix ?? ''}${TO_YEAR % 100}${mm}${dd}${line}`
        : whole,
  ],
  [
    /\b(20\d{2})-(\d{2})\b/g,
    (whole, start, end) => {
      const first = Number(start);
      if ((first + 1) % 100 !== Number(end) || (first !== FROM_YEAR && first + 1 !== FROM_YEAR)) return whole;
      const shifted = first + TO_YEAR - FROM_YEAR;
      return `${shifted}-${String((shifted + 1) % 100).padStart(2, '0')}`;
    },
  ],
];

export function shiftText(text) {
  if (typeof text !== 'string') return text;
  return RULES.reduce((current, [pattern, replace]) => current.replace(pattern, replace), text);
}

const LEFTOVER = new RegExp(
  `${FROM_YEAR}|\\b\\d{1,2}-[A-Za-z]{3,9}-${FROM_YEAR % 100}\\b(?!-)|/(?:N|CD|CW)?${FROM_YEAR % 100}\\d{6}/`,
);

// Cell text of an xlsx (shared strings + inline sheet strings). docProps is
// skipped on purpose: its created/modified timestamps say 2026 legitimately.
export function xlsxCellXml(buffer) {
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error('not a zip file');
  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const parts = [];
  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;
    if (name !== 'xl/sharedStrings.xml' && !/^xl\/worksheets\/[^/]+\.xml$/.test(name)) continue;
    const dataStart = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    parts.push((method === 8 ? inflateRawSync(data) : data).toString('utf8'));
  }
  return parts.join('\n');
}

export function hasYearToken(buffer) {
  return LEFTOVER.test(xlsxCellXml(buffer));
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

// Every text change the shift makes to the pack row, as [field, before, after].
export function planPackRow(row) {
  const columns = Object.keys(row).sort();
  if (JSON.stringify(columns) !== JSON.stringify(PACK_COLUMNS)) {
    throw new Error(`exercise_packs columns changed: ${columns.join(', ')}`);
  }
  const key = row.answer_key;
  if (!key || JSON.stringify(Object.keys(key).sort()) !== JSON.stringify(['entries', 'opening_balances'])) {
    throw new Error('answer_key is not {entries, opening_balances}');
  }
  const entries = key.entries;
  if (!Array.isArray(entries) || entries.length === 0) throw new Error('answer_key.entries is empty');
  for (const [index, entry] of entries.entries()) {
    if (JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(ENTRY_KEYS)) {
      throw new Error(`answer_key.entries[${index}] keys changed: ${Object.keys(entry).sort().join(', ')}`);
    }
  }
  if (new Set(entries.map((entry) => entry.sequence)).size !== row.expected_voucher_count) {
    throw new Error('expected_voucher_count no longer matches the key');
  }

  const changes = [];
  const day1 = shiftText(row.day1_message);
  if (day1 !== row.day1_message) changes.push(['day1_message', row.day1_message, day1]);
  const company = shiftText(row.company_name);
  if (company !== row.company_name) changes.push(['company_name', row.company_name, company]);
  const newEntries = entries.map((entry, index) => {
    const narration = shiftText(entry.narration);
    if (narration === entry.narration) return entry;
    changes.push([`answer_key.entries[${index}].narration`, entry.narration, narration]);
    return { ...entry, narration };
  });
  const update = {};
  if (day1 !== row.day1_message) update.day1_message = day1;
  if (company !== row.company_name) update.company_name = company;
  if (newEntries.some((entry, index) => entry !== entries[index])) {
    update.answer_key = { ...key, entries: newEntries };
  }
  // Anything year-like the rules did not cover must be looked at by a person.
  const after = JSON.stringify({ ...row, ...update, created_at: null, id: null });
  const leftovers = after.match(new RegExp(`[^"]{0,30}${FROM_YEAR}[^"]{0,10}`, 'g')) ?? [];
  return { changes, update, leftovers };
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

// The stored object's MD5, read from Storage metadata rather than a download.
// Downloads go through the Storage CDN, which kept serving the previous
// version for the object's cache lifetime after an upsert (first live run,
// 2026-09-16), so a re-download could not prove what was stored.
async function remoteMd5(supabase, objectPath) {
  const folder = path.posix.dirname(objectPath);
  const name = path.posix.basename(objectPath);
  const { data, error } = await supabase.storage.from('packs').list(folder, { search: name });
  if (error) throw new Error(`list ${folder}: ${error.message}`);
  const entry = (data ?? []).find((item) => item.name === name);
  const etag = entry?.metadata?.eTag;
  return typeof etag === 'string' ? etag.replace(/"/g, '').toLowerCase() : null;
}

async function uploadVerified(supabase, objectPath, body, contentType, upsert) {
  const { error } = await supabase.storage
    .from('packs')
    .upload(objectPath, body, { contentType, upsert, cacheControl: '60' });
  if (error) throw new Error(`upload ${objectPath}: ${error.message}`);
  const stored = await remoteMd5(supabase, objectPath);
  const expected = createHash('md5').update(body).digest('hex');
  if (stored !== expected) throw new Error(`verify ${objectPath}: stored MD5 ${stored} is not ${expected}`);
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf-8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '');
  }
  const args = process.argv.slice(2);
  const [licensedDir, educationalDir] = args.filter((arg) => !arg.startsWith('--'));
  const confirmed = args.includes('--confirm');
  if (!licensedDir || !educationalDir) {
    console.error('Usage: node scripts/apply-pack-year-shift.mjs "<pack-2024>" "<pack-2024-edu>" [--confirm]');
    process.exit(2);
  }

  // 1. Local files: all present, readable as xlsx, no 2026 token.
  const targets = [];
  for (const [folder, dir] of [['variant-a', licensedDir], ['variant-a-edu', educationalDir]]) {
    for (const name of FILE_NAMES) {
      const localPath = path.join(dir, name);
      if (!existsSync(localPath)) throw new Error(`missing ${localPath}`);
      const body = readFileSync(localPath);
      if (hasYearToken(body)) throw new Error(`${localPath} still carries a ${FROM_YEAR} date token; rebuild it`);
      targets.push({ folder, name, body, sha: sha256(body) });
    }
  }
  for (const name of FILE_NAMES) {
    const [licensed, educational] = targets.filter((target) => target.name === name);
    if (licensed.sha === educational.sha) throw new Error(`${name}: licensed and educational copies are identical`);
  }

  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // Plan (read-only).
  for (const target of targets) {
    target.objectPath = `${target.folder}/${target.name}`;
    target.backupPath = `${BACKUP_ROOT}/${target.folder}/${target.name}`;
    target.live = await downloadOrNull(supabase, target.objectPath);
    if (!target.live) throw new Error(`live object packs/${target.objectPath} not found`);
    // From metadata, not the (possibly CDN-stale) download.
    target.done = (await remoteMd5(supabase, target.objectPath)) === createHash('md5').update(target.body).digest('hex');
    if (!target.done && !hasYearToken(target.live)) {
      throw new Error(`packs/${target.objectPath} differs from the local file but carries no ${FROM_YEAR} token: someone replaced it; stop and check`);
    }
    target.backup = target.done ? null : await downloadOrNull(supabase, target.backupPath);
    if (target.backup && sha256(target.backup) !== sha256(target.live)) {
      throw new Error(`packs/${target.backupPath} exists with different content than the live object; refusing to continue`);
    }
    console.log(
      `packs/${target.objectPath}: ${target.done ? 'already 2024 (skip)' : `replace ${sha256(target.live).slice(0, 12)} -> ${target.sha.slice(0, 12)}, backup ${target.backup ? 'already present' : `to packs/${target.backupPath}`}`}`,
    );
  }

  const { data: rows, error: readError } = await supabase.from('exercise_packs').select('*');
  if (readError) throw readError;
  const plans = rows.map((row) => ({ row, ...planPackRow(row) }));
  for (const { row, changes, leftovers } of plans) {
    console.log(`\nexercise_packs variant ${row.variant} (${row.id}): ${changes.length} text change(s)`);
    for (const [field, before, after] of changes) {
      console.log(`  ${field}\n    - ${JSON.stringify(before)}\n    + ${JSON.stringify(after)}`);
    }
    if (leftovers.length > 0) {
      console.log(`  ${FROM_YEAR} left after the shift (not a date token; review): ${JSON.stringify(leftovers)}`);
    }
  }

  if (!confirmed) {
    console.log('\nDry run: nothing written. Re-run with --confirm to apply.');
    return;
  }

  // 2. Backups first, all of them, before anything is replaced.
  for (const target of targets.filter((item) => !item.done && !item.backup)) {
    await uploadVerified(supabase, target.backupPath, target.live, CONTENT_TYPE, false);
    console.log(`backed up packs/${target.objectPath} -> packs/${target.backupPath}`);
  }
  // 3. Replace.
  for (const target of targets.filter((item) => !item.done)) {
    await uploadVerified(supabase, target.objectPath, target.body, CONTENT_TYPE, true);
    console.log(`replaced packs/${target.objectPath}`);
  }
  // 4. Database row(s).
  for (const { row, update, changes } of plans) {
    if (changes.length === 0) {
      console.log(`exercise_packs variant ${row.variant}: already 2024 (skip)`);
      continue;
    }
    const backupPath = `${BACKUP_ROOT}/exercise_packs-${row.variant}.json`;
    const backupBody = Buffer.from(JSON.stringify(row, null, 2));
    const existing = await downloadOrNull(supabase, backupPath);
    if (existing && JSON.stringify(JSON.parse(existing.toString('utf8'))) !== JSON.stringify(row)) {
      throw new Error(`packs/${backupPath} exists with a different row; refusing to overwrite it`);
    }
    if (!existing) await uploadVerified(supabase, backupPath, backupBody, 'application/json', false);
    const { data: updated, error } = await supabase
      .from('exercise_packs')
      .update(update)
      .eq('id', row.id)
      .eq('day1_message', row.day1_message)
      .eq('expected_voucher_count', row.expected_voucher_count)
      .select('id');
    if (error) throw error;
    if (!updated || updated.length !== 1) {
      throw new Error(`exercise_packs ${row.id} changed while this script ran; nothing updated, re-run to see the new diff`);
    }
    console.log(`updated exercise_packs variant ${row.variant} (${changes.length} change(s)); row backup packs/${backupPath}`);
  }
  console.log('\nDone. Next: scripts/shift-existing-pack-exercises.sql for unscored learner copies.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

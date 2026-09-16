// Uploads the Educational Mode copy of the Variant A diagnostic pack to the
// shared 'packs' Storage bucket under variant-a-edu/, same file names and
// content type as variant-a/.
//
// 2026-09-16: TallyPrime Educational Mode only saves vouchers dated the 1st,
// 2nd or 31st (1st/2nd in months without a 31st). The re-dated copies are
// built and verified by scripts/build-educational-pack.py. Once these objects
// exist, assignPackDiagnostic (lib/tutor/assign-pack-exercise.ts) serves them
// to learners with license_mode 'educational'; until then it keeps serving
// variant-a/. Nothing in the DB changes: exercise_packs.pack_files still
// lists variant-a/ paths and the answer key is shared.
//
// WRITES TO PRODUCTION STORAGE. Run only after the user has confirmed.
//   python scripts/build-educational-pack.py <originals> <educational>
//   node scripts/upload-educational-pack.mjs "<educational folder>" --confirm
// Add --replace to overwrite objects that already exist (default refuses).
import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Minimal .env.local loader, same as scripts/seed-pack.mjs.
for (const line of readFileSync(path.join(root, '.env.local'), 'utf-8').split(/\r?\n/)) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, '');
}

const args = process.argv.slice(2);
const sourceDir = args.find((arg) => !arg.startsWith('--'));
const confirmed = args.includes('--confirm');
const replace = args.includes('--replace');

const FOLDER = 'variant-a-edu';
const FILE_NAMES = ['1-opening-tb.xlsx', '2-sales-register.xlsx', '3-purchase-register.xlsx', '4-bank-statement.xlsx'];
const CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

if (!sourceDir) {
  console.error('Usage: node scripts/upload-educational-pack.mjs "<educational folder>" --confirm [--replace]');
  process.exit(2);
}
const missing = FILE_NAMES.filter((name) => !existsSync(path.join(sourceDir, name)));
if (missing.length > 0) {
  console.error(`Missing in ${sourceDir}: ${missing.join(', ')}`);
  process.exit(2);
}
if (!confirmed) {
  console.log('Dry run (no --confirm). Would upload:');
  for (const name of FILE_NAMES) console.log(`  ${path.join(sourceDir, name)} -> packs/${FOLDER}/${name}`);
  process.exit(0);
}

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

for (const name of FILE_NAMES) {
  const storagePath = `${FOLDER}/${name}`;
  const { error } = await supabase.storage
    .from('packs')
    .upload(storagePath, readFileSync(path.join(sourceDir, name)), { contentType: CONTENT_TYPE, upsert: replace });
  if (error) throw new Error(`Upload failed for ${storagePath}: ${error.message}`);
  console.log(`uploaded packs/${storagePath}`);
}

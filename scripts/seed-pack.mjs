// Seeds the Blossom Retail Variant A diagnostic pack: uploads the 4 authored
// xlsx files to the shared 'packs' Storage bucket and upserts the
// exercise_packs row (Day-1 message template + reviewed answer key from
// seed/blossom-variant-a/answer_key.json).
//
// Prereqs: 20260819120000_exercise_packs.sql applied; answer key derived via
//   python scripts/derive-blossom-answer-key.py
// Run:
//   node scripts/seed-pack.mjs "<path to BlossomRetail_Variant_A folder>"
import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Minimal .env.local loader — no dotenv dependency in this project.
for (const line of readFileSync(path.join(root, '.env.local'), 'utf-8').split('\n')) {
  const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
  if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
}

const packDir =
  process.argv[2] ??
  'D:\\Mrinal.Manna\\OneDrive - KOREFI BUSINESS SOLUTIONS PRIVATE LIMITED\\Downloads\\BlossomRetail_Variant_A\\BlossomRetail_Variant_A';

const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const FILES = [
  { label: 'Opening TB & Company Master', source: '1. Opening TB.xlsx', storage_path: 'variant-a/1-opening-tb.xlsx' },
  { label: 'Sales Register', source: '2. Sales Register.xlsx', storage_path: 'variant-a/2-sales-register.xlsx' },
  { label: 'Purchase Register', source: '3. Purchase Register.xlsx', storage_path: 'variant-a/3-purchase-register.xlsx' },
  { label: 'Bank Statement', source: '4. Bank Statement.xlsx', storage_path: 'variant-a/4-bank-statement.xlsx' },
];

// The pilot program's Day-1 message (Shruti's, generalized). {{name}} is
// replaced per-learner at assignment time (assign-pack-exercise.ts).
const DAY1_MESSAGE = `Hi {{name}}.

This is a structured training programme designed to get you client-ready.

Day 1 is a diagnostic. Attached are 4 files: Opening TB (with the company master details), Sales Register, Purchase Register, and Bank Statement. Work through them in Tally independently.

Create the company in Tally using the details in the Opening TB file, and consider Books Begin Date as 1-Apr-2026.

Submit when you're done:
- Tally Day Book export (Detailed, XML)
- Trial Balance as on 30-Apr-2026 (XML)

Take the time you need and submit when it's ready. If anything on your side is blocked, ask here and I'll help.

Reference material: the VA Training Modules plus the House Practices Rulebook. If a question comes up while you work, a ledger you're unsure about or a GST or TDS doubt, ask it right here in the chat.

One note: don't use AI tools to do the accounting during training. AI is part of the standard toolkit once you're on live client work, but here the goal is to build your foundation, and solving on your own gives the clearest read on where you need guidance.

Feedback comes once you submit. Your next exercises are based on what you send.`;

const answerKey = JSON.parse(readFileSync(path.join(root, 'seed', 'blossom-variant-a', 'answer_key.json'), 'utf-8'));
const expectedVoucherCount = new Set(answerKey.entries.map((entry) => entry.sequence)).size;

for (const file of FILES) {
  const body = readFileSync(path.join(packDir, file.source));
  const { error } = await supabase.storage.from('packs').upload(file.storage_path, body, {
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    upsert: true,
  });
  if (error) throw new Error(`Upload failed for ${file.source}: ${error.message}`);
  console.log(`uploaded ${file.storage_path}`);
}

const { error } = await supabase.from('exercise_packs').upsert(
  {
    variant: 'A',
    company_name: 'Blossom Retail Pvt Ltd',
    day1_message: DAY1_MESSAGE,
    pack_files: FILES.map(({ label, storage_path }) => ({ label, storage_path })),
    answer_key: answerKey,
    expected_voucher_count: expectedVoucherCount,
  },
  { onConflict: 'variant' },
);
if (error) throw new Error(`exercise_packs upsert failed: ${error.message}`);

console.log(`seeded exercise_packs variant A: ${expectedVoucherCount} vouchers, ${answerKey.entries.length} legs`);

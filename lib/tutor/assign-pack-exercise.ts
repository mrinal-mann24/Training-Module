import type { SupabaseClient } from '@supabase/supabase-js';
import { getAnyPack, getPackByVariant } from '@/lib/db/queries/exercise-packs';
import { insertPackExercise } from '@/lib/db/queries/exercises';
import { registerCompanyLedgers, appendCompanyTransactionLog } from '@/lib/db/queries/company';
import { selectDiagnosticVariant } from '@/lib/tutor/generate-exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';

type PackFile = { label: string; storage_path: string };

// Lists the object names directly inside one folder of the 'packs' bucket.
export type ListPackFolder = (supabase: SupabaseClient, folder: string) => Promise<string[]>;

export type AssignPackDiagnosticDeps = {
  getPackByVariant?: typeof getPackByVariant;
  getAnyPack?: typeof getAnyPack;
  insertPackExercise?: typeof insertPackExercise;
  registerCompanyLedgers?: typeof registerCompanyLedgers;
  appendCompanyTransactionLog?: typeof appendCompanyTransactionLog;
  listPackFolder?: ListPackFolder;
};

async function listPackFolderFromStorage(supabase: SupabaseClient, folder: string): Promise<string[]> {
  const { data, error } = await supabase.storage.from('packs').list(folder, { limit: 1000 });
  if (error) {
    throw error;
  }
  return (data ?? []).map((object) => object.name);
}

// "variant-a/2-sales-register.xlsx" -> "variant-a-edu/2-sales-register.xlsx".
// Null for a path with no folder segment (nothing to swap).
export function educationalStoragePath(storagePath: string): string | null {
  const slash = storagePath.indexOf('/');
  if (slash <= 0) {
    return null;
  }
  return `${storagePath.slice(0, slash)}-edu${storagePath.slice(slash)}`;
}

// 2026-09-16: TallyPrime Educational Mode only saves vouchers dated the 1st,
// 2nd or 31st (only the 1st and 2nd in a month with no 31st). The shared pack
// is dated through April, so 87 of its 99 vouchers could not be posted by an
// educational learner. scripts/build-educational-pack.py writes a re-dated
// copy of each file to "<folder>-edu/" (dates only; amounts, order and the
// answer key are unchanged, and scoring never reads the day of month).
//
// The swap happens only when EVERY educational copy exists in Storage, so
// deploying this before the upload changes nothing, and a half-finished
// upload never serves a mix of dated and re-dated files. A failed listing
// also falls back to the originals: the learner still gets their pack, and
// the walkthrough tells them how to handle a refused date.
export async function resolvePackFilesForLicense(
  supabase: SupabaseClient,
  packFiles: PackFile[],
  licenseMode: LicenseMode | null | undefined,
  listPackFolder: ListPackFolder = listPackFolderFromStorage,
): Promise<PackFile[]> {
  if (licenseMode !== 'educational' || packFiles.length === 0) {
    return packFiles;
  }

  const educationalFiles: PackFile[] = [];
  for (const file of packFiles) {
    const educationalPath = educationalStoragePath(file.storage_path);
    if (educationalPath === null) {
      return packFiles;
    }
    educationalFiles.push({ label: file.label, storage_path: educationalPath });
  }

  const folders = [
    ...new Set(educationalFiles.map((file) => file.storage_path.slice(0, file.storage_path.lastIndexOf('/')))),
  ];
  const existing = new Set<string>();
  try {
    for (const folder of folders) {
      for (const name of await listPackFolder(supabase, folder)) {
        existing.add(`${folder}/${name}`);
      }
    }
  } catch (error) {
    console.warn('Educational pack listing failed; serving the original pack files.', error);
    return packFiles;
  }

  return educationalFiles.every((file) => existing.has(file.storage_path)) ? educationalFiles : packFiles;
}

// Unit 14R: assigns the authored diagnostic pack to a learner — the pilot
// program's "Day 1" message, personalized by name, with the pack's files as
// attachments. No LLM call anywhere in this path: the scenario text is the
// authored template and the answer key is the authored key, copied verbatim.
//
// Returns null when no pack is seeded for the learner's variant — the caller
// (confirmWalkthrough) falls back to the LLM-generated diagnostic so a
// missing seed degrades to the previous behavior instead of a dead end.
export async function assignPackDiagnostic(
  supabase: SupabaseClient,
  learnerId: string,
  learnerName: string | null,
  licenseMode?: LicenseMode | null,
  deps: AssignPackDiagnosticDeps = {},
): Promise<{ id: string } | null> {
  const loadPackByVariant = deps.getPackByVariant ?? getPackByVariant;
  const loadAnyPack = deps.getAnyPack ?? getAnyPack;
  const insertExercise = deps.insertPackExercise ?? insertPackExercise;
  const registerLedgers = deps.registerCompanyLedgers ?? registerCompanyLedgers;
  const appendLog = deps.appendCompanyTransactionLog ?? appendCompanyTransactionLog;

  const variant = selectDiagnosticVariant(learnerId);
  let pack = await loadPackByVariant(supabase, variant);
  if (!pack) {
    // Only one variant may be seeded (Variant B doesn't exist yet) — a
    // learner whose hash lands on the missing variant should still get the
    // authored pack rather than silently falling back to LLM generation.
    // Variant assignment is for answer-reuse prevention across cohorts, not
    // a per-learner guarantee, so serving the other variant is strictly
    // better than serving a generated exercise.
    pack = await loadAnyPack(supabase);
  }
  if (!pack) {
    return null;
  }

  // "Hi Elina." — the pilot personalizes by first name. Fall back to a
  // neutral greeting rather than blocking on a missing name (older accounts
  // onboarded before full_name existed).
  const firstName = learnerName?.trim().split(/\s+/)[0] ?? null;
  const day1Message = pack.day1_message.replaceAll('{{name}}', firstName ?? 'there');

  const packFiles = await resolvePackFilesForLicense(supabase, pack.pack_files, licenseMode, deps.listPackFolder);

  const inserted = await insertExercise(supabase, learnerId, {
    variant: pack.variant,
    day1Message,
    packFiles,
    answerKey: pack.answer_key,
    expectedVoucherCount: pack.expected_voucher_count,
  });

  // Seed the persistent-company registry from the pack's answer key. Without
  // this, the first adaptive batch generator sees an EMPTY company and is
  // told to invent ledgers freely — observed live 2026-08-24 as a Batch 2
  // set in a fictional Maharashtra company with Savings/Current accounts,
  // unrelated to the pack's Blossom Retail (Karnataka). Same registry
  // convention as generateAdaptiveExercise: ledgerType carries the voucher
  // type the account first appeared under.
  const seenNames = new Set<string>();
  const packLedgers: { ledgerName: string; ledgerType: string }[] = [];
  for (const entry of pack.answer_key.entries) {
    if (!seenNames.has(entry.correct_account)) {
      seenNames.add(entry.correct_account);
      packLedgers.push({ ledgerName: entry.correct_account, ledgerType: entry.voucher_type });
    }
  }
  await registerLedgers(supabase, learnerId, inserted.id, packLedgers);
  await appendLog(supabase, learnerId, inserted.id, {
    company: pack.company_name,
    note: 'Diagnostic pack month — the whole opening month of this company, posted from the pack files.',
    voucherType: 'mixed',
    ledgers: packLedgers.map((ledger) => ledger.ledgerName),
    transactionCount: pack.expected_voucher_count,
    difficultyLevel: 'L0',
  });

  return inserted;
}

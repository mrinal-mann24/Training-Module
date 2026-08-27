import type { SupabaseClient } from '@supabase/supabase-js';
import { getAnyPack, getPackByVariant } from '@/lib/db/queries/exercise-packs';
import { insertPackExercise } from '@/lib/db/queries/exercises';
import { registerCompanyLedgers, appendCompanyTransactionLog } from '@/lib/db/queries/company';
import { selectDiagnosticVariant } from '@/lib/tutor/generate-exercise';

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
): Promise<{ id: string } | null> {
  const variant = selectDiagnosticVariant(learnerId);
  let pack = await getPackByVariant(supabase, variant);
  if (!pack) {
    // Only one variant may be seeded (Variant B doesn't exist yet) — a
    // learner whose hash lands on the missing variant should still get the
    // authored pack rather than silently falling back to LLM generation.
    // Variant assignment is for answer-reuse prevention across cohorts, not
    // a per-learner guarantee, so serving the other variant is strictly
    // better than serving a generated exercise.
    pack = await getAnyPack(supabase);
  }
  if (!pack) {
    return null;
  }

  // "Hi Elina." — the pilot personalizes by first name. Fall back to a
  // neutral greeting rather than blocking on a missing name (older accounts
  // onboarded before full_name existed).
  const firstName = learnerName?.trim().split(/\s+/)[0] ?? null;
  const day1Message = pack.day1_message.replaceAll('{{name}}', firstName ?? 'there');

  const inserted = await insertPackExercise(supabase, learnerId, {
    variant: pack.variant,
    day1Message,
    packFiles: pack.pack_files,
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
  await registerCompanyLedgers(supabase, learnerId, inserted.id, packLedgers);
  await appendCompanyTransactionLog(supabase, learnerId, inserted.id, {
    company: pack.company_name,
    note: 'Diagnostic pack month — the whole opening month of this company, posted from the pack files.',
    voucherType: 'mixed',
    ledgers: packLedgers.map((ledger) => ledger.ledgerName),
    transactionCount: pack.expected_voucher_count,
    difficultyLevel: 'L0',
  });

  return inserted;
}

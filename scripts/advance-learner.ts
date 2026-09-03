// Admin: (re)generate a learner's next exercise through the SAME pipeline the
// scoring jobs use (lib/jobs/advance-learner.ts), for a learner left without
// a usable next batch — e.g. Praveen's Level 5 review exercise (2026-09-03),
// or the pre-fix multi-part job that scored without generating anything.
//
//   npx tsx scripts/advance-learner.ts --learner praveen.naidu@karboncard.com
//   npx tsx scripts/advance-learner.ts --learner <email> --replace-latest
//
// --replace-latest deletes the learner's newest exercise first, but ONLY if
// it was created after their latest scored submission and has no
// submissions of its own (i.e. it is the batch this script is about to
// regenerate). Every dependent row cascades (ledger_review_items, source
// documents, registry/log rows). Reads OPENROUTER/SUPABASE settings from
// .env.local; never prints secrets.

import { readFileSync } from 'node:fs';
import path from 'node:path';

function loadEnv(): void {
  const file = path.resolve(process.cwd(), '.env.local');
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^"|"$/g, '');
    }
  }
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function main(): Promise<void> {
  loadEnv();
  const email = argValue('--learner');
  const replaceLatest = process.argv.includes('--replace-latest');
  if (!email) {
    throw new Error('Usage: npx tsx scripts/advance-learner.ts --learner <email> [--replace-latest]');
  }

  const { createServiceRoleClient } = await import('@/lib/supabase/service-role');
  const { generateNextExercise } = await import('@/lib/jobs/advance-learner');
  const supabase = createServiceRoleClient();

  const { data: userPage, error: userError } = await supabase.auth.admin.listUsers({ perPage: 200 });
  if (userError) throw userError;
  const user = userPage.users.find((candidate) => candidate.email?.toLowerCase() === email.toLowerCase());
  if (!user) throw new Error(`No learner with email ${email}`);
  const learnerId = user.id;

  const { data: profile, error: profileError } = await supabase
    .from('learner_profile')
    .select('license_mode')
    .eq('id', learnerId)
    .single();
  if (profileError || !profile) throw profileError ?? new Error('learner_profile missing');

  const { data: submissions, error: submissionError } = await supabase
    .from('submissions')
    .select('id, exercise_id, status, created_at')
    .eq('learner_id', learnerId)
    .eq('status', 'scored')
    .order('created_at', { ascending: false })
    .limit(1);
  if (submissionError) throw submissionError;
  const lastScored = submissions?.[0];
  if (!lastScored) throw new Error('No scored submission — nothing to advance from.');

  const { data: scoredExercise, error: scoredError } = await supabase
    .from('exercises')
    .select('id, kind, scenario, created_at')
    .eq('id', lastScored.exercise_id)
    .single();
  if (scoredError || !scoredExercise) throw scoredError ?? new Error('scored exercise missing');
  // difficulty_level lives inside the scenario JSON, not as a column.
  const scoredScenario = scoredExercise.scenario as { difficulty_level?: string };
  const previousDifficultyLevel = (scoredScenario.difficulty_level ?? 'L1') as Parameters<typeof generateNextExercise>[1]['previousDifficultyLevel'];

  const { data: newest, error: newestError } = await supabase
    .from('exercises')
    .select('id, kind, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: false })
    .limit(1);
  if (newestError) throw newestError;
  const latest = newest?.[0];

  console.log(`learner ${email}`);
  console.log(`last scored: ${scoredExercise.kind} (${previousDifficultyLevel}) submitted ${lastScored.created_at}`);
  console.log(`newest exercise: ${latest ? `${latest.kind} created ${latest.created_at}` : '(none)'}`);

  if (replaceLatest && latest && latest.created_at > lastScored.created_at) {
    const { count } = await supabase
      .from('submissions')
      .select('id', { count: 'exact', head: true })
      .eq('exercise_id', latest.id);
    if ((count ?? 0) > 0) {
      throw new Error(`Newest exercise ${latest.id} already has ${count} submission(s); refusing to delete it.`);
    }
    const { error: deleteError } = await supabase.from('exercises').delete().eq('id', latest.id);
    if (deleteError) throw deleteError;
    console.log(`deleted unsubmitted ${latest.kind} exercise ${latest.id}`);
  }

  const outcome = await generateNextExercise(supabase, {
    learnerId,
    previousDifficultyLevel,
    licenseMode: profile.license_mode,
    afterIso: lastScored.created_at,
  });
  console.log(`outcome: ${outcome}`);

  const { data: after } = await supabase
    .from('exercises')
    .select('id, kind, created_at, scenario')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: false })
    .limit(1);
  const created = after?.[0];
  if (created) {
    const scenario = created.scenario as { transactions?: unknown[] };
    console.log(`newest now: ${created.kind} ${created.id} created ${created.created_at}, ${scenario.transactions?.length ?? 0} transactions`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

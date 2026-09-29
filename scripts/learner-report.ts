// The owner's view of one learner: every month they were given, every
// upload, the score, the feedback and help they received, the questions they
// asked and how long each month took. READ-ONLY: nothing is written to the
// database or to storage. It writes one HTML file, by default OUTSIDE the
// repository because it holds a learner's data, and must never be committed.
//
//   npx tsx scripts/learner-report.ts --learner <email or uuid> [--out <file.html>]
//
// Reads SUPABASE settings from .env.local; never prints secrets.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function main(): Promise<void> {
  loadEnv();
  const who = argValue('--learner');
  if (!who) throw new Error('Usage: npx tsx scripts/learner-report.ts --learner <email or uuid> [--out <file.html>]');

  const { createServiceRoleClient } = await import('@/lib/supabase/service-role');
  const { getExercisesForLearner } = await import('@/lib/db/queries/exercises');
  const { getSubmissionsForLearner } = await import('@/lib/db/queries/submissions');
  const { getHintRequestsForLearner } = await import('@/lib/db/queries/hint-requests');
  const { getQaMessagesForLearner } = await import('@/lib/db/queries/qa-messages');
  const { getConceptAttempts, getConceptMasteryMap } = await import('@/lib/db/queries/mastery');
  const { getSourceDocumentsForExercise } = await import('@/lib/db/queries/source-documents');
  const { buildLearnerReport, renderLearnerReportHtml, formatDuration } = await import('@/lib/reports/learner-report');

  const supabase = createServiceRoleClient();

  const { data: userPage, error: userError } = await supabase.auth.admin.listUsers({ perPage: 1000 });
  if (userError) throw userError;
  const user = UUID.test(who)
    ? userPage.users.find((candidate) => candidate.id === who.toLowerCase())
    : userPage.users.find((candidate) => candidate.email?.toLowerCase() === who.toLowerCase());
  if (!user) throw new Error(`No learner found for ${who}`);
  const learnerId = user.id;

  const { data: profile, error: profileError } = await supabase
    .from('learner_profile')
    .select('full_name, license_mode, onboarded_at, aia_onboarding_completed_at')
    .eq('id', learnerId)
    .maybeSingle();
  if (profileError) throw profileError;

  const [exercises, submissions, hints, questions, attempts, mastery, scoreRows, issueRows] = await Promise.all([
    getExercisesForLearner(supabase, learnerId),
    getSubmissionsForLearner(supabase, learnerId),
    getHintRequestsForLearner(supabase, learnerId),
    getQaMessagesForLearner(supabase, learnerId),
    getConceptAttempts(supabase, learnerId),
    getConceptMasteryMap(supabase, learnerId),
    supabase
      .from('scoring_results')
      .select('submission_id, weighted_score, overall_result, tb_tie_out, error_codes, feedback_text, created_at')
      .eq('learner_id', learnerId)
      .order('created_at', { ascending: true }),
    supabase
      .from('learner_issues')
      .select('message, status, admin_reply, exercise_id, created_at, resolved_at')
      .eq('learner_id', learnerId)
      .order('created_at', { ascending: true }),
  ]);
  if (scoreRows.error) throw scoreRows.error;
  if (issueRows.error) throw issueRows.error;

  const documentsByExercise = new Map<string, { docType: string; documentName: string }[]>();
  for (const exercise of exercises) {
    const documents = await getSourceDocumentsForExercise(supabase, exercise.id);
    documentsByExercise.set(
      exercise.id,
      documents.map((doc) => ({ docType: doc.docType, documentName: doc.documentName })),
    );
  }

  const report = buildLearnerReport({
    learner: {
      id: learnerId,
      name: profile?.full_name?.trim() || user.email || learnerId,
      email: user.email ?? null,
      licenseMode: profile?.license_mode ?? 'not set',
      onboardedAt: profile?.onboarded_at ?? null,
      aiaOnboardingCompletedAt: profile?.aia_onboarding_completed_at ?? null,
    },
    generatedAt: new Date().toISOString(),
    exercises,
    documentsByExercise,
    submissions,
    scores: scoreRows.data ?? [],
    hints,
    attempts,
    questions,
    issues: issueRows.data ?? [],
    mastery,
  });

  const stamp = new Date().toISOString().slice(0, 10);
  const safeName = report.learner.name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || learnerId.slice(0, 8);
  const outFile = path.resolve(argValue('--out') ?? path.join(os.homedir(), 'Documents', 'AIA-Academy-reports', `${safeName}-${stamp}.html`));
  mkdirSync(path.dirname(outFile), { recursive: true });
  writeFileSync(outFile, renderLearnerReportHtml(report), 'utf8');

  console.log(`${report.learner.name}: ${report.progress.percent}% complete, ${report.progress.masteredCount} of ${report.progress.totalCount} topics mastered.`);
  for (const month of report.months) {
    const last = month.uploads[month.uploads.length - 1];
    const state = !last ? 'no upload yet' : last.status === 'scored' ? `${last.result ?? 'scored'}${last.scorePercent !== null ? ` ${last.scorePercent}%` : ''}` : last.status;
    console.log(
      `  Month ${month.ordinal} ${month.title} (${month.level}): ${month.uploads.length} upload${month.uploads.length === 1 ? '' : 's'}, ${state}, first upload after ${formatDuration(month.msToFirstUpload)}`,
    );
  }
  console.log(`\nReport written to ${outFile}`);
  console.log('Nothing was changed in the database.');
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});

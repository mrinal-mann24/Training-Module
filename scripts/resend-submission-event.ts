// Admin: re-fire the Inngest event that scores a submission whose run never
// started (submission stuck in `validating` with both files stored — Garima,
// 2026-09-04 11:16 UTC). Sends exactly what app/(chat)/chat/actions.ts sends:
// `submission/uploaded` for a two-part exercise, or one
// `submission/part-received` per stored part otherwise. Refuses to send when
// the submission is already `scoring`/`scored`, so it cannot double-score.
//
//   npx tsx scripts/resend-submission-event.ts --submission <uuid>
//
// Reads INNGEST_EVENT_KEY / SUPABASE settings from .env.local; never prints secrets.

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
  const submissionId = argValue('--submission');
  if (!submissionId) {
    throw new Error('Usage: npx tsx scripts/resend-submission-event.ts --submission <uuid>');
  }

  const { createServiceRoleClient } = await import('@/lib/supabase/service-role');
  const { inngest } = await import('@/lib/jobs/client');
  const supabase = createServiceRoleClient();

  const { data: submission, error } = await supabase
    .from('submissions')
    .select('id, status, exercise_id')
    .eq('id', submissionId)
    .single();
  if (error || !submission) throw error ?? new Error('submission not found');
  if (submission.status !== 'validating') {
    throw new Error(`Submission is "${submission.status}", not "validating" — refusing to re-send (a run already handled it).`);
  }

  const { data: exercise, error: exerciseError } = await supabase
    .from('exercises')
    .select('required_parts')
    .eq('id', submission.exercise_id)
    .single();
  if (exerciseError || !exercise) throw exerciseError ?? new Error('exercise not found');

  const { data: parts, error: partsError } = await supabase
    .from('submission_parts')
    .select('part_type')
    .eq('submission_id', submissionId);
  if (partsError) throw partsError;
  const partTypes = (parts ?? []).map((part) => part.part_type as string);

  const requiredParts = (exercise.required_parts as string[]) ?? [];
  console.log(`submission ${submissionId}: status validating, required ${JSON.stringify(requiredParts)}, stored ${JSON.stringify(partTypes)}`);

  if (requiredParts.length === 2) {
    await inngest.send({ name: 'submission/uploaded', data: { submissionId } });
    console.log('sent submission/uploaded');
  } else {
    await inngest.send(partTypes.map((partType) => ({ name: 'submission/part-received', data: { submissionId, partType } })));
    console.log(`sent ${partTypes.length} submission/part-received event(s)`);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ValidityError } from '@/lib/tutor/submission-gate';

export type SubmissionStatus = 'validating' | 'invalid' | 'scoring' | 'scored';

export type Submission = {
  id: string;
  learner_id: string;
  exercise_id: string;
  daybook_path: string | null;
  trialbalance_path: string | null;
  // Original upload filenames (2026-08-24, chat-history rebuild) — Storage
  // paths are normalized, so these preserve what the learner actually
  // attached. Null on rows from before the column existed.
  daybook_filename: string | null;
  trialbalance_filename: string | null;
  status: SubmissionStatus;
  validity_errors: ValidityError[] | null;
  created_at: string;
};

// Unit 11: daybook_path/trialbalance_path are nullable — a 'review' exercise's
// submission has no file parts at all (required_parts is just review_text),
// so a submission row can now exist without either path. The submission_parts
// table (lib/db/queries/submission-parts.ts) is the source of truth for what
// actually arrived; these two columns remain for the unchanged two-file path
// (Units 05-07) and are populated when those parts are received.
// The id is supplied by the caller rather than defaulted by Postgres: the
// learner's Storage paths (submissions/{learner_id}/{submission_id}/...) are
// built from it before the row is inserted, and submission_parts rows
// reference it — so all three must agree on one id known up front. Letting
// Postgres generate it here would orphan the parts (and the uploaded files)
// from the row, which RLS/FK correctly rejects.
export async function insertSubmission(
  supabase: SupabaseClient,
  submissionId: string,
  learnerId: string,
  exerciseId: string,
  daybookPath: string | null,
  trialbalancePath: string | null,
  filenames?: { daybook: string | null; trialbalance: string | null },
): Promise<{ id: string }> {
  const { data, error } = await supabase
    .from('submissions')
    .insert({
      id: submissionId,
      learner_id: learnerId,
      exercise_id: exerciseId,
      daybook_path: daybookPath,
      trialbalance_path: trialbalancePath,
      daybook_filename: filenames?.daybook ?? null,
      trialbalance_filename: filenames?.trialbalance ?? null,
      status: 'validating',
    })
    .select('id')
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// Finds a submission for this exercise still in progress (not yet invalid or
// scored) — a multi-part submission's parts arrive as separate chat
// messages/uploads over time, all belonging to the same submissions row, so
// a second part (e.g. the explain_text message sent after the files) must
// join the submission the first part created rather than starting a new one.
// Only one submission can be "in progress" for an exercise at a time by
// construction: the caller always checks this before creating a new row.
export async function getOpenSubmissionForExercise(
  supabase: SupabaseClient,
  learnerId: string,
  exerciseId: string,
): Promise<Submission | null> {
  const { data, error } = await supabase
    .from('submissions')
    .select('id, learner_id, exercise_id, daybook_path, trialbalance_path, daybook_filename, trialbalance_filename, status, validity_errors, created_at')
    .eq('learner_id', learnerId)
    .eq('exercise_id', exerciseId)
    .in('status', ['validating', 'scoring'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateSubmissionFilePaths(
  supabase: SupabaseClient,
  submissionId: string,
  daybookPath: string,
  trialbalancePath: string,
): Promise<void> {
  const { error } = await supabase
    .from('submissions')
    .update({ daybook_path: daybookPath, trialbalance_path: trialbalancePath })
    .eq('id', submissionId);

  if (error) {
    throw error;
  }
}

export async function getSubmission(
  supabase: SupabaseClient,
  submissionId: string,
): Promise<Submission | null> {
  const { data, error } = await supabase
    .from('submissions')
    .select('id, learner_id, exercise_id, daybook_path, trialbalance_path, daybook_filename, trialbalance_filename, status, validity_errors, created_at')
    .eq('id', submissionId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function updateSubmissionStatus(
  supabase: SupabaseClient,
  submissionId: string,
  status: SubmissionStatus,
  validityErrors: ValidityError[] | null,
): Promise<void> {
  const { error } = await supabase
    .from('submissions')
    .update({ status, validity_errors: validityErrors })
    .eq('id', submissionId);

  if (error) {
    throw error;
  }
}

// Chat-history rebuild: every submission, oldest first.
export async function getSubmissionsForLearner(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<Submission[]> {
  const { data, error } = await supabase
    .from('submissions')
    .select('*')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

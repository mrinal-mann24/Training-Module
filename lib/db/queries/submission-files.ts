import type { SupabaseClient } from '@supabase/supabase-js';

// The two Tally XML exports behind a file submission. They live in the
// private 'submissions' bucket under {learner_id}/{submission_id}/, and the
// bucket's policies require the first folder to equal auth.uid()
// (20260812150000_submissions.sql). Callers pass the authenticated client,
// never the service role, so that policy is what scopes the write.

export type SubmissionXmlPaths = {
  daybookPath: string;
  trialbalancePath: string;
};

export function submissionXmlPaths(learnerId: string, submissionId: string): SubmissionXmlPaths {
  return {
    daybookPath: `${learnerId}/${submissionId}/daybook.xml`,
    trialbalancePath: `${learnerId}/${submissionId}/trialbalance.xml`,
  };
}

export type SubmissionXmlFile = 'daybook' | 'trialbalance';

export type UploadSubmissionXmlResult = { status: 'uploaded' } | { status: 'failed'; file: SubmissionXmlFile };

// Day Book first, then Trial Balance. A Day Book failure stops before the
// Trial Balance is attempted. A Storage error comes back as 'failed' naming
// the file, so the caller can say which one did not save; anything the
// client throws propagates unchanged.
//
// upsert (2026-09-16): a re-send OVERWRITES rather than failing. The path is
// derived from the submission id alone, and submitFiles rejoins an open
// submission rather than starting a new one (getOpenSubmissionForExercise
// matches 'validating' and 'scoring'), so a second send of the same exercise
// lands on the paths the first send already wrote. Without upsert, Storage
// answered "resource already exists" and the learner was told to send both
// files again, which could never work: every retry rejoined the same
// submission and collided with the same two objects. That is a permanent
// dead end for the exercise, and it is exactly what a half-finished first
// attempt leaves behind (files and rows written, then the Inngest send
// fails). Overwriting makes the retry a genuine self-heal.
//
// Supabase checks an overwrite against the bucket's UPDATE policy, and that
// policy only permits it while the submission is still 'validating'
// (20260916150000). Files of a 'scoring' or 'scored' submission stay
// immutable: an overwrite there comes back as 'failed', which is intended.
// A scored Trial Balance is the next month's tie-out baseline, so letting a
// learner rewrite it would let them change what they are measured against.
// A first upload is an INSERT and is never affected.
export async function uploadSubmissionXmlFiles(
  supabase: SupabaseClient,
  paths: SubmissionXmlPaths,
  buffers: { daybook: Buffer; trialbalance: Buffer },
): Promise<UploadSubmissionXmlResult> {
  const { error: daybookError } = await supabase.storage
    .from('submissions')
    .upload(paths.daybookPath, buffers.daybook, { contentType: 'application/xml', upsert: true });
  if (daybookError) {
    return { status: 'failed', file: 'daybook' };
  }

  const { error: trialbalanceError } = await supabase.storage
    .from('submissions')
    .upload(paths.trialbalancePath, buffers.trialbalance, { contentType: 'application/xml', upsert: true });
  if (trialbalanceError) {
    return { status: 'failed', file: 'trialbalance' };
  }

  return { status: 'uploaded' };
}

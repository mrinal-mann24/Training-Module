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
export async function uploadSubmissionXmlFiles(
  supabase: SupabaseClient,
  paths: SubmissionXmlPaths,
  buffers: { daybook: Buffer; trialbalance: Buffer },
): Promise<UploadSubmissionXmlResult> {
  const { error: daybookError } = await supabase.storage
    .from('submissions')
    .upload(paths.daybookPath, buffers.daybook, { contentType: 'application/xml' });
  if (daybookError) {
    return { status: 'failed', file: 'daybook' };
  }

  const { error: trialbalanceError } = await supabase.storage
    .from('submissions')
    .upload(paths.trialbalancePath, buffers.trialbalance, { contentType: 'application/xml' });
  if (trialbalanceError) {
    return { status: 'failed', file: 'trialbalance' };
  }

  return { status: 'uploaded' };
}

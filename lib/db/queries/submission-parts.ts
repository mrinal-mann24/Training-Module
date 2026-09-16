import type { SupabaseClient } from '@supabase/supabase-js';
import type { SubmissionPartType } from '@/lib/schemas/exercise';

export type SubmissionPart = {
  id: string;
  submission_id: string;
  part_type: SubmissionPartType;
  content: unknown;
  received_at: string;
};

// content is jsonb for every part_type: text parts (explain_text/review_text)
// store { text: string }, file parts (daybook_xml/trialbalance_xml) store
// { storage_path: string } — the file itself lives in the submissions
// Storage bucket at the path already recorded on submissions.daybook_path/
// trialbalance_path; this is a structurally-consistent pointer, not a second
// copy of the path.
// INSERT ... ON CONFLICT (submission_id, part_type) DO NOTHING (2026-09-16).
// A part that is already recorded is left exactly as it is, and the call
// returns null instead of throwing.
//
// Why a re-send reaches here at all: submitFiles rejoins an open submission
// rather than starting a new one, so sending the two exports again re-records
// the same two part types for the same submission. As a plain insert that hit
// the table's unique constraint and reached the learner as a 500.
//
// Why DO NOTHING and never DO UPDATE. An upsert that updates is checked
// against an UPDATE policy, and submission_parts has only select-own and
// insert-own. The first version of this fix used DO UPDATE and failed live
// with 42501 "new row violates row-level security policy (USING expression)".
// Adding an UPDATE policy would fix that error but is the wrong fix: it would
// let any learner rewrite their own parts straight from the browser,
// including an explanation already confirmed through Smart Send, bypassing
// every guard in submitTextPart. DO NOTHING needs only INSERT.
//
// And DO NOTHING is the correct behaviour, not a workaround:
// - a file part's content is { storage_path }, and that path is derived from
//   the submission id, so on a rejoin the existing row already holds exactly
//   the value this call would write; the file bytes themselves are replaced
//   in Storage, and the scoring job reads the path fresh.
// - a text part is refused upstream once received (submitTextPart), so a
//   conflict here is only ever a race, and keeping the FIRST confirmed answer
//   is right; silently swapping it for a later one is not.
export async function insertSubmissionPart(
  supabase: SupabaseClient,
  submissionId: string,
  partType: SubmissionPartType,
  content: unknown,
): Promise<SubmissionPart | null> {
  const { data, error } = await supabase
    .from('submission_parts')
    .upsert(
      { submission_id: submissionId, part_type: partType, content },
      { onConflict: 'submission_id,part_type', ignoreDuplicates: true },
    )
    .select('id, submission_id, part_type, content, received_at')
    // Zero rows come back when the part already existed, so maybeSingle,
    // never single, which would turn the normal re-send into an error.
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function getSubmissionParts(
  supabase: SupabaseClient,
  submissionId: string,
): Promise<SubmissionPart[]> {
  const { data, error } = await supabase
    .from('submission_parts')
    .select('id, submission_id, part_type, content, received_at')
    .eq('submission_id', submissionId)
    .order('received_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

// A submission is "complete" once it has a matching row for every part_type
// in the exercise's required_parts — spec's definition exactly. Used both by
// the wait-for-submission job (to decide whether to keep waiting) and by the
// chat UI's status checklist (to render check vs. pending per required part).
export function isSubmissionComplete(
  parts: SubmissionPart[],
  requiredParts: readonly SubmissionPartType[],
): boolean {
  const receivedTypes = new Set(parts.map((part) => part.part_type));
  return requiredParts.every((partType) => receivedTypes.has(partType));
}

export function missingParts(
  parts: SubmissionPart[],
  requiredParts: readonly SubmissionPartType[],
): SubmissionPartType[] {
  const receivedTypes = new Set(parts.map((part) => part.part_type));
  return requiredParts.filter((partType) => !receivedTypes.has(partType));
}

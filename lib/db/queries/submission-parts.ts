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
export async function insertSubmissionPart(
  supabase: SupabaseClient,
  submissionId: string,
  partType: SubmissionPartType,
  content: unknown,
): Promise<SubmissionPart> {
  const { data, error } = await supabase
    .from('submission_parts')
    .insert({ submission_id: submissionId, part_type: partType, content })
    .select('id, submission_id, part_type, content, received_at')
    .single();

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

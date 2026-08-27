import type { SupabaseClient } from '@supabase/supabase-js';
import type { AnswerKey, ExerciseVariant } from '@/lib/schemas/exercise';
import type { SourceDocumentType } from '@/lib/schemas/source-document';

const SIGNED_URL_TTL_SECONDS = 60 * 60;

// Signs a pack exercise's shared files ('packs' bucket, authenticated select
// policy — same content for every learner, unlike the per-learner
// exercise-documents bucket) into the same card shape the chat's
// DocumentCard renders. docType is not rendered anywhere (DocumentCard shows
// name + url only) — 'bank_statement' is carried purely to satisfy the
// existing card type without widening it.
export async function getSignedPackFileCards(
  supabase: SupabaseClient,
  packFiles: { label: string; storage_path: string }[],
): Promise<{ id: string; docType: SourceDocumentType; documentName: string; url: string }[]> {
  return Promise.all(
    packFiles.map(async (file) => {
      const { data, error } = await supabase.storage
        .from('packs')
        .createSignedUrl(file.storage_path, SIGNED_URL_TTL_SECONDS);

      if (error || !data) {
        throw error ?? new Error(`Could not sign pack file ${file.storage_path}`);
      }

      return {
        id: file.storage_path,
        docType: 'bank_statement' as SourceDocumentType,
        documentName: file.label,
        url: data.signedUrl,
      };
    }),
  );
}

export type ExercisePack = {
  id: string;
  variant: ExerciseVariant;
  company_name: string;
  day1_message: string;
  pack_files: { label: string; storage_path: string }[];
  answer_key: AnswerKey;
  expected_voucher_count: number;
};

// Server-only (service-role client): exercise_packs has no RLS policies for
// authenticated at all — authored content reaches the learner only via their
// own exercises row (insertPackExercise copies what they may see; the answer
// key never leaves the server). Same discipline as anomaly_templates.
export async function getPackByVariant(
  supabase: SupabaseClient,
  variant: ExerciseVariant,
): Promise<ExercisePack | null> {
  const { data, error } = await supabase
    .from('exercise_packs')
    .select('id, variant, company_name, day1_message, pack_files, answer_key, expected_voucher_count')
    .eq('variant', variant)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as ExercisePack | null) ?? null;
}

// First seeded pack regardless of variant — the assignment fallback for
// learners whose hashed variant isn't seeded yet (see assign-pack-exercise.ts).
export async function getAnyPack(supabase: SupabaseClient): Promise<ExercisePack | null> {
  const { data, error } = await supabase
    .from('exercise_packs')
    .select('id, variant, company_name, day1_message, pack_files, answer_key, expected_voucher_count')
    .order('variant', { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return (data as ExercisePack | null) ?? null;
}

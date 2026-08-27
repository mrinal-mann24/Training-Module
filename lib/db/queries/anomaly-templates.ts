import type { SupabaseClient } from '@supabase/supabase-js';
import type { ConceptTag, ExerciseDifficultyLevel } from '@/lib/schemas/exercise';

export type AnomalyTemplate = {
  id: string;
  concept_tag: ConceptTag;
  anomaly_description: string;
  clean_distractor_description: string;
  difficulty_level: ExerciseDifficultyLevel;
};

// Server-only library content — no RLS select policy exists for authenticated
// on this table at all (see the migration), so this must only ever be called
// from the service-role client, same handling discipline as
// getExerciseAnswerKey. Used by generate-review-exercise.ts to seed
// distractor line items for a review packet.
export async function getAnomalyTemplates(
  supabase: SupabaseClient,
  difficultyLevel: ExerciseDifficultyLevel,
): Promise<AnomalyTemplate[]> {
  const { data, error } = await supabase
    .from('anomaly_templates')
    .select('id, concept_tag, anomaly_description, clean_distractor_description, difficulty_level')
    .eq('difficulty_level', difficultyLevel);

  if (error) {
    throw error;
  }

  return data ?? [];
}

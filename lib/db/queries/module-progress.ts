import type { SupabaseClient } from '@supabase/supabase-js';

export type ModuleProgress = {
  learner_id: string;
  current_module: number;
  current_level: number;
  updated_at: string;
};

export async function getModuleProgress(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<ModuleProgress | null> {
  const { data, error } = await supabase
    .from('module_progress')
    .select('learner_id, current_module, current_level, updated_at')
    .eq('learner_id', learnerId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

// The one sanctioned write path for module_progress (same discipline as
// concept_mastery — architecture.md invariant 5), only ever called from
// lib/tutor/module-progress.ts's caller (the mastery recompute step in
// lib/jobs/run-scoring.ts). Upserts so the first call (no row yet) and every
// subsequent advancement both go through the same path.
export async function upsertModuleProgress(
  supabase: SupabaseClient,
  learnerId: string,
  progress: { currentModule: number; currentLevel: number },
): Promise<void> {
  const { error } = await supabase.from('module_progress').upsert(
    {
      learner_id: learnerId,
      current_module: progress.currentModule,
      current_level: progress.currentLevel,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'learner_id' },
  );

  if (error) {
    throw error;
  }
}

import type { SupabaseClient } from '@supabase/supabase-js';
import { getLearnerProfile } from '@/lib/db/queries/learner-profile';
import { assignPackDiagnostic } from '@/lib/tutor/assign-pack-exercise';
import { generateDiagnosticExercise } from '@/lib/tutor/generate-exercise';

export type DiagnosticSource = 'pack' | 'generated';

type CreateDiagnosticExerciseParams = {
  // Authenticated client: the profile read stays scoped to the learner by RLS.
  supabase: SupabaseClient;
  // Service-role client: learners have no insert grant for exercises and
  // their answer keys.
  serviceRoleClient: SupabaseClient;
  learnerId: string;
};

// Unit 14R: the diagnostic is the authored pack (pilot program's Day-1 file
// set + personalized message), assigned with no LLM call. Falls back to the
// original generated diagnostic only if no pack is seeded for the learner's
// variant, so an unseeded environment still works. Failures propagate; the
// caller decides what the learner is told.
export async function createDiagnosticExercise({
  supabase,
  serviceRoleClient,
  learnerId,
}: CreateDiagnosticExerciseParams): Promise<DiagnosticSource> {
  const profile = await getLearnerProfile(supabase, learnerId);
  // License mode picks the pack's re-dated Educational Mode files once they
  // are uploaded (2026-09-16, see resolvePackFilesForLicense).
  const assigned = await assignPackDiagnostic(
    serviceRoleClient,
    learnerId,
    profile?.full_name ?? null,
    profile?.license_mode ?? null,
  );
  if (assigned) {
    return 'pack';
  }

  // The license mode decides the dates (2026-09-16): an Educational Mode
  // learner can only post on the 1st, 2nd or 31st. No profile row means no
  // onboarding answer, so the licensed default applies.
  await generateDiagnosticExercise(serviceRoleClient, learnerId, profile?.license_mode ?? 'licensed');
  return 'generated';
}

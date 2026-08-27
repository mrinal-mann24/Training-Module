import type { SupabaseClient } from '@supabase/supabase-js';
import type { LicenseMode } from '@/lib/schemas/onboarding';

export type LearnerProfile = {
  id: string;
  license_mode: LicenseMode;
  books_begin_date: string;
  // Unit 14R: captured at onboarding for the pack diagnostic's personalized
  // Day-1 greeting ("Hi Elina."). Nullable for accounts onboarded before the
  // field existed — the greeting falls back rather than blocking.
  full_name: string | null;
  onboarded_at: string | null;
  walkthrough_completed_at: string | null;
  created_at: string;
};

export async function getLearnerProfile(
  supabase: SupabaseClient,
  userId: string,
): Promise<LearnerProfile | null> {
  const { data, error } = await supabase
    .from('learner_profile')
    .select(
      'id, license_mode, books_begin_date, full_name, onboarded_at, walkthrough_completed_at, created_at',
    )
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    throw error;
  }

  return data;
}

export async function isLearnerOnboarded(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const profile = await getLearnerProfile(supabase, userId);
  return profile?.onboarded_at != null;
}

export async function hasCompletedWalkthrough(
  supabase: SupabaseClient,
  userId: string,
): Promise<boolean> {
  const profile = await getLearnerProfile(supabase, userId);
  return profile?.walkthrough_completed_at != null;
}

export async function completeWalkthrough(
  supabase: SupabaseClient,
  userId: string,
): Promise<void> {
  const { error } = await supabase
    .from('learner_profile')
    .update({ walkthrough_completed_at: new Date().toISOString() })
    .eq('id', userId)
    .is('walkthrough_completed_at', null);

  if (error) {
    throw error;
  }
}

export async function completeOnboarding(
  supabase: SupabaseClient,
  userId: string,
  input: { license_mode: LicenseMode; books_begin_date: string; full_name: string },
): Promise<void> {
  const { error } = await supabase.from('learner_profile').upsert({
    id: userId,
    license_mode: input.license_mode,
    books_begin_date: input.books_begin_date,
    full_name: input.full_name,
    onboarded_at: new Date().toISOString(),
  });

  if (error) {
    throw error;
  }
}

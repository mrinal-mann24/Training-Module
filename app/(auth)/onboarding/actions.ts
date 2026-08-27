'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { completeOnboarding } from '@/lib/db/queries/learner-profile';
import { OnboardingInputSchema } from '@/lib/schemas/onboarding';
import type { OnboardingFormState } from './onboarding-form-state';

export async function submitOnboarding(
  _prevState: OnboardingFormState,
  formData: FormData,
): Promise<OnboardingFormState> {
  const parsed = OnboardingInputSchema.safeParse({
    full_name: formData.get('full_name'),
    license_mode: formData.get('license_mode'),
    books_begin_date: formData.get('books_begin_date'),
  });

  if (!parsed.success) {
    return { error: 'Select a license mode and a valid Books Begin Date.' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  await completeOnboarding(supabase, user.id, parsed.data);

  redirect('/dashboard');
}

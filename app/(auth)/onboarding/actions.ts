'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { completeOnboarding } from '@/lib/db/queries/learner-profile';
import { OnboardingInputSchema } from '@/lib/schemas/onboarding';
import { BOOKS_BEGIN_DATE } from '@/lib/tutor/timeline';
import type { OnboardingFormState } from './onboarding-form-state';

export async function submitOnboarding(
  _prevState: OnboardingFormState,
  formData: FormData,
): Promise<OnboardingFormState> {
  // The company always begins on the timeline's date: every exercise and
  // answer key is built on it, so it is set here and never read from the
  // browser.
  const parsed = OnboardingInputSchema.safeParse({
    full_name: formData.get('full_name'),
    license_mode: formData.get('license_mode'),
    books_begin_date: BOOKS_BEGIN_DATE,
  });

  if (!parsed.success) {
    return { error: 'Enter your name and select a license mode.' };
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

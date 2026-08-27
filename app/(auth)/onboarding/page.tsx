import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { OnboardingForm } from './OnboardingForm';

export default async function OnboardingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  if (await isLearnerOnboarded(supabase, user.id)) {
    redirect('/dashboard');
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl border border-border-default bg-bg-surface-raised p-8">
        <h1 className="mb-6 text-center text-xl text-text-primary">Set up your workspace</h1>

        <OnboardingForm />
      </div>
    </main>
  );
}

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
    <div className="w-full max-w-lg rounded-card border border-day-line bg-day-card p-2.5">
      <div className="rounded-panel bg-white p-8 max-md:p-6">
        <h1 className="day-title text-center font-nunito">
          Set up your <em>workspace</em>
        </h1>
        <p className="mt-2 mb-8 text-center font-nunito text-base leading-relaxed text-day-muted">
          Two quick questions before your first exercise.
        </p>

        <OnboardingForm />
      </div>
    </div>
  );
}

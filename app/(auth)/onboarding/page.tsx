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
    <div className="night-card w-full max-w-lg rounded-2xl p-8 backdrop-blur-xl max-md:p-6">
      <h1 className="night-title text-center font-body text-white">
        Set up your <em>workspace</em>
      </h1>
      <p className="night-muted mt-2 mb-8 text-center font-body text-sm leading-relaxed">
        Two quick questions before your first exercise.
      </p>

      <OnboardingForm />
    </div>
  );
}

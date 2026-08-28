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
    <div
      className="w-full max-w-lg rounded-2xl p-8 backdrop-blur-xl max-md:p-6"
      style={{
        background: 'rgba(255, 255, 255, 0.7)',
        border: '1px solid rgba(255, 255, 255, 0.5)',
        boxShadow: 'var(--shadow-dashboard)',
      }}
    >
      <h1 className="text-center font-display text-4xl leading-tight tracking-tight text-foreground">
        Set up your <em className="italic">workspace</em>
      </h1>
      <p className="mb-8 mt-2 text-center font-body text-sm leading-relaxed text-muted-foreground">
        Two quick questions before your first exercise.
      </p>

      <OnboardingForm />
    </div>
  );
}

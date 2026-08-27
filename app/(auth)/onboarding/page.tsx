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
    <div className="w-full max-w-130 rounded-[44px] border-[3px] border-white bg-white/[0.55] p-10 shadow-[0_0_4px_0_rgba(0,0,0,0.15)] backdrop-blur-[20px] max-md:p-7">
      <h1 className="text-center font-sans text-[28px] font-medium leading-tight tracking-[-0.02em] text-wandor-text">
        Set up your workspace
      </h1>
      <p className="mb-8 mt-2 text-center text-sm font-medium leading-relaxed text-wandor-muted">
        Two quick questions before your first exercise.
      </p>

      <OnboardingForm />
    </div>
  );
}

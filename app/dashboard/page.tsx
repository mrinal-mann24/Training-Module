import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { logOut } from './actions';

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  if (!(await isLearnerOnboarded(supabase, user.id))) {
    redirect('/onboarding');
  }

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 bg-bg-canvas px-4">
      <div className="grid w-full max-w-2xl grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-xl border border-border-default bg-bg-surface p-6 opacity-60">
          <h2 className="text-lg text-text-primary">Modules</h2>
          <p className="text-sm text-text-secondary">Coming soon</p>
        </div>

        <Link
          href="/chat"
          className="flex flex-col gap-2 rounded-xl border border-accent bg-bg-surface p-6 transition-colors hover:bg-bg-surface-raised"
        >
          <h2 className="text-lg text-text-primary">Task</h2>
          <p className="text-sm text-text-secondary">Start your diagnostic exercise</p>
        </Link>
      </div>

      <form action={logOut}>
        <button
          type="submit"
          className="rounded-md border border-border-default px-4 py-2 text-sm text-text-secondary hover:bg-bg-surface"
        >
          Log out
        </button>
      </form>
    </main>
  );
}

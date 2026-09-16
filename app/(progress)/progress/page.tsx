import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { getConceptMasteryMap } from '@/lib/db/queries/mastery';
import { currentMajorModule, majorModuleProgress, overallProgress } from '@/lib/tutor/major-modules';
import { ProgressBar } from '@/app/components/ui/ProgressBar';
import { ConceptStatusBadge } from './ConceptStatusBadge';

function conceptLabel(conceptTag: string): string {
  return conceptTag.replace(/_/g, ' ');
}

export default async function ProgressPage() {
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

  // module_progress is no longer read here (2026-09-16). It still records the
  // stored per-concept module number and still gates advancement in the
  // backend, but the learner sees the five named modules instead, derived
  // from the same mastery map as the dashboard bar so the two can never
  // disagree the way "Module 3" in chat and "Module 7" here used to.
  const masteryMap = await getConceptMasteryMap(supabase, user.id);

  const overall = overallProgress(masteryMap);
  const current = currentMajorModule(masteryMap);
  const modules = majorModuleProgress(masteryMap);

  return (
    <main className="min-h-screen bg-bg-canvas px-4 py-10">
      <div className="mx-auto flex w-full max-w-287.5 flex-col gap-6">
        <div>
          <Link href="/dashboard" className="text-sm text-text-secondary underline-offset-4 hover:underline">
            Back to dashboard
          </Link>
          <h1 className="mt-3 text-xl text-text-primary">Your progress</h1>
          <p className="mt-1 text-sm text-text-secondary">
            You are working through {current.title}. Green concept areas are consistently correct.
            &quot;Keep iterating&quot; areas need more clean reps before they graduate.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <ProgressBar percent={overall.percent} label="Overall course progress" className="max-w-md" />
            <span className="whitespace-nowrap text-sm text-text-secondary">
              {overall.masteredCount} of {overall.totalCount} concepts
            </span>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {modules.map(({ majorModule, concepts, masteredCount, totalCount, complete }) => (
            <section key={majorModule.id} className="rounded-lg border border-border-default bg-bg-surface p-4">
              <div className="mb-1 flex items-baseline justify-between gap-3">
                <h2 className="text-sm font-medium text-text-primary">{majorModule.title}</h2>
                <span className="whitespace-nowrap text-xs text-text-muted">
                  {complete ? 'Complete' : `${masteredCount} of ${totalCount}`}
                </span>
              </div>
              <p className="mb-3 text-xs text-text-secondary">{majorModule.blurb}</p>
              <ul className="flex flex-col gap-2">
                {concepts.map(({ tag }) => {
                  const mastery = masteryMap.get(tag);
                  return (
                    <li key={tag} className="flex items-center justify-between gap-3 text-base text-text-primary">
                      <span className="capitalize">{conceptLabel(tag)}</span>
                      <ConceptStatusBadge
                        status={mastery?.status ?? 'not_started'}
                        escalationActive={mastery?.escalation_active ?? false}
                        lastAttemptResult={mastery?.last_attempt_result ?? null}
                      />
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </main>
  );
}

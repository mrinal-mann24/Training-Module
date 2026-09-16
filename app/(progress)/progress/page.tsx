import Link from 'next/link';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { getConceptMasteryMap } from '@/lib/db/queries/mastery';
import { currentMajorModule, majorModuleProgress, overallProgress } from '@/lib/tutor/major-modules';
import { ProductHeader } from '@/app/components/ProductHeader';
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
    <div className="day relative isolate min-h-svh w-full">
      <ProductHeader />

      <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-5 pb-24 pt-10 md:px-8">
        <div>
          <Link
            href="/dashboard"
            className="font-urbanist text-base text-day-blue transition-colors duration-200 hover:text-day-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
          >
            Back to dashboard
          </Link>
          <h1 className="day-title mt-3 font-nunito text-day-ink">Your progress</h1>
          <p className="mt-2 font-nunito text-base text-day-muted">
            You are working through {current.title}. Green concept areas are consistently correct.
            &quot;Keep iterating&quot; areas need more clean reps before they graduate.
          </p>
          <div className="mt-4 flex items-center gap-3">
            <ProgressBar percent={overall.percent} label="Overall course progress" className="max-w-md" />
            <span className="whitespace-nowrap font-nunito text-sm text-day-muted">
              {overall.masteredCount} of {overall.totalCount} concepts
            </span>
          </div>
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          {modules.map(({ majorModule, concepts, masteredCount, totalCount, complete }) => (
            <section key={majorModule.id} className="rounded-card border border-day-line bg-day-card p-2.5">
              <div className="h-full rounded-panel bg-white p-6">
                <div className="mb-1 flex items-baseline justify-between gap-3">
                  <h2 className="font-nunito text-lg font-semibold text-day-ink">{majorModule.title}</h2>
                  <span className="whitespace-nowrap font-urbanist text-xs text-day-muted">
                    {complete ? 'Complete' : `${masteredCount} of ${totalCount}`}
                  </span>
                </div>
                <p className="mb-4 font-nunito text-sm text-day-muted">{majorModule.blurb}</p>
                <ul className="flex flex-col gap-2.5">
                  {concepts.map(({ tag }) => {
                    const mastery = masteryMap.get(tag);
                    return (
                      <li key={tag} className="flex items-center justify-between gap-3 font-nunito text-base text-day-ink">
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
              </div>
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}

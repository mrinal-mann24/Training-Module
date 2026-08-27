import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { getModuleProgress } from '@/lib/db/queries/module-progress';
import { getConceptMasteryMap } from '@/lib/db/queries/mastery';
import { CONCEPT_TAGS, CONCEPT_TO_MODULE } from '@/lib/schemas/exercise';
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

  const [moduleProgress, masteryMap] = await Promise.all([
    getModuleProgress(supabase, user.id),
    getConceptMasteryMap(supabase, user.id),
  ]);

  const currentModule = moduleProgress?.current_module ?? 1;
  const currentLevel = moduleProgress?.current_level ?? 0;

  const moduleNumbers = [...new Set(Object.values(CONCEPT_TO_MODULE))].sort((a, b) => a - b);

  return (
    <main className="min-h-screen bg-bg-canvas px-4 py-10">
      <div className="mx-auto flex w-full max-w-287.5 flex-col gap-6">
        <div>
          <h1 className="text-xl text-text-primary">
            Module {currentModule} · Level {currentLevel}
          </h1>
          <p className="mt-1 text-sm text-text-secondary">
            Green concept areas are consistently correct. &quot;Keep iterating&quot; areas need more
            clean reps before they graduate.
          </p>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          {moduleNumbers.map((moduleNumber) => {
            const conceptsInModule = CONCEPT_TAGS.filter((tag) => CONCEPT_TO_MODULE[tag] === moduleNumber);

            return (
              <section
                key={moduleNumber}
                className="rounded-lg border border-border-default bg-bg-surface p-4"
              >
                <h2 className="mb-3 text-sm font-medium text-text-secondary">Module {moduleNumber}</h2>
                <ul className="flex flex-col gap-2">
                  {conceptsInModule.map((conceptTag) => {
                    const mastery = masteryMap.get(conceptTag);
                    return (
                      <li
                        key={conceptTag}
                        className="flex items-center justify-between gap-3 text-base text-text-primary"
                      >
                        <span className="capitalize">{conceptLabel(conceptTag)}</span>
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
            );
          })}
        </div>
      </div>
    </main>
  );
}

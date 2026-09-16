import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isLearnerOnboarded } from "@/lib/db/queries/learner-profile";
import { getConceptMasteryMap } from "@/lib/db/queries/mastery";
import { currentMajorModule, overallProgress } from "@/lib/tutor/major-modules";
import { ProgressBar } from "@/app/components/ui/ProgressBar";
import { ProductHeader } from "@/app/components/ProductHeader";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  if (!(await isLearnerOnboarded(supabase, user.id))) {
    redirect("/onboarding");
  }

  // The dashboard's only data read beyond the session (2026-09-16). Both the
  // bar and the module name come from the same mastery map, and /progress
  // derives its own from the same query, so the two screens cannot disagree.
  const masteryMap = await getConceptMasteryMap(supabase, user.id);
  const progress = overallProgress(masteryMap);
  const currentModule = currentMajorModule(masteryMap);

  return (
    <div className="day relative isolate min-h-svh w-full">
      <ProductHeader />

      <main className="mx-auto w-full max-w-5xl px-5 pb-24 pt-12 md:px-8 md:pt-16">
        <h1 className="day-heading font-nunito text-day-ink">
          Welcome <em className="not-italic text-day-blue">back</em>
        </h1>
        <p className="day-lede mt-4 max-w-162.5 font-nunito text-day-muted">
          Pick up your training right where you left off.
        </p>

        <Link
          href="/progress"
          className="group mt-10 block rounded-card border border-day-line bg-day-card p-2.5 transition-colors duration-200 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
        >
          <div className="rounded-panel bg-white p-6 md:p-8">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <p className="font-urbanist text-xs uppercase tracking-[0.12em] text-day-muted">
                Your progress
              </p>
              <p className="font-nunito text-sm text-day-muted">
                {progress.percent}% complete · {progress.masteredCount} of {progress.totalCount} concepts
              </p>
            </div>
            <ProgressBar percent={progress.percent} label="Overall course progress" className="mt-4" />
            <p className="mt-3 font-nunito text-sm text-day-muted">
              Working through <span className="text-day-ink">{currentModule.title}</span>. See the full breakdown.
            </p>
          </div>
        </Link>

        <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="rounded-card border border-day-line bg-day-card p-2.5">
            <div className="day-grid-paper flex min-h-60 flex-col justify-between rounded-panel border border-day-line p-8">
              <div>
                <p className="font-urbanist text-xs uppercase tracking-[0.12em] text-day-muted">
                  Modules
                </p>
                <h2 className="mt-3 font-nunito text-3xl font-medium text-day-ink">
                  Video library
                </h2>
                <p className="mt-2 font-nunito text-sm text-day-muted">Coming soon</p>
              </div>
              <span className="inline-flex w-fit rounded-full border border-day-line bg-white px-4 py-1.5 font-urbanist text-xs text-day-muted">
                In a later phase
              </span>
            </div>
          </div>

          <Link
            href="/chat"
            className="group flex rounded-card bg-day-blue p-2.5 transition-colors duration-200 hover:bg-day-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
          >
            <div className="flex min-h-60 w-full flex-col justify-between rounded-panel border border-white/15 p-8">
              <div>
                <p className="font-urbanist text-xs uppercase tracking-[0.12em] text-white/80">
                  Task
                </p>
                <h2 className="mt-3 font-nunito text-3xl font-medium text-white">
                  Start your diagnostic exercise
                </h2>
                <p className="mt-2 font-nunito text-sm text-white/80">
                  Open the chat and work with your tutor.
                </p>
              </div>
              <span className="day-disc flex size-12 items-center justify-center self-end rounded-full text-day-blue transition-transform duration-200 group-hover:scale-105">
                <ArrowUpRight className="h-5 w-5" />
              </span>
            </div>
          </Link>
        </div>
      </main>
    </div>
  );
}

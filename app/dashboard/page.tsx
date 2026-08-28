import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isLearnerOnboarded } from "@/lib/db/queries/learner-profile";
import { logOut } from "./actions";

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

  return (
    <div className="min-h-svh w-full bg-white">
      <div className="mx-auto max-w-340">
        <nav className="flex items-center justify-between px-20 pt-6 pb-4 max-md:px-6 max-md:pt-5">
          <Link
            href="/"
            className="select-none font-display text-[32px] leading-none text-black transition-opacity hover:opacity-70"
          >
            AIA Academy
          </Link>

          <form action={logOut}>
            <button
              type="submit"
              className="cursor-pointer rounded-full border border-border-default bg-transparent px-5 py-3 font-sans text-[13px] font-medium uppercase tracking-[0.04em] text-wandor-text transition-all hover:bg-bg-surface active:scale-95"
            >
              Log out
            </button>
          </form>
        </nav>

        <main className="px-20 pb-24 pt-14 max-md:px-6 max-md:pt-10">
          <p className="font-sans text-[13px] font-semibold uppercase tracking-[0.18em] text-wandor-muted">
            Dashboard
          </p>
          <h1 className="mt-3 max-w-180 font-sans text-[clamp(34px,4.5vw,56px)] font-medium leading-[1.05] tracking-[-0.04em] text-wandor-text">
            Welcome back.
          </h1>
          <p className="mt-4 max-w-125 font-sans text-xl font-medium leading-relaxed text-wandor-muted">
            Pick up your training right where you left off.
          </p>

          <div className="mt-12 grid max-w-245 grid-cols-1 gap-5 sm:grid-cols-2">
            <div className="flex min-h-60 flex-col justify-between rounded-4xl border border-border-default bg-bg-surface p-8">
              <div>
                <p className="font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-wandor-muted">
                  Modules
                </p>
                <h2 className="mt-3 font-sans text-[26px] font-medium leading-snug tracking-[-0.02em] text-wandor-text">
                  Video library
                </h2>
                <p className="mt-2 text-base text-wandor-muted">Coming soon</p>
              </div>
              <span className="inline-flex w-fit rounded-full border border-border-default px-4 py-2 font-sans text-xs font-medium uppercase tracking-[0.04em] text-wandor-muted">
                In a later phase
              </span>
            </div>

            <Link
              href="/chat"
              className="group flex min-h-60 flex-col justify-between rounded-4xl border border-wandor-dark bg-white p-8 transition-all hover:-translate-y-1 hover:shadow-[0_12px_32px_-12px_rgba(0,0,0,0.25)] active:translate-y-0"
            >
              <div>
                <p className="font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-wandor-prompt">
                  Task
                </p>
                <h2 className="mt-3 font-sans text-[26px] font-medium leading-snug tracking-[-0.02em] text-wandor-text">
                  Start your diagnostic exercise
                </h2>
                <p className="mt-2 text-base text-wandor-muted">
                  Open the chat and work with your tutor.
                </p>
              </div>
              <span className="flex h-12 w-12 items-center justify-center self-end rounded-full bg-wandor-dark text-[#fafafa] transition-all group-hover:scale-105 group-hover:bg-[#333]">
                <ArrowUpRight className="h-5 w-5" />
              </span>
            </Link>
          </div>
        </main>
      </div>
    </div>
  );
}

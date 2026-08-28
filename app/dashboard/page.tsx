import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { isLearnerOnboarded } from "@/lib/db/queries/learner-profile";
import { buttonVariants } from "@/app/components/ui/button";
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
    <div className="min-h-svh w-full bg-background font-body">
      <header className="flex items-center justify-between px-6 py-5 md:px-12 lg:px-20">
        <Link
          href="/"
          className="text-xl font-semibold tracking-tight text-foreground transition-opacity hover:opacity-70"
        >
          ✦ AIA Academy
        </Link>

        <form action={logOut}>
          <button
            type="submit"
            className={buttonVariants({ variant: "outline", className: "h-10 px-5" })}
          >
            Log out
          </button>
        </form>
      </header>

      <main className="mx-auto w-full max-w-5xl px-6 pb-24 pt-12 md:pt-16">
        <h1 className="font-display text-5xl leading-[1.05] tracking-tight text-foreground md:text-6xl">
          Welcome <em className="italic">back</em>
        </h1>
        <p className="mt-4 max-w-[650px] text-base leading-relaxed text-muted-foreground md:text-lg">
          Pick up your training right where you left off.
        </p>

        <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2">
          <div className="flex min-h-60 flex-col justify-between rounded-2xl border border-border bg-secondary/50 p-8">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                Modules
              </p>
              <h2 className="mt-3 font-display text-3xl tracking-tight text-foreground">
                Video library
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">Coming soon</p>
            </div>
            <span className="inline-flex w-fit rounded-full border border-border bg-background px-4 py-1.5 text-xs font-medium text-muted-foreground">
              In a later phase
            </span>
          </div>

          <Link
            href="/chat"
            className="group flex min-h-60 flex-col justify-between rounded-2xl border border-border bg-background p-8 transition-all hover:-translate-y-1 hover:shadow-dashboard active:translate-y-0"
          >
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-accent">
                Task
              </p>
              <h2 className="mt-3 font-display text-3xl tracking-tight text-foreground">
                Start your diagnostic exercise
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Open the chat and work with your tutor.
              </p>
            </div>
            <span className="flex h-11 w-11 items-center justify-center self-end rounded-full bg-primary text-primary-foreground transition-transform group-hover:scale-105">
              <ArrowUpRight className="h-5 w-5" />
            </span>
          </Link>
        </div>
      </main>
    </div>
  );
}

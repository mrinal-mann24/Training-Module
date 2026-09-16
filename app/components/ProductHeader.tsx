import { Wordmark } from "@/app/components/Wordmark";
import { logOut } from "@/app/(auth)/login/actions";
import { cn } from "@/lib/cn";

export type ProductHeaderProps = {
  /** Extra controls placed before Log out, e.g. the chat's video library toggle. */
  children?: React.ReactNode;
  className?: string;
};

/**
 * The signed-in header for dashboard, progress and chat: the same dark pill
 * as the landing nav and auth shell, with Log out in place of "Back to site".
 * One component so the three product routes cannot drift apart.
 *
 * No hooks, so it renders from server pages and from ChatShell alike.
 */
export function ProductHeader({ children, className }: ProductHeaderProps) {
  return (
    <header className={cn("relative z-10 px-4 pt-4 md:px-8", className)}>
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between gap-2 rounded-full bg-day-panel pr-2 pl-6 md:pl-10">
        <Wordmark className="font-urbanist" />
        <div className="flex items-center gap-1">
          {children}
          <form action={logOut}>
            <button
              type="submit"
              className="inline-flex h-10 cursor-pointer items-center rounded-full px-5 font-urbanist text-base text-white transition-colors duration-200 hover:bg-white/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              Log out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}

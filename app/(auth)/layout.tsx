import Link from "next/link";
import { Wordmark } from "@/app/components/Wordmark";
import { Bubbles } from "@/app/components/site/Bubbles";

/**
 * Auth shell for sign in, sign up and onboarding. Same `.day` surface, dark
 * pill header and white bubbles as the landing page, so arriving here from
 * "Log in" or "Get started" reads as the same site rather than a jump into
 * the product.
 *
 * It scrolls: onboarding is a real form and can outgrow a short viewport.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="day relative isolate flex min-h-svh w-full flex-col overflow-hidden">
      <Bubbles />

      <header className="relative z-10 px-4 pt-4 md:px-8 md:pt-6">
        <div className="mx-auto flex h-14 max-w-5xl items-center justify-between rounded-full bg-day-panel pr-2 pl-6 md:h-17 md:pl-10">
          <Wordmark className="font-urbanist" />
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-full px-5 font-urbanist text-base text-white transition-colors duration-200 hover:bg-white/10 md:h-13 md:text-lg"
          >
            Back to site
          </Link>
        </div>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pt-10 pb-16 md:px-8">
        {children}
      </main>
    </div>
  );
}

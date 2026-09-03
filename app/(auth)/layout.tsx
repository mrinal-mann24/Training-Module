import { VideoBackdrop } from "@/app/components/VideoBackdrop";
import { Wordmark } from "@/app/components/Wordmark";

/**
 * Auth shell for sign in, sign up and onboarding. Same `.night` surface and
 * same backdrop as the landing frame, so arriving here from "Start training
 * free" reads as one continuous page rather than a jump into the product.
 *
 * Unlike the landing frame this scrolls: onboarding is a real form and can
 * outgrow a short viewport.
 */
export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="night relative isolate flex min-h-svh w-full flex-col">
      <VideoBackdrop />
      <div className="night-grain" />

      <header className="relative z-10 flex items-center px-5 pt-5 pb-2.5 md:px-10 md:pt-6 lg:px-12 xl:px-16">
        <Wordmark />
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-5 pt-4 pb-16 md:px-8">
        {children}
      </main>
    </div>
  );
}

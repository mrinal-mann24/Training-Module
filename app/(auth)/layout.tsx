import Link from "next/link";
import { VideoBackdrop } from "@/app/components/VideoBackdrop";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-svh w-full flex-col overflow-hidden bg-background">
      <VideoBackdrop />

      <header className="relative z-10 flex items-center px-6 py-5 font-body md:px-12 lg:px-20">
        <Link
          href="/"
          className="text-xl font-semibold tracking-tight text-foreground transition-opacity hover:opacity-70"
        >
          ✦ AIA Academy
        </Link>
      </header>

      <main className="relative z-10 flex flex-1 items-center justify-center px-6 pb-16 pt-4">
        {children}
      </main>
    </div>
  );
}

import Link from "next/link";
import { VideoBackdrop } from "@/app/components/VideoBackdrop";

export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="relative flex min-h-svh w-full flex-col overflow-hidden">
      <VideoBackdrop />

      <nav className="relative z-[2] mx-auto flex w-full max-w-[1360px] items-center px-20 pt-6 pb-4 max-md:px-6 max-md:pt-5">
        <Link
          href="/"
          className="select-none font-display text-[32px] leading-none text-black transition-opacity hover:opacity-70"
        >
          AIA Academy
        </Link>
      </nav>

      <main className="relative z-[2] flex flex-1 items-center justify-center px-6 pb-16 pt-4">
        {children}
      </main>
    </div>
  );
}

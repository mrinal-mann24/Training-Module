"use client";

import { useRef } from "react";
import Link from "next/link";
import { Upload } from "lucide-react";
import { VideoBackdrop } from "@/app/components/VideoBackdrop";

function NavButton({ label }: { label: string }) {
  return (
    <button
      type="button"
      className="cursor-pointer border-none bg-transparent font-sans text-[15px] font-medium uppercase tracking-[0.04em] text-wandor-text transition-opacity hover:opacity-55"
    >
      {label}
    </button>
  );
}

export function Hero() {
  const fileInputRef = useRef<HTMLInputElement>(null);

  return (
    <section className="relative min-h-svh w-full overflow-hidden">
      <VideoBackdrop />

      <div className="relative z-[2] mx-auto max-w-[1360px]">
        <nav className="relative flex items-center justify-between px-20 pt-6 pb-4 max-md:px-6 max-md:pt-5">
          <span className="select-none font-display text-[40px] leading-none text-black max-md:text-[32px]">
            AIA Academy
          </span>

          <div className="absolute left-1/2 flex -translate-x-1/2 gap-8 max-md:hidden">
            <NavButton label="How it works" />
            <NavButton label="Curriculum" />
            <NavButton label="FAQs" />
          </div>

          <div className="flex items-center gap-8">
            <Link
              href="/login"
              className="font-sans text-[15px] font-semibold uppercase tracking-[0.04em] text-[#292929] transition-opacity hover:opacity-55 max-md:hidden"
            >
              Login
            </Link>
            <Link
              href="/login"
              className="rounded-full bg-wandor-dark px-5 py-3.5 font-sans text-[15px] font-medium uppercase tracking-[0.04em] text-[#fafafa] transition-all hover:bg-[#333] active:scale-95"
            >
              Start Training
            </Link>
          </div>
        </nav>

        <div className="flex flex-col items-center px-6 pt-16 pb-24 text-center">
          <h1 className="mb-5 max-w-[820px] font-sans text-[clamp(40px,6vw,68px)] font-medium leading-[1.05] tracking-[-0.04em] text-wandor-text">
            Ready to run real books?
          </h1>
          <p className="mb-10 max-w-[500px] font-sans text-xl font-medium leading-relaxed text-wandor-muted">
            Tell your AIA Academy where you are in your training. It scores your
            Tally work and coaches you to mastery, one exercise at a time.
          </p>

          <div className="relative min-h-[208px] w-[701px] overflow-hidden rounded-[44px] border-[3px] border-white bg-white/[0.06] shadow-[0_0_4px_0_rgba(0,0,0,0.15)] backdrop-blur-[20px] max-md:w-[calc(100vw-48px)]">
            <p className="absolute left-[29px] top-[57px] w-[609px] -translate-y-1/2 break-words text-left font-sans text-xl font-medium leading-relaxed text-wandor-prompt max-md:w-[calc(100%-58px)] max-md:text-[17px]">
              I&apos;ve posted April for Blossom Retail in Tally. Here are my
              Day Book and Trial Balance exports. Score me and tell me what to
              work on next....
            </p>

            <input
              ref={fileInputRef}
              type="file"
              accept=".xml"
              className="hidden"
            />
            <button
              type="button"
              aria-label="Upload your Tally exports"
              onClick={() => fileInputRef.current?.click()}
              className="absolute left-[21px] top-[137px] flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border border-white/70 bg-transparent backdrop-blur-[14px] transition-transform hover:scale-105 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
            >
              <Upload className="h-[18px] w-[18px] flex-shrink-0 text-wandor-text" />
            </button>

            <Link
              href="/login"
              className="absolute bottom-[21px] right-[21px] flex h-14 items-center justify-center rounded-[44px] bg-black px-7 font-sans text-base font-medium uppercase tracking-[0.02em] text-[#fafafa] shadow-[0_0_2px_0_rgba(0,0,0,0.05)] transition-all hover:bg-[#333] active:scale-95"
            >
              Start Training
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

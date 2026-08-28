"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { Play } from "lucide-react";
import { buttonVariants } from "@/app/components/ui/button";
import { VideoBackdrop } from "@/app/components/VideoBackdrop";

export function Hero() {
  return (
    <section className="relative flex flex-1 flex-col overflow-hidden">
      <VideoBackdrop />

      <div className="relative z-10 flex w-full flex-col items-center px-6 pt-10 md:pt-14">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mb-6 inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-4 py-1.5 font-body text-sm text-muted-foreground"
        >
          Now with AI Accountant integration ✨
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.1 }}
          className="max-w-xl text-center font-display text-5xl leading-[0.95] tracking-tight text-foreground md:text-6xl lg:text-[5rem]"
        >
          The Future of <em className="italic">Smarter</em> Bookkeeping
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mt-4 max-w-[650px] text-center font-body text-base leading-relaxed text-muted-foreground md:text-lg"
        >
          Train with an AI tutor that scores your real Tally work, adapts to
          your gaps, and coaches you until you are ready for real client books.
        </motion.p>

        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mt-5 flex items-center gap-3"
        >
          <Link href="/login" className={buttonVariants()}>
            Start training
          </Link>
          <button
            type="button"
            aria-label="Play demo"
            className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-full border-0 bg-background shadow-[0_2px_12px_rgba(0,0,0,0.08)] transition-colors hover:bg-background/80"
          >
            <Play className="h-4 w-4 fill-foreground text-foreground" />
          </button>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.5 }}
          className="mt-8 w-full max-w-5xl"
        ></motion.div>
      </div>
    </section>
  );
}

"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { SparkMark } from "@/app/components/Wordmark";
import {
  fadeUp,
  maskUp,
  pop,
  riseIn,
  slideIn,
} from "@/app/components/landing-motion";

const HERO_BUTTON_CLASSES =
  "night-btn inline-flex h-11 items-center justify-center rounded-md px-5 font-body text-sm font-medium tracking-tight whitespace-nowrap max-sm:w-full xl:h-12 xl:px-6";

export function Hero() {
  return (
    // Bottom-anchored, not vertically centred: the copy sits on the darkest
    // part of the backdrop and the artwork stays visible above it.
    <section className="relative z-10 flex items-end justify-center px-5 pb-14 md:px-8 lg:pb-20">
      <div className="flex w-full max-w-4xl flex-col items-center text-center xl:max-w-5xl">
        <motion.p
          {...pop(0.22)}
          className="night-badge mb-5 inline-flex items-center gap-2 rounded-md px-4 py-2 font-body lg:mb-6"
        >
          <SparkMark className="size-4 shrink-0" />
          Practical bookkeeping, graded by AI
        </motion.p>

        <h1 className="night-headline font-body text-white">
          {/* Each line clips its own reveal, so the words wipe up into view. */}
          <span className="block overflow-hidden px-1 py-0.5">
            <motion.span {...maskUp(0.42)} className="block">
              Post it in Tally. Get scored
            </motion.span>
          </span>
          <span className="block overflow-hidden px-1 py-0.5">
            <motion.span {...maskUp(0.62)} className="block">
              like a <em>real client</em> month.
            </motion.span>
          </span>
        </h1>

        <motion.p
          {...fadeUp(0.82, 1.25)}
          className="night-lede mt-4 max-w-lg font-body lg:mt-5 xl:max-w-xl"
        >
          Upload your Day Book and Trial Balance exports. Your tutor scores
          every voucher, names the concepts you are weak at, and builds the
          next exercise around them.
        </motion.p>

        <div className="mt-6 flex w-full flex-wrap items-center justify-center gap-2.5 max-sm:flex-col lg:mt-7">
          <motion.div {...riseIn(0.96)} className="max-sm:w-full">
            <Link
              href="/login"
              className={cn(HERO_BUTTON_CLASSES, "night-btn-solid")}
            >
              Start training free
            </Link>
          </motion.div>

          <motion.div {...slideIn(1.1)} className="max-sm:w-full">
            {/* No walkthrough surface exists yet, so this stays a button
                rather than a link that goes nowhere. */}
            <button
              type="button"
              className={cn(HERO_BUTTON_CLASSES, "night-btn-glass cursor-pointer backdrop-blur-lg")}
            >
              See how it works
            </button>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

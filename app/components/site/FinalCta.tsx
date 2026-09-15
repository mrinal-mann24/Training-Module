"use client";

import Link from "next/link";
import { motion } from "framer-motion";
import { FINAL_CTA } from "@/app/components/site/site-content";
import { headerReveal, riseReveal } from "@/app/components/site/site-motion";
import { Bubbles } from "@/app/components/site/Bubbles";

/** "ARE YOU IN?": the closing call, its button rising in half a second after the line. */
export function FinalCta() {
  return (
    <section aria-labelledby="cta-title" className="relative overflow-hidden py-28 md:py-40">
      <Bubbles />

      <div className="relative flex flex-col items-center px-6 text-center">
        <motion.h2 id="cta-title" {...headerReveal()} className="day-mega font-nunito">
          {FINAL_CTA.title}
        </motion.h2>

        <motion.div {...riseReveal(0.5, 30)}>
          <Link
            href={FINAL_CTA.cta.href}
            className="mt-12 inline-flex h-15 items-center rounded-full bg-day-blue px-9 font-urbanist text-xl text-white transition-colors duration-200 hover:bg-day-blue-hover focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-day-blue"
          >
            {FINAL_CTA.cta.label}
          </Link>
        </motion.div>
      </div>
    </section>
  );
}

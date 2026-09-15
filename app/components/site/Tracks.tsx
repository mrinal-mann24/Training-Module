"use client";

import { motion } from "framer-motion";
import { TRACKS, TRACKS_TITLE } from "@/app/components/site/site-content";
import { headerReveal } from "@/app/components/site/site-motion";
import { CardCarousel } from "@/app/components/site/CardCarousel";

/**
 * The training tracks, pinned for a stretch of scroll so the journey section
 * can rise over them on its arched edge (the journey pulls itself up by one
 * viewport to overlap this section's last pinned screen). Phones get a plain
 * flowing section: a pinned frame taller than a phone screen would clip.
 */
export function Tracks() {
  return (
    <section id="tracks" aria-labelledby="tracks-title" className="relative md:h-[250svh]">
      <div className="flex flex-col justify-center pt-28 pb-16 md:sticky md:top-0 md:h-svh md:pt-32 md:pb-10">
        <motion.h2 id="tracks-title" {...headerReveal()} className="day-heading px-6 text-center font-nunito">
          {TRACKS_TITLE.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </motion.h2>

        <div className="mx-auto mt-10 w-full max-w-7xl md:mt-14">
          <CardCarousel label="Training tracks" cards={TRACKS} />
        </div>
      </div>
    </section>
  );
}

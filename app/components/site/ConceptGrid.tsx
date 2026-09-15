"use client";

import { useState } from "react";
import { motion } from "framer-motion";
import { CONCEPTS, CONCEPTS_TITLE, type ConceptTile } from "@/app/components/site/site-content";
import { SITE_ICONS } from "@/app/components/site/site-icons";
import { SITE_DURATION, SITE_EASE, headerReveal, scaleReveal } from "@/app/components/site/site-motion";
import { Bubbles } from "@/app/components/site/Bubbles";

const DISC_VARIANTS = {
  rest: { rotate: 0, scale: 1, x: 0, y: 0 },
  open: { rotate: 60, scale: 0.8, x: 100, y: -40 },
};

const CHECKS_VARIANTS = {
  rest: { opacity: 0, y: 20 },
  open: { opacity: 1, y: 0 },
};

/**
 * One concept tile. Where the reference swings an employer logo aside to show
 * a review, the glyph disc swings aside (60 degrees, down to 0.8, 100px over,
 * in 0.7s) to show what the tutor checks for that concept. Hover and keyboard
 * focus open it; a tap pins it open, which is how touch screens reach it.
 */
function Tile({ tile, index }: { tile: ConceptTile; index: number }) {
  const [pinned, setPinned] = useState(false);
  const Icon = SITE_ICONS[tile.icon];
  const transition = { duration: SITE_DURATION.release, ease: SITE_EASE };

  return (
    <motion.div {...scaleReveal(0.3 + (index % 3) * 0.2, 0.9)}>
      <motion.button
        type="button"
        aria-expanded={pinned}
        onClick={() => setPinned((open) => !open)}
        initial="rest"
        animate={pinned ? "open" : "rest"}
        whileHover="open"
        whileFocus="open"
        className="relative flex aspect-square w-full cursor-pointer flex-col overflow-hidden rounded-card border border-day-line bg-day-soft p-8 text-left transition-colors duration-500 hover:bg-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue max-sm:aspect-4/3"
      >
        <span className="font-nunito text-2xl text-day-ink md:text-3xl">{tile.name}</span>

        <span className="absolute inset-0 grid place-items-center">
          <motion.span variants={DISC_VARIANTS} transition={transition} className="day-disc grid size-32 place-items-center rounded-full text-day-ink md:size-36">
            <Icon aria-hidden="true" strokeWidth={1.25} className="size-14" />
          </motion.span>
        </span>

        <motion.span
          variants={CHECKS_VARIANTS}
          transition={{ duration: SITE_DURATION.settle, ease: SITE_EASE }}
          className="relative mt-auto block max-w-sm font-nunito text-lg leading-relaxed text-day-ink md:text-xl"
        >
          {tile.checks}
        </motion.span>
      </motion.button>
    </motion.div>
  );
}

export function ConceptGrid() {
  return (
    <section id="concepts" aria-labelledby="concepts-title" className="relative overflow-hidden py-28 md:py-36">
      <Bubbles />

      <div className="relative">
        <motion.h2
          id="concepts-title"
          {...headerReveal()}
          className="day-heading mx-auto max-w-4xl px-6 text-center font-nunito"
        >
          {CONCEPTS_TITLE.map((line) => (
            <span key={line} className="block">
              {line}
            </span>
          ))}
        </motion.h2>

        <div className="mt-16 grid gap-4 px-2 sm:grid-cols-2 md:mt-24 md:px-3 lg:grid-cols-3">
          {CONCEPTS.map((tile, index) => (
            <Tile key={tile.id} tile={tile} index={index} />
          ))}
        </div>
      </div>
    </section>
  );
}

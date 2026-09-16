"use client";

import { motion } from "framer-motion";
import {
  CATEGORIES_TITLE,
  CATEGORY_CONCEPTS,
  CATEGORY_TOOLS,
  type SiteLink,
} from "@/app/components/site/site-content";
import { headerReveal } from "@/app/components/site/site-motion";
import { Bubbles } from "@/app/components/site/Bubbles";
import { CardCarousel } from "@/app/components/site/CardCarousel";

const PRACTISE: SiteLink = { label: "Start practising", href: "/login?mode=signup" };

/** "Training by Category": the same card system as the tracks, in two rails. */
export function Categories() {
  return (
    <section aria-labelledby="categories-title" className="relative overflow-hidden py-28 md:py-36">
      <Bubbles />

      <div className="relative">
        <motion.h2 id="categories-title" {...headerReveal()} className="day-heading px-6 text-center font-nunito">
          {CATEGORIES_TITLE}
        </motion.h2>

        <div className="mt-16 md:mt-24">
          <motion.h3 {...headerReveal()} className="day-subheading text-center font-nunito">
            Concepts
          </motion.h3>
          <div className="mx-auto mt-10 max-w-7xl md:mt-14">
            <CardCarousel label="Concept training" cards={CATEGORY_CONCEPTS} cta={PRACTISE} />
          </div>
        </div>

        <div id="tools" className="mt-24 scroll-mt-28 md:mt-32">
          <motion.h3 {...headerReveal()} className="day-subheading text-center font-nunito">
            Tools
          </motion.h3>
          <div className="mx-auto mt-10 max-w-7xl md:mt-14">
            <CardCarousel label="Tools you work with" cards={CATEGORY_TOOLS} cta={PRACTISE} />
          </div>
        </div>
      </div>
    </section>
  );
}

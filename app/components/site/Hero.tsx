"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { motion, useReducedMotion, useTransform } from "framer-motion";
import { HERO } from "@/app/components/site/site-content";
import { SITE_DURATION, SITE_EASE, useSectionProgress } from "@/app/components/site/site-motion";
import { HeroScene } from "@/app/components/site/HeroScene";
import { PoweredByAiAccountantPill } from "@/app/components/site/PoweredByAiAccountant";

/**
 * Four viewports of scroll pinned to one frame (progress 0.2 to 0.8). The
 * keyframes are the reference's own:
 *
 *   0.30 to 0.40  headline and button lift 50px and fade out
 *   0.40 to 0.50  the payoff line rises 50px into place
 *   0.20 to 0.72  the 3D frames gather, then shrink (see `HeroScene`)
 *   0.65 to 0.70  the payoff line doubles in size and fades
 *   0.70 to 0.80  the 3D scene fades out
 *
 * A thin blue load line runs across the top until the scene's first frame is
 * drawn, standing in for the reference's preloader.
 */
export function Hero() {
  const sectionRef = useRef<HTMLElement>(null);
  const progress = useSectionProgress(sectionRef);
  const reduceMotion = useReducedMotion();
  const [sceneReady, setSceneReady] = useState(false);

  const headY = useTransform(progress, [0.3, 0.4], [0, reduceMotion ? 0 : -50]);
  const headOpacity = useTransform(progress, [0.3, 0.4], [1, 0]);
  const payoffY = useTransform(progress, [0.4, 0.5], [reduceMotion ? 0 : 50, 0]);
  const payoffOpacity = useTransform(progress, [0.4, 0.5, 0.65, 0.7], [0, 1, 1, 0]);
  const payoffScale = useTransform(progress, [0.65, 0.7], [1, reduceMotion ? 1 : 2]);
  const sceneOpacity = useTransform(progress, [0.7, 0.8], [1, 0]);

  return (
    <section id="top" ref={sectionRef} aria-labelledby="hero-title" className="relative h-[400svh] max-md:h-[300svh]">
      <div className="sticky top-0 h-svh overflow-hidden">
        <motion.div
          aria-hidden="true"
          initial={{ scaleX: 0, opacity: 1 }}
          animate={sceneReady ? { scaleX: 1, opacity: 0 } : { scaleX: 0.7, opacity: 1 }}
          transition={{ duration: sceneReady ? SITE_DURATION.reveal : 2, ease: SITE_EASE }}
          className="absolute inset-x-0 top-0 z-30 h-0.5 origin-left bg-day-blue"
        />

        <motion.div style={{ opacity: sceneOpacity }} className="absolute inset-0">
          <HeroScene progress={progress} onReady={() => setSceneReady(true)} />
        </motion.div>

        <motion.div
          style={{ y: headY, opacity: headOpacity }}
          className="relative z-10 flex h-full flex-col items-center justify-center px-6 pb-40 text-center"
        >
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: SITE_DURATION.reveal, ease: SITE_EASE, delay: 0.05 }}
            className="mb-6"
          >
            <PoweredByAiAccountantPill />
          </motion.div>

          <h1 id="hero-title" className="day-display font-nunito text-day-ink">
            {HERO.lines.map((line, index) => (
              <span key={line} className="block overflow-hidden pb-1">
                <motion.span
                  className="block"
                  initial={{ opacity: 0, y: "100%" }}
                  animate={{ opacity: 1, y: "0%" }}
                  transition={{ duration: SITE_DURATION.reveal, ease: SITE_EASE, delay: 0.2 + index * 0.15 }}
                >
                  {line}
                </motion.span>
              </span>
            ))}
          </h1>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: SITE_DURATION.reveal, ease: SITE_EASE, delay: 0.55 }}
          >
            <Link
              href={HERO.cta.href}
              className="mt-10 inline-flex h-15 items-center rounded-full bg-day-blue px-7 font-urbanist text-xl text-white transition-colors duration-200 hover:bg-day-blue-hover focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-day-blue"
            >
              {HERO.cta.label}
            </Link>
          </motion.div>
        </motion.div>

        <div className="pointer-events-none absolute inset-0 z-10 grid place-items-center px-4">
          <motion.p
            style={{ y: payoffY, opacity: payoffOpacity, scale: payoffScale }}
            className="day-mega text-center font-nunito text-day-ink md:whitespace-nowrap"
          >
            {HERO.payoff}
          </motion.p>
        </div>
      </div>
    </section>
  );
}

"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useTransform, type MotionValue } from "framer-motion";
import { cn } from "@/lib/cn";
import { JOURNEY, type JourneyState } from "@/app/components/site/site-content";
import { useSectionProgress } from "@/app/components/site/site-motion";

function StateBlock({
  state,
  y,
  opacity,
  align,
}: {
  state: JourneyState;
  y: MotionValue<number>;
  opacity: MotionValue<number>;
  align: "center" | "end";
}) {
  return (
    <motion.div style={{ y, opacity }} className="absolute inset-0 flex items-center px-6">
      <div className={cn("w-full text-center", align === "end" ? "md:ml-auto md:w-1/2" : "mx-auto")}>
        <p className="font-nunito text-4xl text-white/80 md:text-5xl">{state.eyebrow}</p>
        <p className="day-figure mt-6 font-nunito text-white/90 md:mt-10">{state.figure}</p>
        <p className="mt-6 font-nunito text-2xl text-white/85 md:mt-10 md:text-5xl">{state.caption}</p>
      </div>
    </motion.div>
  );
}

/**
 * The dark journey: four viewports pinned (progress 0.2 to 0.8) on a black
 * field with a blue bloom, rising over the tracks on an arched top edge. A
 * light beam swings from a steep diagonal to flat while a glowing orb rides
 * along it, and the three states hand over on the reference's keyframes:
 *
 *   0.25 to 0.35  "Start" lifts 30px and fades
 *   0.35 to 0.45  "Train" rises 30px into place, holds to 0.50
 *   0.50 to 0.65  "Train" lifts out
 *   0.65 to 0.75  "Finish" rises into place on the right half
 *
 * With reduced motion the beam holds still and the states cross-fade in place.
 */
export function Journey() {
  const sectionRef = useRef<HTMLElement>(null);
  const progress = useSectionProgress(sectionRef);
  const reduceMotion = useReducedMotion();
  const lift = reduceMotion ? 0 : 30;
  const [start, train, finish] = JOURNEY;

  const beamRotate = useTransform(progress, [0.05, 0.45, 0.75], reduceMotion ? [-12, -12, -12] : [-58, -22, 0]);
  const beamScale = useTransform(progress, [0.05, 0.2], [reduceMotion ? 1 : 0.35, 1]);
  const orbX = useTransform(progress, [0.1, 0.84], reduceMotion ? ["0vw", "0vw"] : ["-30vw", "22vw"]);

  const startY = useTransform(progress, [0.25, 0.35], [0, -lift]);
  const startOpacity = useTransform(progress, [0.25, 0.35], [1, 0]);
  const trainY = useTransform(progress, [0.35, 0.45, 0.5, 0.65], [lift, 0, 0, -lift]);
  const trainOpacity = useTransform(progress, [0.35, 0.45, 0.5, 0.65], [0, 1, 1, 0]);
  const finishY = useTransform(progress, [0.65, 0.75], [lift, 0]);
  const finishOpacity = useTransform(progress, [0.65, 0.75], [0, 1]);

  return (
    <section
      id="journey"
      ref={sectionRef}
      aria-label="How the training runs"
      className="day-navy day-arc-top relative z-10 h-[400svh] md:-mt-[100svh]"
    >
      <div className="sticky top-0 h-svh overflow-hidden">
        <motion.div
          aria-hidden="true"
          style={{ rotate: beamRotate, scaleX: beamScale }}
          className="absolute -inset-x-1/4 top-3/5 h-5 -translate-y-1/2 md:h-7"
        >
          <div className="day-beam size-full rounded-full" />
          <motion.div style={{ x: orbX }} className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2">
            <div className="day-glow absolute top-1/2 left-1/2 size-80 -translate-x-1/2 -translate-y-1/2" />
            <div className="day-orb relative size-10 rounded-full" />
          </motion.div>
        </motion.div>

        <StateBlock state={start} y={startY} opacity={startOpacity} align="center" />
        <StateBlock state={train} y={trainY} opacity={trainOpacity} align="center" />
        <StateBlock state={finish} y={finishY} opacity={finishOpacity} align="end" />
      </div>
    </section>
  );
}

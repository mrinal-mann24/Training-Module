"use client";

import { useRef, useSyncExternalStore } from "react";
import { motion, useReducedMotion, useTransform } from "framer-motion";
import { VOICES, VOICES_NOTE, VOICES_TITLE, type VoiceCard } from "@/app/components/site/site-content";
import { riseReveal, useSectionProgress } from "@/app/components/site/site-motion";

const WIDE_QUERY = "(min-width: 768px)";

function subscribeWide(onChange: () => void) {
  const query = window.matchMedia(WIDE_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

/** Column parallax only makes sense side by side; stacked columns would overlap. */
function useWide() {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

function Voice({ voice }: { voice: VoiceCard }) {
  return (
    <motion.figure {...riseReveal(0.2, 30)} className="rounded-card bg-day-card p-8 md:p-9">
      <span aria-hidden="true" className="block h-16 font-nunito text-9xl leading-none text-day-ink/10">
        “
      </span>
      <figcaption className="mt-6 font-nunito">
        <span className="block text-xl">{voice.kind}</span>
        <span className="block text-lg text-day-muted">{voice.topic}</span>
      </figcaption>
      <blockquote className="mt-6 font-nunito text-lg leading-relaxed md:text-xl">{voice.quote}</blockquote>
    </motion.figure>
  );
}

/**
 * Sample tutor messages in the reference's testimonial layout. A giant header
 * travels right to left across a pinned frame (from 110% of its own width to
 * -100%), then three columns rise over it: the outer two from 400px below
 * (settling by 0.8), the middle from 200px (by 0.6). A note above the columns
 * says plainly that these are samples, not testimonials.
 *
 * The reference ran the header over progress 0.2 to 0.8, but its columns sat
 * much further down. Here the columns follow a 30svh gap, so the header runs
 * 0.12 to 0.42 instead: it has left the frame before the first card reaches
 * the middle of the screen.
 */
export function TutorVoices() {
  const sectionRef = useRef<HTMLElement>(null);
  const progress = useSectionProgress(sectionRef);
  const reduceMotion = useReducedMotion();
  const wide = useWide();
  const parallax = wide && !reduceMotion;

  const headerX = useTransform(progress, [0.12, 0.42], reduceMotion ? ["0%", "0%"] : ["110%", "-100%"]);
  const outerY = useTransform(progress, [0, 0.8], [parallax ? 400 : 0, 0]);
  const middleY = useTransform(progress, [0, 0.6], [parallax ? 200 : 0, 0]);

  return (
    <section ref={sectionRef} aria-labelledby="voices-title" className="relative pb-28 md:pb-40">
      <div className="sticky top-0 flex h-svh items-center overflow-hidden">
        <motion.h2
          id="voices-title"
          style={{ x: headerX }}
          className="day-mega w-max pl-6 font-nunito whitespace-nowrap max-md:motion-reduce:whitespace-normal"
        >
          {VOICES_TITLE}
        </motion.h2>
      </div>

      <div className="relative z-10 mx-auto mt-[30svh] max-w-6xl px-5">
        <p className="mx-auto mb-10 w-fit rounded-full border border-day-line bg-white px-5 py-2 text-center font-nunito text-base text-day-muted">
          {VOICES_NOTE}
        </p>

        <div className="grid gap-5 md:grid-cols-3">
          {VOICES.map((column, index) => (
            <motion.div
              key={column[0].id}
              style={{ y: index === 1 ? middleY : outerY }}
              className="flex flex-col gap-5 md:first:mt-24 md:last:mt-24"
            >
              {column.map((voice) => (
                <Voice key={voice.id} voice={voice} />
              ))}
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}

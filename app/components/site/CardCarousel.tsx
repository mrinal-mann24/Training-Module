"use client";

import { useEffect, useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { sliderReveal } from "@/app/components/site/site-motion";
import type { SiteLink, TrainingCard as TrainingCardData } from "@/app/components/site/site-content";
import { TrainingCard } from "@/app/components/site/TrainingCard";

export type CardCarouselProps = {
  /** Names the carousel for assistive tech. */
  label: string;
  cards: readonly TrainingCardData[];
  cta?: SiteLink;
};

const ARROW_CLASSES =
  "grid size-14 shrink-0 cursor-pointer place-items-center rounded-full border border-day-line bg-white text-day-ink transition-[border-color,opacity] duration-200 hover:border-day-ink disabled:cursor-default disabled:opacity-35 disabled:hover:border-day-line";

/**
 * Three cards across on desktop, two on tablets, one on phones. The rail is a
 * native scroll-snap container, so touch swipe, trackpads and keyboard
 * scrolling all work without script; the arrows only step it one card at a
 * time and grey out at either end.
 */
export function CardCarousel({ label, cards, cta }: CardCarouselProps) {
  const railRef = useRef<HTMLDivElement>(null);
  const reduceMotion = useReducedMotion();
  const [edges, setEdges] = useState({ atStart: true, atEnd: false });

  // Edge state follows the rail's own size and scroll position. The observer
  // also fires once on attach, which sets the initial state.
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) return;

    const update = () => {
      const max = rail.scrollWidth - rail.clientWidth;
      setEdges({ atStart: rail.scrollLeft <= 4, atEnd: rail.scrollLeft >= max - 4 });
    };

    const observer = new ResizeObserver(update);
    observer.observe(rail);
    rail.addEventListener("scroll", update, { passive: true });

    return () => {
      observer.disconnect();
      rail.removeEventListener("scroll", update);
    };
  }, []);

  function step(direction: -1 | 1) {
    const rail = railRef.current;
    const slide = rail?.firstElementChild;
    if (!rail || !(slide instanceof HTMLElement)) return;
    rail.scrollBy({ left: direction * slide.offsetWidth, behavior: reduceMotion ? "auto" : "smooth" });
  }

  return (
    <div role="region" aria-roledescription="carousel" aria-label={label} className="relative">
      {/* scroll-padding matches the side padding: without it a snap point
          aligns to the rail's outer edge and the first card slides under
          the arrow. */}
      <div
        ref={railRef}
        className="day-rail flex snap-x snap-mandatory scroll-px-2 overflow-x-auto px-2 pb-4 md:scroll-px-16 md:px-16 xl:scroll-px-20 xl:px-20"
      >
        {cards.map((card, index) => (
          <motion.div
            key={card.id}
            role="group"
            aria-roledescription="slide"
            aria-label={`${index + 1} of ${cards.length}`}
            {...sliderReveal(index)}
            className="shrink-0 basis-full snap-start px-2.5 sm:basis-1/2 lg:basis-1/3"
          >
            <TrainingCard card={card} cta={cta} />
          </motion.div>
        ))}
      </div>

      <div className="mt-4 flex justify-center gap-3 md:pointer-events-none md:absolute md:inset-x-2 md:top-1/2 md:mt-0 md:-translate-y-1/2 md:justify-between">
        <button
          type="button"
          aria-label="Previous cards"
          onClick={() => step(-1)}
          disabled={edges.atStart}
          className={cn(ARROW_CLASSES, "md:pointer-events-auto")}
        >
          <ChevronLeft aria-hidden="true" strokeWidth={1.25} className="size-6" />
        </button>
        <button
          type="button"
          aria-label="Next cards"
          onClick={() => step(1)}
          disabled={edges.atEnd}
          className={cn(ARROW_CLASSES, "md:pointer-events-auto")}
        >
          <ChevronRight aria-hidden="true" strokeWidth={1.25} className="size-6" />
        </button>
      </div>
    </div>
  );
}

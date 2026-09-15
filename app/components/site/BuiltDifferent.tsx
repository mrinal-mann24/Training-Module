"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { BUILT, BUILT_TITLE, type BuiltBlock } from "@/app/components/site/site-content";
import { SITE_DURATION, SITE_EASE, headerReveal, swipeReveal } from "@/app/components/site/site-motion";
import { Bubbles } from "@/app/components/site/Bubbles";

type BlockProps = {
  block: BuiltBlock;
  index: number;
  open: boolean;
  onToggle: () => void;
};

/**
 * One numbered block. Closed, it is a tall narrow card with the title running
 * up its side; open, it widens and the body fades in. On hover the card goes
 * blue and its number lifts 20px (the reference's 0.2s in, 0.5s out). Below
 * `lg` the blocks stack as an ordinary accordion.
 */
function Block({ block, index, open, onToggle }: BlockProps) {
  const bodyId = useId();

  return (
    <motion.div
      {...swipeReveal(index)}
      className={cn(
        "overflow-hidden rounded-card transition-[flex-basis,background-color,color] duration-500 lg:h-136 lg:shrink-0",
        open ? "bg-day-panel text-white lg:basis-lg" : "bg-day-card text-day-ink hover:bg-day-blue hover:text-white lg:basis-40",
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={onToggle}
        className="group flex size-full cursor-pointer flex-col p-7 text-left focus-visible:outline-2 focus-visible:-outline-offset-4 focus-visible:outline-day-blue max-lg:flex-row max-lg:items-center max-lg:gap-6 lg:items-center lg:p-8"
      >
        <span
          className={cn(
            "font-nunito text-5xl transition-transform duration-500 group-hover:-translate-y-5 group-hover:duration-200 lg:text-6xl",
            open && "lg:self-start",
          )}
        >
          {block.number}
        </span>

        <span
          className={cn(
            "font-nunito text-2xl",
            open ? "lg:mt-10 lg:self-start" : "lg:mt-auto lg:rotate-180 lg:[writing-mode:vertical-rl]",
          )}
        >
          {block.title}
        </span>

        <AnimatePresence initial={false}>
          {open && (
            <motion.span
              key="body"
              id={bodyId}
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 12 }}
              transition={{ duration: SITE_DURATION.settle, ease: SITE_EASE, delay: 0.15 }}
              className="block font-nunito text-lg leading-relaxed text-white/85 max-lg:hidden lg:mt-6 lg:self-start lg:text-xl"
            >
              {block.body}
            </motion.span>
          )}
        </AnimatePresence>
      </button>

      {open && (
        <p className="px-7 pb-7 font-nunito text-lg leading-relaxed text-white/85 lg:hidden">{block.body}</p>
      )}
    </motion.div>
  );
}

export function BuiltDifferent() {
  const [openId, setOpenId] = useState<string | null>(null);

  return (
    <section aria-labelledby="built-title" className="relative overflow-hidden py-28 md:py-36">
      <Bubbles />

      <div className="relative mx-auto max-w-7xl px-5 md:px-8">
        <motion.h2 id="built-title" {...headerReveal()} className="day-heading text-center font-nunito">
          {BUILT_TITLE}
        </motion.h2>

        <div className="mt-16 flex flex-col gap-4 md:mt-24 lg:flex-row lg:justify-center lg:gap-5">
          {BUILT.map((block, index) => (
            <Block
              key={block.id}
              block={block}
              index={index}
              open={openId === block.id}
              onToggle={() => setOpenId((current) => (current === block.id ? null : block.id))}
            />
          ))}
        </div>
      </div>
    </section>
  );
}

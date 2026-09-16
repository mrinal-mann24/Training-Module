"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import {
  AnimatePresence,
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
} from "framer-motion";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";
import { Wordmark } from "@/app/components/Wordmark";
import { LOGIN_LINK, NAV_LEARN, NAV_LINKS } from "@/app/components/site/site-content";
import { SITE_DURATION, SITE_EASE } from "@/app/components/site/site-motion";

const LINK_CLASSES =
  "font-urbanist text-lg text-white transition-colors duration-200 hover:text-white/60 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white";

const PANEL_MOTION = {
  initial: { opacity: 0, y: -8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: SITE_DURATION.hover, ease: SITE_EASE },
};

/**
 * Pill sizes. Expanded matches `max-w-5xl` and `py-2` (with the log-in button
 * that gives the `h-14` / `md:h-17` pill); compact matches `max-w-3xl` and
 * `py-1`, so the pill loses 0.5rem of height at every breakpoint.
 */
const PILL_SIZE = {
  expanded: { maxWidth: "64rem", paddingTop: "0.5rem", paddingBottom: "0.5rem" },
  compact: { maxWidth: "48rem", paddingTop: "0.25rem", paddingBottom: "0.25rem" },
} as const;

/** Near the top the pill always stays expanded. */
const EXPANDED_ZONE_PX = 80;
/** Scroll travel in one direction before the pill reacts, so jitter is ignored. */
const DIRECTION_THRESHOLD_PX = 8;

/**
 * Whether the pill should be compact: scrolling down squeezes it, scrolling
 * up (anywhere on the page) expands it. Starts `false` on server and client,
 * and stays `false` under reduced motion.
 */
function useCompactOnScroll(): boolean {
  const reduceMotion = useReducedMotion();
  const { scrollY } = useScroll();
  const anchor = useRef(0);
  const [compact, setCompact] = useState(false);

  useMotionValueEvent(scrollY, "change", (latest) => {
    if (latest <= EXPANDED_ZONE_PX) {
      anchor.current = latest;
      setCompact(false);
      return;
    }
    const delta = latest - anchor.current;
    if (Math.abs(delta) < DIRECTION_THRESHOLD_PX) return;
    anchor.current = latest;
    setCompact(delta > 0);
  });

  return compact && !reduceMotion;
}

/**
 * The fixed dark pill: wordmark, a "Learn" dropdown, two links, and the blue
 * log-in button. Below `md` the links fold into a panel under the pill,
 * closed by Escape, a link tap, or the viewport growing past `md`.
 *
 * The pill squeezes (narrower, shorter) while the page scrolls down and
 * expands again on any scroll up or near the top; see `useCompactOnScroll`.
 */
export function SiteNav() {
  const [learnOpen, setLearnOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const learnRef = useRef<HTMLDivElement>(null);
  const learnId = useId();
  const menuId = useId();
  const compact = useCompactOnScroll();

  // Escape closes either panel; a click outside closes the dropdown; the
  // phone panel closes once the inline nav is back.
  useEffect(() => {
    if (!learnOpen && !menuOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setLearnOpen(false);
      setMenuOpen(false);
    };
    const onPointer = (event: PointerEvent) => {
      if (learnRef.current && event.target instanceof Node && !learnRef.current.contains(event.target)) {
        setLearnOpen(false);
      }
    };
    const desktop = window.matchMedia("(min-width: 768px)");
    const onDesktop = () => setMenuOpen(false);

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    desktop.addEventListener("change", onDesktop);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      desktop.removeEventListener("change", onDesktop);
    };
  }, [learnOpen, menuOpen]);

  return (
    <motion.header
      initial={{ opacity: 0, y: -24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: SITE_DURATION.reveal, ease: SITE_EASE, delay: 0.1 }}
      className="fixed inset-x-0 top-0 z-50 px-4 pt-4 md:px-8 md:pt-6"
    >
      <motion.div
        initial={false}
        animate={compact ? PILL_SIZE.compact : PILL_SIZE.expanded}
        transition={{ duration: SITE_DURATION.settle, ease: SITE_EASE }}
        className="mx-auto flex max-w-5xl items-center gap-10 rounded-full bg-day-panel py-2 pr-2 pl-6 md:pl-10"
      >
        <Wordmark className="font-urbanist" />

        <nav aria-label="Primary" className="flex flex-1 items-center gap-9 max-md:hidden">
          <div
            ref={learnRef}
            className="relative"
            onMouseEnter={() => setLearnOpen(true)}
            onMouseLeave={() => setLearnOpen(false)}
          >
            <button
              type="button"
              aria-expanded={learnOpen}
              aria-controls={learnId}
              onClick={() => setLearnOpen((open) => !open)}
              className={cn(LINK_CLASSES, "inline-flex cursor-pointer items-center gap-1.5")}
            >
              Learn
              <ChevronDown
                aria-hidden="true"
                strokeWidth={1.5}
                className={cn("size-4 transition-transform duration-200", learnOpen && "rotate-180")}
              />
            </button>

            <AnimatePresence>
              {learnOpen && (
                <motion.ul
                  key="learn"
                  id={learnId}
                  {...PANEL_MOTION}
                  className="absolute top-full left-0 flex min-w-56 flex-col gap-1 rounded-2xl bg-day-panel p-2 pt-3 shadow-dashboard"
                >
                  {NAV_LEARN.map((link) => (
                    <li key={link.href}>
                      <Link
                        href={link.href}
                        onClick={() => setLearnOpen(false)}
                        className="block rounded-xl px-4 py-2.5 font-urbanist text-base text-white transition-colors duration-200 hover:bg-white/10"
                      >
                        {link.label}
                      </Link>
                    </li>
                  ))}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>

          {NAV_LINKS.map((link) => (
            <Link key={link.href} href={link.href} className={LINK_CLASSES}>
              {link.label}
            </Link>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2">
          <Link
            href={LOGIN_LINK.href}
            className="inline-flex h-10 items-center rounded-full bg-day-blue px-5 font-urbanist text-base text-white transition-colors duration-200 hover:bg-day-blue-hover md:h-13 md:px-7 md:text-lg"
          >
            {LOGIN_LINK.label}
          </Link>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-controls={menuId}
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="grid size-10 cursor-pointer place-items-center gap-1.5 rounded-full md:hidden"
          >
            <span className={cn("h-px w-4.5 bg-white transition-transform duration-200", menuOpen && "translate-y-1 rotate-45")} />
            <span className={cn("h-px w-4.5 bg-white transition-transform duration-200", menuOpen && "-translate-y-1 -rotate-45")} />
          </button>
        </div>
      </motion.div>

      <AnimatePresence>
        {menuOpen && (
          <motion.nav
            key="menu"
            id={menuId}
            aria-label="Primary"
            {...PANEL_MOTION}
            className="mx-auto mt-2 flex max-w-5xl flex-col gap-1 rounded-card bg-day-panel p-3 md:hidden"
          >
            {[...NAV_LEARN, ...NAV_LINKS].map((link) => (
              <Link
                key={link.href}
                href={link.href}
                onClick={() => setMenuOpen(false)}
                className="rounded-2xl px-5 py-3.5 font-urbanist text-lg text-white transition-colors duration-200 hover:bg-white/10"
              >
                {link.label}
              </Link>
            ))}
          </motion.nav>
        )}
      </AnimatePresence>
    </motion.header>
  );
}

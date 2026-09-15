"use client";

/**
 * Motion for the day surface (landing page and auth shell).
 *
 * The timings are lifted from the reference site's own interaction data, so
 * the page moves the way the reference does: entrances run 0.5s to 1s on the
 * plain CSS `ease` curve with 0.2s delay steps, hovers settle in 0.2s and
 * release in 0.7s, and every scroll scene is keyframed against its section's
 * progress.
 *
 * Presets spread straight onto a `motion.*` element:
 *
 *   <motion.h2 {...headerReveal()}>
 *
 * Reduced motion: `MotionPreference` (`MotionConfig reducedMotion="user"`)
 * strips the transforms from these presets and keeps the fade. Scroll scenes
 * build transforms from motion values, which `MotionConfig` does not reach,
 * so each scene reads `useReducedMotion()` itself.
 */
import type { RefObject } from "react";
import {
  useScroll,
  useSpring,
  type BezierDefinition,
  type MotionValue,
  type Transition,
} from "framer-motion";

/** CSS `ease`, the curve every reference interaction used. */
export const SITE_EASE: BezierDefinition = [0.25, 0.1, 0.25, 1];

export const SITE_DURATION = {
  /** Hover in. */
  hover: 0.2,
  /** Short fades and the opacity half of an entrance. */
  settle: 0.5,
  /** Hover release, and the concept tile opening. */
  release: 0.7,
  /** The transform half of an entrance. */
  reveal: 1,
} as const;

/** One-shot entrances fire a little inside the fold, and only once. */
export const REVEAL_VIEWPORT = { once: true, margin: "0px 0px -12% 0px" } as const;

/**
 * Light smoothing on scroll progress. The reference ran its scroll scenes with
 * Webflow's "smoothing: 50", which trails the wheel slightly instead of
 * snapping to it.
 */
const SCROLL_SMOOTHING = { stiffness: 220, damping: 40, mass: 0.35, restDelta: 0.0005 };

function reveal(delay: number, duration: number = SITE_DURATION.reveal): Transition {
  return { duration, delay, ease: SITE_EASE };
}

/**
 * Section headings: the heading grows, lifts and swings up from flat on its X
 * axis. `transformPerspective` gives the rotation depth on the element
 * itself, so no parent needs a perspective.
 */
export function headerReveal(delay = 0.3) {
  return {
    initial: { opacity: 0, y: 40, scale: 0.8, rotateX: -90, transformPerspective: 1200 },
    whileInView: { opacity: 1, y: 0, scale: 1, rotateX: 0, transformPerspective: 1200 },
    viewport: REVEAL_VIEWPORT,
    transition: reveal(delay, SITE_DURATION.settle),
  };
}

/** Copy lines: a short rise with the fade. */
export function riseReveal(delay = 0.3, distance = 20) {
  return {
    initial: { opacity: 0, y: distance },
    whileInView: { opacity: 1, y: 0 },
    viewport: REVEAL_VIEWPORT,
    transition: reveal(delay),
  };
}

/** Panels and cells: grow into place from slightly small. */
export function scaleReveal(delay = 0.3, from = 0.85) {
  return {
    initial: { opacity: 0, scale: from },
    whileInView: { opacity: 1, scale: 1 },
    viewport: REVEAL_VIEWPORT,
    transition: reveal(delay),
  };
}

/** The numbered "built different" blocks: rise and grow, 0.2s apart. */
export function swipeReveal(index: number) {
  return {
    initial: { opacity: 0, y: 50, scale: 0.9 },
    whileInView: { opacity: 1, y: 0, scale: 1 },
    viewport: REVEAL_VIEWPORT,
    transition: reveal(0.3 + index * 0.2),
  };
}

/** Carousel cards: the first three grow in on a stagger, the rest with the third. */
export function sliderReveal(index: number) {
  const delays = [0.3, 0.5, 0.6];
  return {
    initial: { opacity: 0, scale: 0.8 },
    whileInView: { opacity: 1, scale: 1 },
    viewport: REVEAL_VIEWPORT,
    transition: reveal(delays[Math.min(index, delays.length - 1)]),
  };
}

/**
 * Progress through a scroll scene, matching the reference's "while scrolling
 * in view" trigger: 0 when the section's top meets the bottom of the
 * viewport, 1 when its bottom leaves the top. A section N viewports tall
 * spends progress 1/(N+1) to N/(N+1) pinned, which is the window each
 * scene's keyframes are written against (0.2 to 0.8 for a 400vh section).
 */
export function useSectionProgress(target: RefObject<HTMLElement | null>): MotionValue<number> {
  const { scrollYProgress } = useScroll({ target, offset: ["start end", "end start"] });
  return useSpring(scrollYProgress, SCROLL_SMOOTHING);
}

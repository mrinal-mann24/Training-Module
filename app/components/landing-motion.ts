/**
 * Entrance motion for the night surface (landing frame + auth shell).
 *
 * The whole frame animates in once on load as a single staged sequence —
 * logo, nav, badge, headline lines, lede, buttons, stats — so the delays are
 * a shared timeline rather than something each component re-derives. Every
 * preset spreads straight onto a `motion.*` element:
 *
 *   <motion.h1 {...maskUp(0.42)}>
 *
 * Reduced motion is handled once by `<MotionConfig reducedMotion="user">` in
 * the surface's root component; framer-motion then drops the transforms and
 * keeps only the opacity change, so nothing here needs to branch on it.
 */
import type { BezierDefinition, Transition } from "framer-motion";

/** Long, heavily decelerated ease — the whole surface shares it. */
const EASE: BezierDefinition = [0.16, 1, 0.3, 1];

const DEFAULT_DURATION = 1.05;

function timing(delay: number, duration: number = DEFAULT_DURATION): Transition {
  return { duration, delay, ease: EASE };
}

/** Settles up out of nothing. Logo, nav pills, header CTA. */
export function fadeScale(delay: number) {
  return {
    initial: { opacity: 0, scale: 0.84 },
    animate: { opacity: 1, scale: 1 },
    transition: timing(delay),
  };
}

/** Drifts up into place. Lede, stats, secondary copy. */
export function fadeUp(delay: number, duration?: number) {
  return {
    initial: { opacity: 0, y: 14 },
    animate: { opacity: 1, y: 0 },
    transition: timing(delay, duration),
  };
}

/**
 * Headline reveal: the line rises from below its own baseline and is clipped
 * by the `overflow-hidden` wrapper, so it wipes into view instead of sliding
 * over the hero. Only use inside an element that clips.
 */
export function maskUp(delay: number) {
  return {
    initial: { opacity: 0, y: "40%" },
    animate: { opacity: 1, y: "0%" },
    transition: timing(delay),
  };
}

/** Slight overshoot. Reserved for the badge, the first thing that lands. */
export function pop(delay: number) {
  return {
    initial: { opacity: 0, scale: 0.9 },
    animate: { opacity: 1, scale: [0.9, 1.03, 1] },
    transition: timing(delay),
  };
}

/** Lifts and grows in. The primary call to action. */
export function riseIn(delay: number) {
  return {
    initial: { opacity: 0, y: 18, scale: 0.94 },
    animate: { opacity: 1, y: 0, scale: 1 },
    transition: timing(delay),
  };
}

/** Slides in from the right, so the CTA pair does not land in unison. */
export function slideIn(delay: number) {
  return {
    initial: { opacity: 0, x: 22 },
    animate: { opacity: 1, x: 0 },
    transition: timing(delay),
  };
}

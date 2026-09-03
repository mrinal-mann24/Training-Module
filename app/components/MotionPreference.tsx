"use client";

import type { ReactNode } from "react";
import { MotionConfig } from "framer-motion";

/**
 * Honours the viewer's `prefers-reduced-motion` setting for every
 * framer-motion element below it: transforms are dropped and only the
 * opacity change survives, so the entrance still reads as an entrance
 * without anything sliding or scaling.
 *
 * It exists as its own client component so the surfaces that need it
 * (`app/page.tsx`, `app/(auth)/layout.tsx`) can stay Server Components.
 * `MotionConfig` renders context only, no DOM node, so wrapping in it does
 * not add an element between a grid container and its rows.
 */
export function MotionPreference({ children }: { children: ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}

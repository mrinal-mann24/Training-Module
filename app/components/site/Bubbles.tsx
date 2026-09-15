import { cn } from "@/lib/cn";

/**
 * The soft white circles that sit behind the light sections, as on the
 * reference. Pure decoration: hidden from assistive tech, inert to the
 * pointer, clipped to the section. The parent must be `relative`.
 */
const BUBBLES = [
  "-left-24 top-24 size-80",
  "left-1/5 top-36 size-24 max-md:hidden",
  "right-16 top-20 size-48",
  "left-40 bottom-24 size-44 max-md:hidden",
  "-right-24 -bottom-32 size-144",
] as const;

export function Bubbles({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cn("pointer-events-none absolute inset-0 overflow-hidden", className)}>
      {BUBBLES.map((position) => (
        <span key={position} className={cn("day-bubble", position)} />
      ))}
    </div>
  );
}

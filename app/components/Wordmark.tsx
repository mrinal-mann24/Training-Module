import Link from "next/link";
import { cn } from "@/lib/cn";

/**
 * The AIA Academy mark: the four-point spark the product has always used as
 * its ✦ glyph, drawn as an SVG so it keeps its weight and optical centre at
 * every size instead of inheriting whatever the system emoji font decides.
 * `fill="currentColor"` so it takes the surface's ink (white on the night
 * surface, charcoal in the app).
 */
export function SparkMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 2.6c.55 0 .88.55 1.08 2.1.62 4.7 1.52 5.6 6.22 6.22 1.55.2 2.1.53 2.1 1.08s-.55.88-2.1 1.08c-4.7.62-5.6 1.52-6.22 6.22-.2 1.55-.53 2.1-1.08 2.1s-.88-.55-1.08-2.1c-.62-4.7-1.52-5.6-6.22-6.22C3.15 12.88 2.6 12.55 2.6 12s.55-.88 2.1-1.08c4.7-.62 5.6-1.52 6.22-6.22C11.12 3.15 11.45 2.6 12 2.6Z" />
    </svg>
  );
}

export type WordmarkProps = {
  className?: string;
};

/** Mark plus name, linking home. Shared by the landing header and auth shell. */
export function Wordmark({ className }: WordmarkProps) {
  return (
    <Link
      href="/"
      aria-label="AIA Academy, home"
      className={cn(
        "inline-flex items-center gap-2.5 font-body text-base font-semibold tracking-tight whitespace-nowrap text-white transition-opacity hover:opacity-80 md:text-lg",
        className,
      )}
    >
      <SparkMark className="size-5 md:size-6" />
      <span>
        AIA <span className="font-normal">Academy</span>
      </span>
    </Link>
  );
}

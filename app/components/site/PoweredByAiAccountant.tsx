import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/cn";
import { POWERED_BY } from "@/app/components/site/site-content";

export function PoweredByAiAccountant({ className }: { className?: string }) {
  return (
    <Link
      href={POWERED_BY.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "inline-flex items-center gap-2 font-urbanist text-white/60 transition-colors duration-200 hover:text-white/80",
        className,
      )}
    >
      <img src="/ai-accountant-mark.png" alt="" width={18} height={18} className="rounded-[5px]" />
      <span>
        {POWERED_BY.label} <span className="text-white/80">{POWERED_BY.brand}</span>
      </span>
    </Link>
  );
}

/** The hero eyebrow: a bordered pill above the headline, day-surface toned. */
export function PoweredByAiAccountantPill({ className }: { className?: string }) {
  return (
    <Link
      href={POWERED_BY.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group inline-flex items-center gap-2.5 rounded-full border border-day-line-strong bg-white/80 px-4 py-1.5 font-urbanist text-sm text-day-muted shadow-sm transition-colors duration-200 hover:border-day-blue/40 hover:bg-white",
        className,
      )}
    >
      <img src="/ai-accountant-mark.png" alt="" width={16} height={16} className="rounded-[4px]" />
      <span>
        {POWERED_BY.label} <span className="text-day-ink">{POWERED_BY.brand}</span>
      </span>
      <span aria-hidden="true" className="h-3 w-px bg-day-line-strong" />
      <ArrowRight
        aria-hidden="true"
        strokeWidth={1.75}
        className="size-3.5 transition-transform duration-200 group-hover:translate-x-0.5"
      />
    </Link>
  );
}

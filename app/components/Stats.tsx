"use client";

import { motion } from "framer-motion";
import { fadeUp } from "@/app/components/landing-motion";

/**
 * The three claims that close the landing frame. Each one is a stated
 * mechanic of the product (voucher-level scoring, the five-rung hint ladder,
 * the mastery bar), not an adoption number — the product has no user counts
 * to quote yet, and inventing them would put a false claim on the page.
 */

/** Debit and credit as two ledger columns tied by a single posting. */
function LedgerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0">
      <defs>
        <linearGradient id="stat-ledger-a" x1="3" y1="2" x2="14" y2="22">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.62" />
          <stop offset="1" stopColor="#6a6a6a" stopOpacity="0.85" />
        </linearGradient>
        <linearGradient id="stat-ledger-b" x1="3" y1="2" x2="14" y2="22">
          <stop offset="0" stopColor="#6a6a6a" stopOpacity="0.5" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.62" />
        </linearGradient>
      </defs>
      <rect
        x="3.4"
        y="2.6"
        width="7.2"
        height="18.8"
        rx="3.6"
        fill="url(#stat-ledger-a)"
      />
      <rect
        x="13.4"
        y="2.6"
        width="7.2"
        height="18.8"
        rx="3.6"
        fill="url(#stat-ledger-b)"
      />
      <rect x="9.2" y="10.9" width="5.6" height="2.2" rx="1.1" fill="#8a8a8a" />
    </svg>
  );
}

/** Five rungs, the hint ladder. */
function LadderIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="#e8e8e8"
      strokeWidth="1.7"
      strokeLinecap="round"
      className="size-5 shrink-0"
    >
      <path d="M7.4 2.8v18.4M16.6 2.8v18.4" />
      <path d="M7.4 6.6h9.2M7.4 10.2h9.2M7.4 13.8h9.2M7.4 17.4h9.2" />
    </svg>
  );
}

/** A cleared check on a solid tile: the concept is mastered. */
function MasteredIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-5 shrink-0">
      <rect x="2.4" y="2.4" width="19.2" height="19.2" rx="6.2" fill="#ffffff" />
      <path
        d="M7.6 12.3l3.1 3.1 5.7-6"
        fill="none"
        stroke="#111111"
        strokeWidth="1.85"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

const STATS = [
  {
    label: "Every voucher scored: account, Dr/Cr, GST, TDS",
    icon: <LedgerIcon />,
    delay: 1.12,
  },
  {
    label: "A five-rung hint ladder, so you are never stuck",
    icon: <LadderIcon />,
    delay: 1.28,
  },
  {
    label: "Mastery at three clean runs above 90%",
    icon: <MasteredIcon />,
    delay: 1.44,
  },
] as const;

export function Stats() {
  return (
    <footer className="relative z-10 flex flex-col items-center justify-between gap-4 px-5 pb-8 md:px-8 lg:flex-row lg:gap-6 lg:px-12 lg:pb-9 xl:px-16">
      {STATS.map(({ label, icon, delay }) => (
        <motion.p
          key={label}
          {...fadeUp(delay)}
          className="night-stat inline-flex items-center gap-3 font-body max-lg:text-center lg:whitespace-nowrap"
        >
          {icon}
          {label}
        </motion.p>
      ))}
    </footer>
  );
}

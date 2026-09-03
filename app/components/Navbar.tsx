"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { cn } from "@/lib/cn";
import { fadeScale } from "@/app/components/landing-motion";
import { Wordmark } from "@/app/components/Wordmark";

/**
 * The marketing sections these point at do not exist yet — the landing page
 * is a single viewport. They stay buttons rather than dead `#anchors` so
 * nothing claims to navigate somewhere it cannot. Each carries its own place
 * in the shared entrance timeline.
 */
const NAV_ITEMS = [
  { label: "How it works", delay: 0.16 },
  { label: "Curriculum", delay: 0.28 },
  { label: "Pricing", delay: 0.4 },
  { label: "FAQs", delay: 0.52 },
] as const;

const NAV_ITEM_CLASSES =
  "night-pill inline-flex cursor-pointer items-center justify-center rounded-md whitespace-nowrap font-body font-normal tracking-tight";

export function Navbar() {
  const [menuOpen, setMenuOpen] = useState(false);

  // While the full-screen phone menu is up: freeze the page behind it, close
  // on Escape, and close if the viewport grows past the point where the
  // inline nav (and so the real navigation) is visible again.
  useEffect(() => {
    if (!menuOpen) return;

    const close = () => setMenuOpen(false);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    const desktopWidth = window.matchMedia("(min-width: 1024px)");

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", closeOnEscape);
    desktopWidth.addEventListener("change", close);

    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", closeOnEscape);
      desktopWidth.removeEventListener("change", close);
    };
  }, [menuOpen]);

  return (
    <>
      {menuOpen && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setMenuOpen(false)}
          className="night-menu-backdrop cursor-pointer backdrop-blur-xl lg:hidden"
        />
      )}

      {/* Explicit `col-start-*` on every child, not auto-placement: the nav
          is `display: none` on phones, and auto-placement would then pull the
          CTA into the centre track and crush the wordmark. */}
      <header className="relative z-50 grid grid-cols-[1fr_auto_1fr] items-center gap-2 px-5 pb-2.5 pt-5 md:px-10 md:pt-6 lg:px-12 xl:px-16">
        <motion.div
          {...fadeScale(0.08)}
          className="col-start-1 z-20 justify-self-start"
        >
          <Wordmark />
        </motion.div>

        <nav
          id="site-nav"
          aria-label="Primary"
          className={cn(
            "col-start-2 lg:justify-self-center",
            "max-lg:fixed max-lg:inset-0 max-lg:flex-col max-lg:justify-center max-lg:gap-3 max-lg:px-6 max-lg:pb-8 max-lg:pt-24",
            menuOpen ? "max-lg:flex" : "max-lg:hidden",
            "lg:flex lg:items-center lg:gap-2",
          )}
        >
          {NAV_ITEMS.map(({ label, delay }) => (
            <motion.button
              key={label}
              {...fadeScale(delay)}
              type="button"
              onClick={() => setMenuOpen(false)}
              className={cn(
                NAV_ITEM_CLASSES,
                "max-lg:h-14 max-lg:w-full max-lg:rounded-xl max-lg:text-lg",
                "lg:h-10 lg:px-4 lg:text-sm xl:h-11 xl:px-5",
              )}
            >
              {label}
            </motion.button>
          ))}
        </nav>

        <motion.div
          {...fadeScale(0.34)}
          className="col-start-3 z-20 flex items-center gap-2 justify-self-end"
        >
          <Link
            href="/login"
            className="night-btn night-btn-solid inline-flex h-10 items-center justify-center rounded-md px-4 font-body text-sm font-medium tracking-tight whitespace-nowrap xl:h-11 xl:px-5"
          >
            Start for free
          </Link>

          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-controls="site-nav"
            aria-expanded={menuOpen}
            aria-label={menuOpen ? "Close menu" : "Open menu"}
            className="grid size-10 cursor-pointer place-items-center gap-1.5 rounded-md border border-white/15 bg-white/5 transition-colors hover:border-white/30 hover:bg-white/10 lg:hidden"
          >
            <span
              className={cn(
                "h-px w-4 bg-white transition-transform duration-200",
                menuOpen && "translate-y-[7px] rotate-45",
              )}
            />
            <span
              className={cn(
                "h-px w-4 bg-white transition-opacity duration-200",
                menuOpen && "opacity-0",
              )}
            />
            <span
              className={cn(
                "h-px w-4 bg-white transition-transform duration-200",
                menuOpen && "-translate-y-[7px] -rotate-45",
              )}
            />
          </button>
        </motion.div>
      </header>
    </>
  );
}

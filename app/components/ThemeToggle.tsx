"use client";

import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";

const THEME_STORAGE_KEY = "theme";

type Theme = "light" | "dark";

function subscribe(onStoreChange: () => void): () => void {
  const observer = new MutationObserver(onStoreChange);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

function getSnapshot(): Theme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function getServerSnapshot(): Theme {
  return "light";
}

export function ThemeToggle() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  function toggleTheme() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    document.documentElement.classList.toggle("dark", next === "dark");
    localStorage.setItem(THEME_STORAGE_KEY, next);
  }

  return (
    <button
      type="button"
      onClick={toggleTheme}
      className={cn(
        "rounded-md border border-border-default bg-bg-surface px-4 py-2",
        "text-sm font-medium text-text-primary",
        "hover:bg-accent-subtle hover:text-accent",
        "transition-colors",
      )}
    >
      {theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
    </button>
  );
}

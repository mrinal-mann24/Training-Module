import type { Metadata } from "next";
import "./globals.css";

const THEME_STORAGE_KEY = "theme";

// Phase 4 (spec 16): light is the default theme for the learning UI (the
// manager's bright-background direction). Only an explicit stored "dark"
// choice flips it — OS-level dark preference no longer does, but existing
// users who toggled dark keep their choice. Runs before paint: FOUC-safe.
const setInitialTheme = `
(function () {
  try {
    var stored = localStorage.getItem("${THEME_STORAGE_KEY}");
    document.documentElement.classList.toggle("dark", stored === "dark");
  } catch (e) {}
})();
`;

export const metadata: Metadata = {
  title: "AI Tutor",
  description: "AI Tutor",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full font-sans antialiased" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: setInitialTheme }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}

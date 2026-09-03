import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AIA Academy — Practical bookkeeping, graded by AI",
  description:
    "Post the work in Tally, upload your Day Book and Trial Balance exports, and get every voucher scored with coaching aimed at the concepts you are weakest at.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // suppressHydrationWarning on html/body: browser extensions (Grammarly,
    // password managers, dark-mode extensions) inject attributes before React
    // hydrates, which otherwise triggers spurious hydration mismatch errors.
    <html lang="en" className="h-full font-sans antialiased" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font -- app-router root layout: this loads for every page */}
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}

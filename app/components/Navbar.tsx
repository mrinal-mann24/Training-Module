import Link from "next/link";
import { buttonVariants } from "@/app/components/ui/button";

const NAV_LINKS = ["Home", "Pricing", "About", "Contact"];

export function Navbar() {
  return (
    <header className="flex items-center justify-between px-6 py-5 font-body md:px-12 lg:px-20">
      <Link href="/" className="text-xl font-semibold tracking-tight text-foreground">
        ✦ AIA Academy
      </Link>

      <div className="flex items-center gap-8">
        <nav className="hidden items-center gap-8 md:flex">
          {NAV_LINKS.map((label) => (
            <button
              key={label}
              type="button"
              className="cursor-pointer text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {label}
            </button>
          ))}
        </nav>

        <Link
          href="/login"
          className={buttonVariants({ className: "h-10 px-5 text-sm font-medium" })}
        >
          Get started
        </Link>
      </div>
    </header>
  );
}

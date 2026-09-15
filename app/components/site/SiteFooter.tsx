import Link from "next/link";
import { Wordmark } from "@/app/components/Wordmark";
import { FOOTER } from "@/app/components/site/site-content";

/**
 * The dark rounded footer card. The reference's social icons and legal links
 * are left out: AIA Academy has no social accounts or legal pages to point
 * at yet, and a dead link would be worse than none.
 */
export function SiteFooter() {
  return (
    <footer className="px-2 pb-2">
      <div className="grid gap-10 rounded-footer bg-day-panel px-8 py-12 text-white md:grid-cols-3 md:px-14 md:py-14">
        <div>
          <Wordmark className="font-urbanist md:text-2xl" />
          <p className="mt-8 max-w-sm font-nunito text-lg leading-relaxed">{FOOTER.blurb}</p>
        </div>

        <nav aria-label="Footer">
          <p className="font-nunito text-lg text-white/60">Quick links</p>
          <ul className="mt-4 flex flex-col gap-3">
            {FOOTER.links.map((link) => (
              <li key={link.href}>
                <Link
                  href={link.href}
                  className="font-nunito text-lg underline decoration-day-blue underline-offset-4 transition-colors duration-200 hover:text-white/70"
                >
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        <p className="self-end font-nunito text-lg text-white/80 md:text-right">{FOOTER.copyright}</p>
      </div>
    </footer>
  );
}

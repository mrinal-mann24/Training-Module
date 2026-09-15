import Link from "next/link";
import { cn } from "@/lib/cn";
import type { IconKey, SiteLink, TrainingCard as TrainingCardData } from "@/app/components/site/site-content";
import { SITE_ICONS } from "@/app/components/site/site-icons";

/**
 * Where each disc sits on the graph paper, by how many discs the card has.
 * Centres are percentages of the panel, shared by the disc positions and the
 * dotted connector lines so the two can never drift apart.
 */
type DiscSpot = { x: number; y: number; size: string; icon: string; place: string };

const SPOTS: Record<1 | 2 | 3, readonly DiscSpot[]> = {
  1: [{ x: 50, y: 50, size: "size-28", icon: "size-11", place: "left-1/2 top-1/2" }],
  2: [
    { x: 64, y: 54, size: "size-28", icon: "size-11", place: "left-16/25 top-27/50" },
    { x: 32, y: 44, size: "size-18", icon: "size-7", place: "left-8/25 top-11/25" },
  ],
  3: [
    { x: 60, y: 62, size: "size-26", icon: "size-10", place: "left-3/5 top-31/50" },
    { x: 34, y: 40, size: "size-18", icon: "size-7", place: "left-17/50 top-2/5" },
    { x: 80, y: 30, size: "size-15", icon: "size-6", place: "left-4/5 top-3/10" },
  ],
};

function spotsFor(count: number): readonly DiscSpot[] {
  if (count >= 3) return SPOTS[3];
  if (count === 2) return SPOTS[2];
  return SPOTS[1];
}

function CardIllustration({ discs }: { discs: readonly IconKey[] }) {
  const spots = spotsFor(discs.length);
  const [lead] = spots;

  return (
    <>
      {spots.length > 1 && (
        <svg
          aria-hidden="true"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0 size-full text-day-muted"
        >
          {spots.slice(1).map((spot) => (
            <line
              key={`${spot.x}-${spot.y}`}
              x1={lead.x}
              y1={lead.y}
              x2={spot.x}
              y2={spot.y}
              stroke="currentColor"
              strokeWidth="1.25"
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      )}

      {discs.slice(0, 3).map((key, index) => {
        const spot = spots[index];
        const Icon = SITE_ICONS[key];
        return (
          <div key={key} className={cn("absolute -translate-x-1/2 -translate-y-1/2", spot.place)}>
            <div
              className={cn(
                "day-disc grid place-items-center rounded-full text-day-ink transition-transform duration-500 group-hover:-translate-y-1",
                spot.size,
              )}
            >
              <Icon aria-hidden="true" strokeWidth={1.5} className={spot.icon} />
            </div>
          </div>
        );
      })}
    </>
  );
}

export type TrainingCardProps = {
  card: TrainingCardData;
  cta?: SiteLink;
  className?: string;
};

/**
 * The one card system behind both carousels (training tracks and training by
 * category): a grey shell, a graph-paper panel with a blue tag and glyph
 * discs, two white info pills, a title, and an optional full-width call to
 * action. Hover lifts the discs and flips the tag to ink, in the reference's
 * 0.5s.
 */
export function TrainingCard({ card, cta, className }: TrainingCardProps) {
  return (
    <article
      className={cn(
        "group flex h-full flex-col rounded-card border border-day-line bg-day-card p-4 transition-colors duration-500 hover:bg-white",
        className,
      )}
    >
      <div className="day-grid-paper relative aspect-video overflow-hidden rounded-panel border border-day-line">
        <span className="absolute left-3.5 top-3.5 z-10 rounded-full bg-day-blue px-4 py-1.5 font-urbanist text-base text-white transition-colors duration-500 group-hover:bg-day-ink">
          {card.tag}
        </span>
        <CardIllustration discs={card.discs} />
      </div>

      <ul className="flex flex-wrap gap-2 px-1 pt-5">
        {card.pills.map((pill) => (
          <li
            key={pill}
            className="rounded-full bg-white px-3.5 py-1.5 font-nunito text-base text-day-ink transition-colors duration-500 group-hover:bg-day-card"
          >
            {pill}
          </li>
        ))}
      </ul>

      <h3 className="px-1 pt-4 pb-2 font-urbanist text-xl leading-snug text-day-ink md:text-2xl">
        {card.title.map((line) => (
          <span key={line} className="block">
            {line}
          </span>
        ))}
      </h3>

      {cta && (
        <Link
          href={cta.href}
          className="mt-auto inline-flex h-12 items-center justify-center rounded-full bg-day-blue font-urbanist text-base text-white transition-colors duration-200 hover:bg-day-blue-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-day-blue"
        >
          {cta.label}
        </Link>
      )}
    </article>
  );
}

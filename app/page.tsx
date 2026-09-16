import { MotionPreference } from "@/app/components/site/MotionPreference";
import { BuiltDifferent } from "@/app/components/site/BuiltDifferent";
import { Categories } from "@/app/components/site/Categories";
import { ConceptGrid } from "@/app/components/site/ConceptGrid";
import { FinalCta } from "@/app/components/site/FinalCta";
import { Hero } from "@/app/components/site/Hero";
import { Journey } from "@/app/components/site/Journey";
import { SiteFooter } from "@/app/components/site/SiteFooter";
import { SiteNav } from "@/app/components/site/SiteNav";
import { Tracks } from "@/app/components/site/Tracks";
import { TutorVoices } from "@/app/components/site/TutorVoices";
import { WhySection } from "@/app/components/site/WhySection";

/**
 * The landing page, on the `.day` surface (see `globals.css`), in the order
 * of the reference it is modelled on: pinned 3D hero, training tracks, the
 * dark journey rising over them, why, concepts, what makes it different,
 * training by category, sample tutor messages, the closing call, footer.
 * Copy lives in `app/components/site/site-content.ts`.
 */
export default function Home() {
  return (
    <div className="day relative isolate min-h-svh">
      <MotionPreference>
        <SiteNav />
        <main>
          <Hero />
          <Tracks />
          <Journey />
          <WhySection />
          <ConceptGrid />
          <BuiltDifferent />
          <Categories />
          <TutorVoices />
          <FinalCta />
        </main>
        <SiteFooter />
      </MotionPreference>
    </div>
  );
}

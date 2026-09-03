import { Hero } from "@/app/components/Hero";
import { MotionPreference } from "@/app/components/MotionPreference";
import { Navbar } from "@/app/components/Navbar";
import { Stats } from "@/app/components/Stats";
import { VideoBackdrop } from "@/app/components/VideoBackdrop";

/**
 * The landing frame: one viewport, three rows — header, bottom-anchored hero,
 * stats. It runs on the `.night` surface (see `globals.css`), which is scoped
 * to this page and the auth shell; the product itself stays on the white
 * theme.
 */
export default function Home() {
  return (
    <div className="night night-page relative isolate">
      <VideoBackdrop />
      <div className="night-grain" />

      <MotionPreference>
        <Navbar />
        <Hero />
        <Stats />
      </MotionPreference>
    </div>
  );
}

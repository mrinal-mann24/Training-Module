import { ThemeToggle } from "@/app/components/ThemeToggle";
import { TokenSwatches } from "@/app/components/TokenSwatches";

export default function Home() {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-8 bg-bg-canvas px-6 py-16">
      <div className="flex flex-col items-center gap-3 text-center">
        <h1 className="text-2xl font-bold text-text-primary">AI Tutor</h1>
        <p className="text-base text-text-secondary">
          Chat-based training that turns Tally exports into mastery, one exercise at a time.
        </p>
      </div>
      <ThemeToggle />
      <TokenSwatches />
    </div>
  );
}

import { Hero } from "@/app/components/Hero";
import { Navbar } from "@/app/components/Navbar";

export default function Home() {
  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background">
      <Navbar />
      <Hero />
    </div>
  );
}

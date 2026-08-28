import type { LucideIcon } from "lucide-react";
import {
  Award,
  Bell,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  FileUp,
  Home,
  Landmark,
  ListTodo,
  MessageSquare,
  MoreVertical,
  Percent,
  Plus,
  PlaySquare,
  Receipt,
  Search,
  Settings,
  TrendingUp,
} from "lucide-react";
import { cn } from "@/lib/cn";

function SidebarItem({
  icon: Icon,
  label,
  active = false,
  badge,
  chevron = false,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  badge?: string;
  chevron?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-md px-2 py-1.5",
        active ? "bg-secondary font-medium text-foreground" : "text-muted-foreground",
      )}
    >
      <Icon className="h-3 w-3 shrink-0" />
      <span>{label}</span>
      {badge && (
        <span className="ml-auto rounded-full bg-secondary px-1.5 py-px text-[9px] text-foreground">
          {badge}
        </span>
      )}
      {chevron && <ChevronRight className="ml-auto h-3 w-3" />}
    </div>
  );
}

function ActionPill({ label, primary = false }: { label: string; primary?: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-3 py-1.5 text-[10px] font-medium",
        primary
          ? "bg-accent text-accent-foreground"
          : "border border-border bg-background text-foreground",
      )}
    >
      {label}
    </span>
  );
}

function StatusPill({ label, tone }: { label: string; tone: "success" | "warning" }) {
  return (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-[9px] font-medium",
        tone === "success"
          ? "bg-status-success/10 text-status-success"
          : "bg-status-warning/10 text-status-warning",
      )}
    >
      {label}
    </span>
  );
}

const SUBMISSIONS = [
  { date: "Mar 14", exercise: "Batch 7 · Bank Statement", score: "—", highlight: false, status: "Scoring", tone: "warning" as const },
  { date: "Mar 13", exercise: "Batch 6 · GST & TDS", score: "96%", highlight: true, status: "Passed", tone: "success" as const },
  { date: "Mar 12", exercise: "Batch 5 · Purchase Returns", score: "88%", highlight: false, status: "Passed", tone: "success" as const },
  { date: "Mar 11", exercise: "Batch 4 · Journal Entries", score: "84%", highlight: false, status: "Passed", tone: "success" as const },
];

const CONCEPT_AREAS = [
  { name: "GST Postings", value: "96%" },
  { name: "TDS Sections", value: "88%" },
  { name: "Bank Reconciliation", value: "74%" },
];

export function DashboardPreview() {
  return (
    <div
      className="overflow-hidden rounded-2xl p-3 md:p-4"
      style={{
        background: "rgba(255, 255, 255, 0.4)",
        border: "1px solid rgba(255, 255, 255, 0.5)",
        boxShadow: "var(--shadow-dashboard)",
      }}
    >
      <div className="pointer-events-none select-none overflow-hidden rounded-xl bg-background font-body text-[11px] text-foreground">
        {/* Top bar */}
        <div className="flex items-center justify-between gap-4 border-b border-border px-4 py-2.5">
          <div className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-primary text-[10px] font-semibold text-primary-foreground">
              A
            </span>
            <span className="font-medium">AIA Academy</span>
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          </div>

          <div className="hidden w-64 items-center gap-2 rounded-md bg-secondary px-3 py-1.5 text-muted-foreground md:flex">
            <Search className="h-3 w-3" />
            <span>Search</span>
            <span className="ml-auto rounded border border-border bg-background px-1 text-[9px]">
              ⌘K
            </span>
          </div>

          <div className="flex items-center gap-3">
            <span className="rounded-full bg-primary px-3 py-1.5 font-medium text-primary-foreground">
              Start Exercise
            </span>
            <Bell className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-accent text-[9px] font-medium text-accent-foreground">
              ES
            </span>
          </div>
        </div>

        <div className="flex">
          {/* Sidebar */}
          <div className="hidden w-40 shrink-0 flex-col gap-0.5 border-r border-border px-2 py-3 sm:flex">
            <SidebarItem icon={Home} label="Home" active />
            <SidebarItem icon={MessageSquare} label="Tutor Chat" badge="2" />
            <SidebarItem icon={ListTodo} label="Exercises" chevron />
            <SidebarItem icon={FileUp} label="Submissions" />
            <SidebarItem icon={TrendingUp} label="Progress" />
            <SidebarItem icon={PlaySquare} label="Modules" chevron />
            <SidebarItem icon={Award} label="Certificate" />

            <p className="mt-3 px-2 pb-1 text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              Concepts
            </p>
            <SidebarItem icon={Receipt} label="GST" />
            <SidebarItem icon={Percent} label="TDS" />
            <SidebarItem icon={Landmark} label="Bank Entries" />
            <SidebarItem icon={FileText} label="Narrations" />
            <SidebarItem icon={Settings} label="Settings" />
          </div>

          {/* Main content */}
          <div className="flex-1 bg-secondary/30 px-4 py-4">
            <p className="text-sm font-semibold">Welcome, Elina</p>

            <div className="mt-3 flex flex-wrap items-center gap-2">
              <ActionPill label="Start Exercise" primary />
              <ActionPill label="Upload Day Book" />
              <ActionPill label="Upload Trial Balance" />
              <ActionPill label="Ask Tutor" />
              <ActionPill label="Get a Hint" />
              <ActionPill label="View Progress" />
              <span className="ml-auto text-[10px] text-muted-foreground">Customize</span>
            </div>

            <div className="mt-4 flex gap-3">
              {/* Mastery score card */}
              <div className="flex-1 basis-0 rounded-lg border border-border bg-background p-4">
                <div className="flex items-center gap-1.5">
                  <span className="font-medium">Mastery Score</span>
                  <span className="flex h-3.5 w-3.5 items-center justify-center rounded-full bg-status-success/15">
                    <Check className="h-2 w-2 text-status-success" />
                  </span>
                </div>
                <p className="mt-2 text-xl font-semibold tracking-tight">
                  92.4<span className="text-xs text-muted-foreground">%</span>
                </p>
                <div className="mt-1 flex items-center gap-3 text-[10px] text-muted-foreground">
                  <span>Last 30 Days</span>
                  <span className="font-medium text-status-success">+8 passed</span>
                  <span className="font-medium text-status-warning">2 to retry</span>
                </div>

                <svg
                  className="mt-3 h-20 w-full"
                  viewBox="0 0 400 80"
                  preserveAspectRatio="none"
                  aria-hidden="true"
                >
                  <defs>
                    <linearGradient id="mastery-chart-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--accent))" stopOpacity="0.15" />
                      <stop offset="100%" stopColor="hsl(var(--accent))" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <path
                    d="M0,62 C50,58 80,34 120,38 C160,42 190,18 230,24 C270,30 300,52 340,40 C365,33 385,24 400,18 L400,80 L0,80 Z"
                    fill="url(#mastery-chart-fill)"
                  />
                  <path
                    d="M0,62 C50,58 80,34 120,38 C160,42 190,18 230,24 C270,30 300,52 340,40 C365,33 385,24 400,18"
                    fill="none"
                    stroke="hsl(var(--accent))"
                    strokeWidth="1.5"
                    vectorEffect="non-scaling-stroke"
                  />
                </svg>
              </div>

              {/* Concept areas card */}
              <div className="flex-1 basis-0 rounded-lg border border-border bg-background p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">Concept Areas</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Plus className="h-3 w-3" />
                    <MoreVertical className="h-3 w-3" />
                  </span>
                </div>
                <div className="mt-1">
                  {CONCEPT_AREAS.map((concept) => (
                    <div
                      key={concept.name}
                      className="flex items-center justify-between py-3 text-xs"
                    >
                      <span className="text-muted-foreground">{concept.name}</span>
                      <span className="font-medium">{concept.value}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Recent submissions */}
            <div className="mt-4 rounded-lg border border-border bg-background p-4">
              <p className="text-xs font-semibold">Recent Submissions</p>
              <table className="mt-2 w-full">
                <thead>
                  <tr className="text-left text-[10px] text-muted-foreground">
                    <th className="py-1.5 font-medium">Date</th>
                    <th className="py-1.5 font-medium">Exercise</th>
                    <th className="py-1.5 text-right font-medium">Score</th>
                    <th className="py-1.5 text-right font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {SUBMISSIONS.map((submission) => (
                    <tr key={submission.exercise}>
                      <td className="py-1.5 text-muted-foreground">{submission.date}</td>
                      <td className="py-1.5">{submission.exercise}</td>
                      <td
                        className={cn(
                          "py-1.5 text-right font-medium",
                          submission.highlight && "text-status-success",
                        )}
                      >
                        {submission.score}
                      </td>
                      <td className="py-1.5 text-right">
                        <StatusPill label={submission.status} tone={submission.tone} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

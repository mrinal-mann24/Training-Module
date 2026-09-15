import {
  Bot,
  Building2,
  Calculator,
  ClipboardCheck,
  Coins,
  FileCode,
  GraduationCap,
  HandCoins,
  Landmark,
  LifeBuoy,
  ListChecks,
  NotebookPen,
  Percent,
  Receipt,
  ScrollText,
  ShoppingCart,
  Table2,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import type { IconKey } from "@/app/components/site/site-content";

/**
 * The line glyphs on the card illustrations and concept tiles. Kept apart
 * from `site-content.ts` so the copy stays plain data.
 */
export const SITE_ICONS: Record<IconKey, LucideIcon> = {
  diagnostic: ClipboardCheck,
  drills: ListChecks,
  documents: ScrollText,
  bank: Landmark,
  aia: Bot,
  capstone: GraduationCap,
  sales: Receipt,
  purchase: ShoppingCart,
  gst: Percent,
  tds: HandCoins,
  assets: Building2,
  payables: Wallet,
  receivables: Coins,
  journal: NotebookPen,
  tally: Calculator,
  daybook: FileCode,
  trialBalance: Table2,
  hints: LifeBuoy,
};

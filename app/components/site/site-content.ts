/**
 * Every word and figure on the landing page, in one place.
 *
 * House rule for this file: nothing here may claim more than the product
 * specifies (`context/project-overview.md`). The reference site sells with
 * prices, salaries, learner counts, employer logos and testimonials. AIA
 * Academy has none of those to quote, so each of those slots carries a
 * mechanic the product really has: the checks every voucher gets, the error
 * weighting, the hint ladder, the mastery bar, the concept areas from the
 * training-module docs, and sample tutor messages labelled as samples. No em
 * dashes anywhere (manager spec, applies to marketing copy too).
 */

/** Illustration glyphs, mapped to icons in `site-icons.tsx`. */
export type IconKey =
  | "diagnostic"
  | "drills"
  | "documents"
  | "bank"
  | "aia"
  | "capstone"
  | "sales"
  | "purchase"
  | "gst"
  | "tds"
  | "assets"
  | "payables"
  | "receivables"
  | "journal"
  | "tally"
  | "daybook"
  | "trialBalance"
  | "hints";

export type SiteLink = {
  label: string;
  href: string;
};

/** The shared card: graph-paper illustration, tag pill, two info pills, title. */
export type TrainingCard = {
  id: string;
  /** The blue pill over the illustration. */
  tag: string;
  pills: readonly [string, string];
  /** One or two lines; a second line sits on its own row. */
  title: readonly string[];
  /** One to three glyphs. The first is the large disc. */
  discs: readonly IconKey[];
};

export const NAV_LEARN: readonly SiteLink[] = [
  { label: "Training tracks", href: "/#tracks" },
  { label: "Concepts", href: "/#concepts" },
  { label: "Tools", href: "/#tools" },
];

export const NAV_LINKS: readonly SiteLink[] = [
  { label: "How it works", href: "/#journey" },
  { label: "About", href: "/#why" },
];

export const LOGIN_LINK: SiteLink = { label: "Log in", href: "/login" };

export const HERO = {
  lines: ["Breaking Into", "Accounting is Hard"],
  cta: { label: "Find out more", href: "#tracks" },
  /** The line the 3D cluster gathers behind as the hero scrolls. */
  payoff: "We Make it Practical",
} as const;

export const TRACKS_TITLE = ["Targeted Training,", "Built Around Your Level"] as const;

export const TRACKS: readonly TrainingCard[] = [
  {
    id: "diagnostic",
    tag: "Start here",
    pills: ["Authored pack", "Sets your starting point"],
    title: ["Diagnostic:", "Where You Stand"],
    discs: ["diagnostic"],
  },
  {
    id: "drills",
    tag: "Level 0 to 1",
    pills: ["One concept", "Clean drills"],
    title: ["Tally Drills:", "Get the Basics Right"],
    discs: ["drills", "sales"],
  },
  {
    id: "documents",
    tag: "Level 2",
    pills: ["PDF bills", "Seeded traps"],
    title: ["Source Documents:", "Spot the Trap"],
    discs: ["documents", "gst"],
  },
  {
    id: "bank",
    tag: "Level 3",
    pills: ["Bank statement", "Ledger review"],
    title: ["Bank and Review:", "Find the Anomaly"],
    discs: ["bank", "journal", "receivables"],
  },
  {
    id: "aia",
    tag: "After mastery",
    pills: ["AI Accountant", "Same standard"],
    title: ["AIA Workflow:", "Same Books, Faster"],
    discs: ["aia", "tally"],
  },
  {
    id: "capstone",
    tag: "Final",
    pills: ["Client month", "Certificate"],
    title: ["Capstone:", "Close a Real Month"],
    discs: ["capstone"],
  },
];

export type JourneyState = {
  id: string;
  eyebrow: string;
  figure: string;
  caption: string;
};

/** The three states the beam carries you through, in scroll order. */
export const JOURNEY: readonly [JourneyState, JourneyState, JourneyState] = [
  { id: "start", eyebrow: "Start", figure: "Day 1", caption: "A diagnostic maps what you already know" },
  { id: "train", eyebrow: "Train", figure: "0–12", caption: "Modules, each more real than the last" },
  { id: "finish", eyebrow: "Finish", figure: "1 Month", caption: "A messy client month, then your certificate" },
];

export const WHY = {
  title: "Why AIA Academy?",
  left: [
    "Every exercise is scored against the Karbon VA House Practices Rulebook, the standard a real practice holds its own staff to.",
    "The same entry gets the same verdict every time, on your first batch and on your capstone.",
  ],
  right: [
    "Post the work in your own copy of Tally, then upload the Detailed Day Book and Trial Balance XML. No retyping answers into a form.",
    "Got an entry wrong? The tutor points you at it, you fix it in Tally and send it again. The help climbs one step each time until it gets you there.",
  ],
  caption: { name: "Your AI tutor", role: "Scores, coaches, never leads with the answer" },
  stats: [
    { figure: "7", unit: "checks", text: "on every voucher: ledger, Dr/Cr, GST, TDS, voucher type, bill reference, narration" },
    { figure: "2×", unit: "", text: "the weight on GST and TDS errors, compared with narration slips" },
    { figure: "3", unit: "steps", text: "on the help ladder, ending in a full worked answer so you are never stuck" },
    { figure: "3", unit: "runs", text: "clean in a row before a concept counts as mastered" },
  ],
} as const;

/** The message inside the "Why" preview. Illustrative, and labelled so on the page. */
export const WHY_PREVIEW = {
  label: "Sample feedback",
  batch: "Batch 6 · Purchases",
  result: "Your Trial Balance ties out and the purchase side is clean.",
  praise: "GST heads were right on all 14 vouchers.",
  flag: "Re-look at the TDS base on the Deccan Traders bill.",
  fixed: "Bank charges ledger: FIXED",
  next: "Next up: a mock bank statement.",
} as const;

export type ConceptTile = {
  id: string;
  name: string;
  icon: IconKey;
  /** What the tutor checks for this concept, shown when the tile opens. */
  checks: string;
};

export const CONCEPTS_TITLE = ["We Don’t Believe in Guesswork...", "And We Check Every Voucher."] as const;

export const CONCEPTS: readonly ConceptTile[] = [
  { id: "sales", name: "Sales", icon: "sales", checks: "Party and sales ledgers, Dr/Cr direction, the GST head and rate, and a bill reference on every invoice." },
  { id: "purchase", name: "Purchase", icon: "purchase", checks: "Expense or asset classification, input GST head and rate, and a bill reference the payment can settle." },
  { id: "bank", name: "Bank", icon: "bank", checks: "Receipts, payments and contras posted to the right ledgers, straight from a mock bank statement." },
  { id: "gst", name: "GST", icon: "gst", checks: "The head and the rate on every taxable voucher. GST errors carry double weight." },
  { id: "tds", name: "TDS", icon: "tds", checks: "Section, rate and base amount on every deduction. TDS errors carry double weight." },
  { id: "assets", name: "Fixed Assets", icon: "assets", checks: "Capital purchases classified to the asset ledger, not buried in expenses." },
  { id: "payables", name: "Payables", icon: "payables", checks: "Bill-by-bill references, so a payment settles the bill or advance it belongs to." },
  { id: "receivables", name: "Receivables", icon: "receivables", checks: "Receipts matched to the invoice or advance they clear, never parked as a new reference." },
  { id: "journal", name: "Journal", icon: "journal", checks: "The right voucher type, and a narration that explains why the entry exists." },
];

export type BuiltBlock = {
  id: string;
  number: string;
  title: string;
  body: string;
};

export const BUILT_TITLE = "We’re Built Different";

export const BUILT: readonly BuiltBlock[] = [
  {
    id: "rulebook",
    number: "01",
    title: "Rulebook-Grounded",
    body: "Scoring, hints and feedback all come from one source of truth, the Karbon VA House Practices Rulebook. The same entry is judged the same way every time.",
  },
  {
    id: "tally",
    number: "02",
    title: "Real Tally Work",
    body: "You post in your own copy of Tally and upload the exports. No multiple choice, and no retyping answers into a form.",
  },
  {
    id: "mastery",
    number: "03",
    title: "Mastery, Not Luck",
    body: "A concept counts as mastered after three clean runs. One lucky batch never does, and a concept that slips back is caught.",
  },
  {
    id: "yours",
    number: "04",
    title: "Built Around You",
    body: "Each next exercise is generated from your own error history and aimed at whatever you are weakest at right now.",
  },
];

export const CATEGORIES_TITLE = "Training by Category";

export const CATEGORY_CONCEPTS: readonly TrainingCard[] = [
  { id: "c-sales", tag: "Core", pills: ["Sales register", "Bill ref"], title: ["Sales Entries"], discs: ["sales", "gst"] },
  { id: "c-purchase", tag: "Core", pills: ["Purchase register", "Input GST"], title: ["Purchase Entries"], discs: ["purchase", "documents"] },
  { id: "c-bank", tag: "Core", pills: ["Bank statement", "Contra"], title: ["Bank Entries"], discs: ["bank", "journal", "receivables"] },
  { id: "c-gst", tag: "Tax", pills: ["Head and rate", "2× weight"], title: ["GST Postings"], discs: ["gst"] },
  { id: "c-tds", tag: "Tax", pills: ["Section and base", "2× weight"], title: ["TDS Deductions"], discs: ["tds", "payables"] },
  { id: "c-assets", tag: "Ledgers", pills: ["Capital or revenue", "Asset ledger"], title: ["Fixed Assets"], discs: ["assets"] },
  { id: "c-payables", tag: "Ledgers", pills: ["Bill by bill", "Advances"], title: ["Payables"], discs: ["payables", "purchase"] },
  { id: "c-receivables", tag: "Ledgers", pills: ["Receipts", "Advances"], title: ["Receivables"], discs: ["receivables", "sales"] },
  { id: "c-journal", tag: "Core", pills: ["Voucher type", "Narration"], title: ["Journal Entries"], discs: ["journal"] },
];

export const CATEGORY_TOOLS: readonly TrainingCard[] = [
  { id: "t-tally", tag: "Where you post", pills: ["Licensed", "Educational"], title: ["Tally"], discs: ["tally"] },
  { id: "t-daybook", tag: "What you upload", pills: ["XML export", "Every voucher"], title: ["Detailed Day Book"], discs: ["daybook", "tally"] },
  { id: "t-tb", tag: "What ties out", pills: ["XML export", "Tie-out check"], title: ["Trial Balance"], discs: ["trialBalance"] },
  { id: "t-hints", tag: "When stuck", pills: ["3 steps", "Full answer last"], title: ["Help Ladder"], discs: ["hints", "journal", "diagnostic"] },
  { id: "t-aia", tag: "After mastery", pills: ["Bill ingestion", "Sync to Tally"], title: ["AI Accountant"], discs: ["aia", "daybook"] },
];

export type VoiceCard = {
  id: string;
  kind: string;
  topic: string;
  quote: string;
};

export const VOICES_TITLE = "Straight From the Tutor";
export const VOICES_NOTE = "Sample messages, written the way the tutor coaches. Not learner testimonials.";

/** Three columns, in reading order. */
export const VOICES: readonly (readonly VoiceCard[])[] = [
  [
    { id: "result", kind: "Result", topic: "Sales batch", quote: "14 of 15 vouchers clean and your Trial Balance ties out. That is a strong first run." },
    { id: "hint", kind: "Help, step 2", topic: "TDS", quote: "Before you pick a rate, check which section covers a professional fee. The reference video at 04:12 walks through it." },
    { id: "upload", kind: "Validity check", topic: "Upload", quote: "This Day Book is the condensed format, so it cannot be scored yet. Export the Detailed Day Book and send it again." },
  ],
  [
    { id: "flag", kind: "Flag", topic: "GST", quote: "Look again at the tax on the Deccan Traders invoice. Is that supply inside your state or outside it?" },
    { id: "fixed", kind: "Rectification", topic: "Bank", quote: "Bank charges were failing last batch. This time every one landed in the right ledger. Marked FIXED." },
    { id: "praise", kind: "Praise", topic: "Narration", quote: "Your narrations say why, not just what. A reviewer could follow every entry without opening the bill." },
  ],
  [
    { id: "payables", kind: "Flag", topic: "Payables", quote: "This payment went in as a new reference. Which open bill or advance was it meant to settle?" },
    { id: "mastered", kind: "Next step", topic: "Mastery", quote: "GST heads: three clean runs. Mastered. Your next batch moves on to a mock bank statement." },
    { id: "reflect", kind: "Reflection", topic: "Capstone", quote: "Put this month next to your diagnostic. Which mistake from day one did you not make even once?" },
  ],
];

export const FINAL_CTA = {
  title: "ARE YOU IN?",
  cta: { label: "Get started", href: "/login?mode=signup" },
} as const;

export const FOOTER = {
  blurb: "AIA Academy turns B.Com graduates into bookkeepers who can close a real client month in Tally.",
  links: [
    { label: "Home", href: "/#top" },
    { label: "Training tracks", href: "/#tracks" },
    { label: "Concepts", href: "/#concepts" },
    { label: "Log in", href: "/login" },
  ] satisfies readonly SiteLink[],
  copyright: "© 2026 AIA Academy. All rights reserved.",
} as const;

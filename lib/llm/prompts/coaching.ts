import type { ChatMessage } from "@/lib/llm/client";
import type { ScoredField } from "@/lib/schemas/scoring";
import { RULEBOOK_TEXT } from "@/lib/llm/grounding/rulebook";

// Cited bullets (2026-09-16): every bullet carries the ids of the facts it
// restates, and next_note is no longer the model's to write. See
// CoachingModelOutputSchema in lib/schemas/coaching.ts.
const CITED_BULLET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    text: { type: "string" },
    fact_ids: { type: "array", items: { type: "string" } },
  },
  required: ["text", "fact_ids"],
} as const;

const COACHING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    opening_line: { type: "string" },
    went_well: { type: "array", items: CITED_BULLET_SCHEMA },
    needs_work: { type: "array", items: CITED_BULLET_SCHEMA },
  },
  required: ["opening_line", "went_well", "needs_work"],
} as const;

// The REAL Karbon VA House Practices Rulebook v0.2, extracted from the
// source .docx (2026-08-19) — replaced the placeholder that stood in for it
// since Unit 06. Regenerate lib/llm/grounding/rulebook.ts on a new Rulebook
// version rather than editing here.
const RULEBOOK_GROUNDING_PLACEHOLDER = `Grounding reference — Karbon VA House Practices Rulebook v0.2:
${RULEBOOK_TEXT}`;

// Grounded coaching (2026-09-16). The model used to receive loose lists of
// descriptions and write free prose, and a live review of Template595's
// FIRST scored batch claimed a gap was "still recurring, two rounds
// running", reversed the direction of a Sales gap and told the learner there
// was nothing more to send while a correction round was asking for exactly
// that. Prompt instruction alone never held on this file's other guards, so
// the contract is now: a closed list of numbered facts, every bullet cites
// the facts it restates, and generate-coaching.ts checks the citations,
// numbers, identifiers and history words in code before anything is stored.
// The examples below deliberately carry no history ("from before", "again"):
// the model copies the register of its examples.
const SYSTEM_PROMPT = `You are the AIA Academy coaching a B.Com fresher on a Tally bookkeeping exercise
they just submitted. You do not compute correctness: that has already been done
deterministically in code. You are given a numbered list of FACTS. Your only job is
turning those facts into well-written, Socratic-toned feedback prose.

Never state the literal correct answer for anything flagged wrong (e.g. never say
"you should have used IGST not CGST/SGST": that is the answer, not a nudge).
Flagged areas must be concept-level pointers the learner can go re-examine themselves,
phrased like "take another look at how you handled the GST on the purchase entry."

Voice: write like a senior reviewer messaging a trainee they respect. Direct,
specific, warm where earned, and every line teaches something. These excerpts
from the live pilot programme are the register to match:

  "Your TDS is spot on. You deducted on the taxable base, not the gross, and
  picked the right treatment for the professional and contractor bills."

  "When money comes in from a customer, book it to that customer's ledger and
  tie it to the open invoice, not to a brand new ledger. A few receipts landed
  in invented heads, which leaves the customer looking unpaid."

THE FACT CONTRACT (checked in code; output that breaks it is thrown away):
1. State only what the listed facts say. Never introduce a party, ledger, voucher,
   amount, date, rate, section number or any other detail that is not written in a
   fact you cite.
2. Every bullet has fact_ids: the ids (e.g. "I2", "T1") of every fact it restates.
   A bullet with no fact_ids, or with an id that is not listed, is rejected.
3. went_well bullets may cite only praise (P) and fixed (F) facts. needs_work bullets
   may cite only issue (I), unmatched (U), ledger (L), tieout (T), books (B),
   still (S) and missing (M) facts.
4. Every I, U, L, T, B, S and M fact must be cited by at least one needs_work bullet.
   Nothing wrong may be left out. You may merge closely related facts into one
   bullet (for example several Trial Balance ledgers) and cite all of them.
   Praise facts may be merged or left out if there are many.
5. Any number or identifier in a bullet (amounts like Rs 15,000, invoice or bill
   references like INV-012, voucher numbers, dates) must be copied EXACTLY from a fact
   that bullet cites. Do not compute totals, do not round, do not add rates or
   section numbers. A governing principle stated alongside a finding must contain no
   numbers.
6. Do not talk about history. Never use the words again, before, earlier, previous,
   previously, still, recurring, repeated, once more, "last time", "last round",
   "last batch", "last month" or "rounds running", and never imply this happened in
   an earlier submission, UNLESS the bullet cites an F or S fact (or a fact whose
   own text uses that word). This may be the learner's first batch.
7. Do not say what happens next, whether anything is still to be sent, or that the
   learner should upload or send anything. That closing line is written separately
   in code.
8. Never use an em dash anywhere. Use a colon, a comma, or a full stop instead.

Write:
- opening_line: one plain line that orients the learner on what this batch
  showed, in measured words, no inflation. It cites nothing, so it must contain
  no numbers, no identifiers and no history words. NEVER state a score, a
  percentage, a mark out of anything, or a verdict word ("pass", "passes",
  "partial", "fail"). Example shape: "You worked the whole month through, and
  the sales and receipt entries came out clean. GST heads are the area to
  revisit." If the Trial Balance tie-out is reported as matched, do not say or
  imply the Trial Balance was the problem.
- went_well: bullets built from P and F facts. Each names WHAT was right and WHY it
  matters, pilot-style. Never generic encouragement. Empty array if there are no
  P or F facts.
- needs_work: bullets built from the other facts. KEEP the specific identifiers the
  cited facts give (invoice/bill numbers, party names): "take another look at the
  GST treatment on INV-012" is right, "the GST treatment in the relevant
  transactions" is too vague to act on. Tie each bullet to the specific voucher
  or area AND state the governing principle in the same breath (for example:
  "Take another look at the GST on the Coimbatore invoice. The GST head follows
  the customer's state, not habit."), while never naming the learner's exact
  correction outright. Empty array if there are no such facts.

${RULEBOOK_GROUNDING_PLACEHOLDER}

Respond only with JSON matching the provided schema.`;

// Unit 11: qualitative signal for a free-text answer (explain-the-entry or
// ledger review), summarized in plain language only — the coaching prompt
// gets a description of what the subscores mean in practice, never the raw
// 0-100 numbers themselves, so there's no way for the model to accidentally
// quote a number back to the learner (matching this unit's "never raw
// subscores as numbers to the learner" requirement). Each description is
// paired with whether it is good news, which decides its fact kind.
export type QualitativeCoachingSignal = {
  recallDescription: string;
  precisionDescription: string;
  reasoningDescription: string;
  recallStrong: boolean;
  precisionStrong: boolean;
  reasoningStrong: boolean;
};

// A rectification that has something true to say (NEW is dropped before it
// gets here, see describeRectifications in lib/jobs/advance-learner.ts).
export type RectificationNote = { classification: "FIXED" | "STILL_FAILING"; text: string };

// The closed fact ledger (2026-09-16). Ids are P# praise, I# issue,
// U# unmatched voucher, L# ledger set-up finding, T# Trial Balance tie-out,
// B# books reconciliation, F# fixed, S# still failing, M# missing part.
export const COACHING_FACT_KINDS = [
  "praise",
  "issue",
  "unmatched",
  "ledger",
  "tieout",
  "books",
  "fixed",
  "still",
  "missing",
] as const;
export type CoachingFactKind = (typeof COACHING_FACT_KINDS)[number];
export type CoachingFact = { id: string; kind: CoachingFactKind; text: string };

export const FACT_ID_PREFIX: Record<CoachingFactKind, string> = {
  praise: "P",
  issue: "I",
  unmatched: "U",
  ledger: "L",
  tieout: "T",
  books: "B",
  fixed: "F",
  still: "S",
  missing: "M",
};

// overallResult stays on the signal because it still sets the TONE of the
// message (how much rework is ahead), but it is never quoted back: the
// prompt turns it into a plain sentence and bans the verdict words outright
// (2026-09-16, percentages and pass/fail removed from the learner's view).
// weightedScorePercent was removed from this type entirely rather than left
// unused, so no later edit can reintroduce the number by wiring it up again.
export type CoachingSignal = {
  overallResult: "pass" | "partial" | "fail";
  tbTieOut: boolean | null;
  // Ledgers the tie-out could not reconcile, in plain words with the size
  // of the gap (2026-09-09). Empty/absent when the tie-out matched.
  tbMismatchDescriptions?: string[];
  // Concept-level descriptions only — never the internal error code or the
  // literal expected value. e.g. "GST head was miscategorized on the purchase
  // voucher", not "GST_HEAD_WRONG: expected IGST, got CGST".
  incorrectConceptDescriptions: string[];
  correctConceptDescriptions: string[];
  // Day Book vouchers that matched no transaction of the batch, described
  // with date, type, amount and ledgers (2026-09-10). Empty when every
  // voucher was accounted for.
  unmatchedVoucherDescriptions?: string[];
  // Ledger set-up findings, one plain line each (GST ledger with no side,
  // second bank ledger, two ledgers for one party). Empty when clean.
  ledgerFindingDescriptions?: string[];
  // Composite postings the engine accepted (a split or combined voucher
  // whose ledger effect matched). Good news, stated as such.
  compositeDescriptions?: string[];
  // Books reconciliation (2026-09-10): whether every ledger's closing
  // balance agrees with the correct books year to date, and if not which
  // ledgers differ and by how much. null when not evaluated.
  booksReconciliation?: { clean: boolean; descriptions: string[] } | null;
  // Position of this batch in the learner's timeline (0 = the first month),
  // null when unknown. A year-to-date books gap may only be framed as drift
  // from earlier months when there ARE earlier months (2026-09-16).
  batchOrdinal?: number | null;
  // Present only for explain/review exercises — see
  // score-qualitative.ts/combine-scoring. null for plain direct-entry exercises.
  qualitative: QualitativeCoachingSignal | null;
  // Plain-language names of required parts that never arrived before the
  // wait window closed (Unit 11) — empty for a normally-complete submission.
  missingPartDescriptions: string[];
  // Unit 12: history-aware rectification notes for concepts touched by this
  // exercise, already classified in code (rectification.ts) from
  // concept_attempts history, never judged by the LLM. Only FIXED and
  // STILL_FAILING reach here.
  rectifications: RectificationNote[];
};

// The verdict, rendered as tone rather than as a label. The model needs to
// know whether the learner is mostly there or has real rework ahead; it must
// never be handed the word itself, because it parrots labels it is given.
const TONE_BY_RESULT: Record<CoachingSignal["overallResult"], string> = {
  pass: "almost nothing to redo, so keep this short and confident",
  partial: "a mix, several areas right and a few to rework",
  fail: "real rework ahead, so be warm and concrete about where to start",
};

// How each kind of fact should be turned into a bullet. Listed only for the
// kinds present, so the model is never primed about a finding it does not
// have (an "issue from before" example is exactly how history got invented).
const KIND_GUIDANCE: Record<CoachingFactKind, string> = {
  praise: "P (praise): what was handled correctly. went_well only.",
  issue: "I (issue): a concept area with flagged entries. Point at the entries named, state the principle, never the fix.",
  unmatched:
    "U (unmatched): Day Book vouchers that match no transaction of this batch. Name them as given and ask the learner to check whether each is a duplicate, a blank, a reversal or a posting that does not belong.",
  ledger: "L (ledger): ledger set-up findings. Name the ledgers exactly as given.",
  tieout:
    "T (tieout): Trial Balance ledgers whose movement this month does not agree with the correct postings. Name the ledger, the side and the gap exactly as given, never what the figure should be.",
  books:
    "B (books): ledgers whose closing balance differs from the correct books, year to date. Name the ledger, the side and the gap exactly as given, never what the figure should be.",
  fixed: "F (fixed): a concept that was failing in the attempt named in the fact and is right now. Good news, went_well only.",
  still: "S (still): a concept that was failing in the attempt named in the fact and is failing now too. needs_work only.",
  missing: "M (missing): a required part that never arrived. State it plainly.",
};

function buildUserMessage(signal: CoachingSignal, facts: CoachingFact[]): string {
  const kindsPresent = COACHING_FACT_KINDS.filter((kind) => facts.some((fact) => fact.kind === kind));
  const hasHistoryFacts = facts.some((fact) => fact.kind === "fixed" || fact.kind === "still");
  const lines = [
    `How much rework is ahead (for TONE ONLY, never state this, never use the
words pass, passes, partial or fail in your output): ${TONE_BY_RESULT[signal.overallResult]}`,
    signal.tbTieOut === null
      ? null
      : `Trial Balance tie-out: ${signal.tbTieOut ? "matched" : "did not match"}`,
    hasHistoryFacts
      ? "History: only the F and S facts below speak about an earlier attempt, and only bullets citing them may mention it."
      : "History: there are no F or S facts, so say nothing at all about earlier attempts, rounds, batches or months.",
    kindsPresent.length > 0 ? `How to use each kind of fact:\n${kindsPresent.map((kind) => `- ${KIND_GUIDANCE[kind]}`).join("\n")}` : null,
    facts.length > 0
      ? `FACTS (the only things you may state):\n${facts.map((fact) => `[${fact.id}] ${fact.text}`).join("\n")}`
      : "FACTS: none. Write only the opening_line and leave both lists empty.",
  ].filter((line): line is string => line !== null);
  return lines.join("\n\n");
}

export function buildCoachingPrompt(
  signal: CoachingSignal,
  facts: CoachingFact[],
): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(signal, facts) },
    ],
    jsonSchema: {
      name: "coaching_feedback",
      schema: COACHING_JSON_SCHEMA,
    },
  };
}

// The retry names every violation found in code and shows the model its own
// rejected output, so it corrects that output rather than starting over.
export function buildCoachingRetryPrompt(
  signal: CoachingSignal,
  facts: CoachingFact[],
  violations: string[],
  previousOutput: unknown,
): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  const base = buildCoachingPrompt(signal, facts);
  return {
    ...base,
    messages: [
      ...base.messages,
      { role: "assistant", content: JSON.stringify(previousOutput ?? null) },
      {
        role: "user",
        content: `Your previous response was rejected by the fact checker:\n${violations.map((violation) => `- ${violation}`).join("\n")}\nRespond again with corrected JSON matching the schema exactly, keeping to the fact contract.`,
      },
    ],
  };
}

// Field labels used to build the human-readable concept descriptions passed
// into the coaching signal — kept here since it's prompt-adjacent vocabulary.
export const FIELD_CONCEPT_LABELS: Record<ScoredField, string> = {
  account: "the ledger account classification",
  dr_cr: "the Debit/Credit direction",
  amount: "the amount posted",
  voucher_type: "the voucher type used",
  gst: "the GST treatment",
  tds: "the TDS treatment",
  bill_reference: "the bill-by-bill reference",
  narration: "the narration",
};

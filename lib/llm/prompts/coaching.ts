import type { ChatMessage } from "@/lib/llm/client";
import type { ScoredField } from "@/lib/schemas/scoring";
import { RULEBOOK_TEXT } from "@/lib/llm/grounding/rulebook";

const COACHING_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    opening_line: { type: "string" },
    went_well: { type: "array", items: { type: "string" } },
    needs_work: { type: "array", items: { type: "string" } },
    next_note: { type: "string" },
  },
  required: ["opening_line", "went_well", "needs_work", "next_note"],
} as const;

// The REAL Karbon VA House Practices Rulebook v0.2, extracted from the
// source .docx (2026-08-19) — replaced the placeholder that stood in for it
// since Unit 06. Regenerate lib/llm/grounding/rulebook.ts on a new Rulebook
// version rather than editing here.
const RULEBOOK_GROUNDING_PLACEHOLDER = `Grounding reference — Karbon VA House Practices Rulebook v0.2:
${RULEBOOK_TEXT}`;

const SYSTEM_PROMPT = `You are the AIA Academy coaching a B.Com fresher on a Tally bookkeeping exercise
they just submitted. You do not compute correctness — that has already been done
deterministically in code and is given to you as a scoring result. Your only job is
turning that already-computed signal into well-written, Socratic-toned feedback prose.

Never state the literal correct answer for anything flagged wrong (e.g. never say
"you should have used IGST not CGST/SGST" — that is the answer, not a nudge).
Flagged areas must be concept-level pointers the learner can go re-examine themselves,
phrased like "take another look at how you handled the GST on the purchase entry."

Voice: write like a senior reviewer messaging a trainee they respect. Direct,
specific, warm where earned, and every line teaches something. These excerpts
from the live pilot programme are the exact register to match:

  "Your TDS is spot on. You deducted on the taxable base every time, not the
  gross, and picked the right sections and rates for the professional,
  contractor and rent bills."

  "When money comes in from a customer, book it to that customer's ledger and
  tie it to the open invoice, not to a brand new ledger. A few receipts landed
  in invented heads, which leaves the customer looking unpaid."

  "You got the thresholds right too, leaving Sharma Legal and the housekeeping
  bill without TDS where the limits were not crossed."

Hard formatting rule: never use an em dash anywhere in your output. Use a
colon, a comma, or a full stop instead.

Write, in order:
- opening_line: one plain line that OPENS WITH THE SCORE, using the weighted
  score percentage from the signal below, measured framing, no inflation.
  Example shape: "Your submission came in at 63 percent. A solid first pass
  with real strengths to build on." State the result's actual cause honestly:
  if the Trial Balance tie-out is reported as matched below, the submission
  did not fall short because of the Trial Balance, so do not say or imply it did.
- went_well: bullet points, each specific and explanatory, tied to what the
  signal lists as correctly handled. Each bullet names WHAT was right and WHY
  it matters, pilot-style. Never generic encouragement, never praise for
  anything the signal does not list. Empty array only if nothing was correct.
- needs_work: bullet points drawn only from what the signal says was wrong.
  At most 4 entries and never more than the number of areas listed in the
  signal: one entry per listed area, restated in your own words. KEEP the
  specific identifiers the signal gives (invoice/bill numbers, party names):
  "take another look at the GST treatment on INV-012" is right, "the GST
  treatment in the relevant transactions" is too vague to act on and is not
  acceptable. Each bullet ties to the specific voucher or area AND states the
  governing principle in the same breath (for example: "Take another look at
  the GST on the Coimbatore invoice. The GST head follows the customer's
  state, not habit."), while still never naming the learner's exact correction
  outright. Do not split one listed area into several entries.
  Empty array if nothing was wrong.
- next_note: one closing line on what happens next.

If free-text answer quality signal is given below, describe it in plain language only
(e.g. "you caught most of the real issues, but flagged one entry that was actually
correct") — never state a recall/precision/reasoning number or the word "score."

State only what the scoring signal below actually says. Never introduce a fact it
does not contain. In particular:
- If no missing parts are listed below, the submission was complete. Do not say or
  imply that anything was missing, never arrived, or is still to be sent, and do not
  ask the learner to send anything further for this submission.
- Do not praise or comment on any area that is not listed under "Correctly handled"
  or "Concepts to flag" below. If GST, TDS, bill references, or narration are not
  listed, this exercise did not test them — saying the learner handled them well is
  false.
When missing parts ARE listed below, say so plainly in next_note — never
silently omit that a part didn't arrive.

If rectification notes are given below, weave each in as its own short plain
bullet inside went_well (a FIXED concept is good news) or needs_work (a STILL
FAILING recurrence). Never invent a new section. Example phrasing: "Good news:
the GST classification issue from before is fixed" or "The bill reference issue
is still showing up, worth a closer look." A NEW first-time failure needs no
special callout beyond the normal needs_work treatment; only FIXED and STILL
FAILING are rectification events.

${RULEBOOK_GROUNDING_PLACEHOLDER}

Respond only with JSON matching the provided schema.`;

// Unit 11: qualitative signal for a free-text answer (explain-the-entry or
// ledger review), summarized in plain language only — the coaching prompt
// gets a description of what the subscores mean in practice, never the raw
// 0-100 numbers themselves, so there's no way for the model to accidentally
// quote a number back to the learner (matching this unit's "never raw
// subscores as numbers to the learner" requirement).
export type QualitativeCoachingSignal = {
  recallDescription: string;
  precisionDescription: string;
  reasoningDescription: string;
};

export type CoachingSignal = {
  overallResult: "pass" | "partial" | "fail";
  tbTieOut: boolean | null;
  weightedScorePercent: number | null;
  // Concept-level descriptions only — never the internal error code or the
  // literal expected value. e.g. "GST head was miscategorized on the purchase
  // voucher", not "GST_HEAD_WRONG: expected IGST, got CGST".
  incorrectConceptDescriptions: string[];
  correctConceptDescriptions: string[];
  // Present only for explain/review exercises — see
  // score-qualitative.ts/combine-scoring. null for plain direct-entry exercises.
  qualitative: QualitativeCoachingSignal | null;
  // Plain-language names of required parts that never arrived before the
  // wait window closed (Unit 11) — empty for a normally-complete submission.
  missingPartDescriptions: string[];
  // Unit 12: history-aware rectification notes for concepts touched by this
  // exercise — plain-language, already classified in code (rectification.ts)
  // from concept_attempts history, never judged by the LLM. Empty when no
  // concept touched this exercise qualifies (a first attempt that passed, or
  // steady repeat-pass progress with no prior failure).
  rectificationDescriptions: string[];
};

function buildUserMessage(signal: CoachingSignal): string {
  const lines = [
    `Overall result: ${signal.overallResult}`,
    signal.tbTieOut === null
      ? null
      : `Trial Balance tie-out: ${signal.tbTieOut ? "matched" : "did not match"}`,
    signal.weightedScorePercent === null
      ? null
      : `Weighted score: ${signal.weightedScorePercent} percent. This number IS learner-visible: open the opening_line with it.`,
    signal.correctConceptDescriptions.length > 0
      ? `Correctly handled: ${signal.correctConceptDescriptions.join("; ")}`
      : "Correctly handled: nothing notable",
    // Already grouped by field and capped in generate-coaching.ts — each entry
    // is one area, with its affected transactions named inside it. The model
    // must not re-expand these back into per-transaction bullets.
    signal.incorrectConceptDescriptions.length > 0
      ? `Concepts to flag (${signal.incorrectConceptDescriptions.length} area(s), concept-level only, do not state the fix). Produce exactly one flagged_areas entry per area listed here, no more: ${signal.incorrectConceptDescriptions.join("; ")}`
      : "Concepts to flag: none — this was a clean pass",
    signal.qualitative
      ? `Free-text answer quality — recall: ${signal.qualitative.recallDescription}; precision: ${signal.qualitative.precisionDescription}; reasoning: ${signal.qualitative.reasoningDescription}. Weave this into flagged_areas/praise in plain language — never state these as numbers or scores.`
      : null,
    // Stated explicitly in both directions: leaving the complete case silent
    // invites the model to invent a missing part that never existed.
    signal.missingPartDescriptions.length > 0
      ? `Parts that never arrived before scoring: ${signal.missingPartDescriptions.join("; ")}. Mention this plainly in next_note.`
      : "Submission completeness: complete — every required part arrived. Do not suggest anything is missing or still to be sent.",
    signal.rectificationDescriptions.length > 0
      ? `Rectification notes (already classified in code — state each as a short, plain line, e.g. "Good news — the GST classification issue from before is fixed"): ${signal.rectificationDescriptions.join("; ")}`
      : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function buildCoachingPrompt(signal: CoachingSignal): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(signal) },
    ],
    jsonSchema: {
      name: "coaching_feedback",
      schema: COACHING_JSON_SCHEMA,
    },
  };
}

export function buildCoachingRetryPrompt(
  signal: CoachingSignal,
  validationError: string,
): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  const base = buildCoachingPrompt(signal);
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: "user",
        content: `Your previous response failed schema validation with this error: ${validationError}. Respond again with corrected JSON matching the schema exactly.`,
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

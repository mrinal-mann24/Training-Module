import type { ChatMessage } from "@/lib/llm/client";
import { VIDEO_MODULE_LIST_BLOCK } from "@/lib/llm/grounding/video-modules";
import type { AnswerKey } from "@/lib/schemas/exercise";
import type { HintStep } from "@/lib/schemas/hint";

const HINT_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    rung: { type: "integer", enum: [1, 2, 3] },
    hint_text: { type: "string" },
    concept_tag: { type: "string" },
  },
  required: ["rung", "hint_text", "concept_tag"],
} as const;

// Phase 3 (spec 15): the manager's 3-step query response. Each step
// escalates how much help is given; only step 3 hands over the answer. The
// raw answer_key object structure itself is never returned to the client —
// only this composed prose is, and only after it passes Zod validation.
const STEP_INSTRUCTIONS: Record<HintStep, string> = {
  1: `Step 1 — Video module pointer. Refer the learner to the ONE most relevant
video module from the registry below, by its exact title, plus one short
guiding question to hold in mind while watching (e.g. 'Watch "Book a sales
invoice (intra and inter-state GST)". As you do, ask yourself: whose state
drives the tax?'). Do not explain the concept, do not name the correct
account, amount, or any specific value — the module and the question are the
whole hint. Set concept_tag to the specific accounting concept this points
at.`,
  2: `Step 2 — Indirect hint. Flag WHAT needs rework without giving the answer:
point at the specific transaction area and the kind of mistake to look for
("look again at how you split the tax on the Karnataka sale — check which
state the customer is in"), so the learner knows where to dig. Never state
the correct account, amount, head, or section.`,
  3: `Step 3 — Direct answer with explanation. Give the complete, correct
answer for this specific exercise's relevant transaction(s): the correct
account, Dr/Cr, amount, and any GST/TDS/bill-reference treatment that
applies. Then explain the underlying concept in crisp, simple language a
B.Com fresher follows on first read. End with one check-for-understanding
question asking the learner to explain back why it works, so they don't just
copy it. This must genuinely be the full answer — do not hedge or stop short
of the actual figures.`,
};

function buildAnswerKeyContext(answerKey: AnswerKey): string {
  return JSON.stringify(answerKey.entries, null, 2);
}

// Pack mode (2026-08-27): a full-month pack exercise has ~100 authored
// transactions and the help button carries no signal about WHICH one the
// learner is stuck on — handing the raw key to the LLM made step 3 solve a
// RANDOM transaction, leaking the authored answer key one entry per click.
// In pack mode the key is withheld entirely; the model only sees this
// derived summary, so it cannot quote a figure it never received.
export function summarizePackAnswerKey(answerKey: AnswerKey): {
  transaction_count: number;
  voucher_types: Record<string, number>;
  concept_areas: string[];
} {
  const seenSequences = new Set<number>();
  const voucherTypes: Record<string, number> = {};
  const concepts = new Set<string>();
  for (const entry of answerKey.entries) {
    if (!seenSequences.has(entry.sequence)) {
      seenSequences.add(entry.sequence);
      voucherTypes[entry.voucher_type] =
        (voucherTypes[entry.voucher_type] ?? 0) + 1;
    }
    for (const tag of entry.concept_tags) {
      concepts.add(tag);
    }
  }
  return {
    transaction_count: seenSequences.size,
    voucher_types: voucherTypes,
    concept_areas: [...concepts].sort(),
  };
}

const PACK_MODE_INSTRUCTIONS = `PACK MODE: the learner is working a full-month practice set with many
transactions, and you do NOT know which entry they are stuck on. The set's
answer key is withheld from you; you only see a summary of what it covers.
Never present any specific party, amount, or figure as "the answer" to an
entry in this set. Adjust the steps accordingly:
- Step 2 in pack mode: name the areas of a set like this that need the most
  care (choose from the concept areas in the summary) and ask the learner
  which entry they are stuck on.
- Step 3 in pack mode: pick the trickiest concept area from the summary and
  teach the METHOD with one small invented example (invented party names and
  round numbers, clearly not from the set). Close by inviting the learner to
  type which specific entry is blocking them, so you can point them at the
  exact rule it needs.`;

const SYSTEM_PROMPT_PREFIX = `You are the AIA Academy giving one step of a 3-step help flow to a B.Com fresher
stuck on a Tally bookkeeping exercise. You are given the exercise scenario and
its hidden answer key for grounding — the answer key itself must never appear
in your output verbatim or be quoted as JSON; compose it into natural help
prose appropriate to the requested step's disclosure level.
Never use an em dash anywhere in hint_text; use a colon, comma, or full stop.
Respond only with JSON matching the provided schema, with "rung" set to the
requested step number.`;

export type HintPromptContext = {
  rung: HintStep;
  scenario: string;
  transactions: { sequence: number; description: string }[];
  answerKey: AnswerKey;
  // True for authored pack exercises (files-based, ~100 transactions): the
  // answer key is summarized instead of passed, and steps 2-3 shift to
  // area-naming and method-teaching. See PACK_MODE_INSTRUCTIONS.
  packMode: boolean;
};

function buildSystemPrompt(rung: HintStep, packMode: boolean): string {
  const packBlock = packMode ? `\n\n${PACK_MODE_INSTRUCTIONS}` : "";
  return `${SYSTEM_PROMPT_PREFIX}\n\n${STEP_INSTRUCTIONS[rung]}${packBlock}`;
}

function buildUserMessage(context: HintPromptContext): string {
  const registryBlock = `Video module registry (for step-1 pointers — always name a module by its exact title from this list, never invent one):\n${VIDEO_MODULE_LIST_BLOCK}`;
  const transactionLines = context.transactions
    .map((transaction) => `${transaction.sequence}. ${transaction.description}`)
    .join("\n");
  const groundingBlock = context.packMode
    ? `What this practice set covers (summary only; the answer key itself is withheld in pack mode):\n${JSON.stringify(summarizePackAnswerKey(context.answerKey), null, 2)}`
    : `Hidden answer key (grounding only, never repeat verbatim):\n${buildAnswerKeyContext(context.answerKey)}`;

  return `Exercise scenario:\n${context.scenario}\n\nTransactions:\n${transactionLines}\n\n${registryBlock}\n\n${groundingBlock}\n\nGenerate step ${context.rung} for this exercise.`;
}

export function buildHintPrompt(context: HintPromptContext): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      {
        role: "system",
        content: buildSystemPrompt(context.rung, context.packMode),
      },
      { role: "user", content: buildUserMessage(context) },
    ],
    jsonSchema: {
      name: "hint",
      schema: HINT_JSON_SCHEMA,
    },
  };
}

export function buildHintRetryPrompt(
  context: HintPromptContext,
  validationError: string,
): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  const base = buildHintPrompt(context);
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

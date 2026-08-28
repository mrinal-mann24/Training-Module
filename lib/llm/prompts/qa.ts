import type { ChatMessage } from "@/lib/llm/client";
import { RULEBOOK_TEXT } from "@/lib/llm/grounding/rulebook";
import { MODULE_DOCS } from "@/lib/llm/grounding/module-docs";
import { VIDEO_MODULE_LIST_BLOCK } from "@/lib/llm/grounding/video-modules";

const MODULE_DOCS_BLOCK = Object.entries(MODULE_DOCS)
  .map(([name, text]) => `--- ${name} ---\n${text}`)
  .join("\n\n");

const QA_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
  },
  required: ["answer"],
} as const;

// Unit 15R: free-form tutor Q&A, modeled on the pilot program's chat — a
// learner asks "which ledger will payment made for background check of
// employee come under?" and gets a direct, grounded answer ("Dr Recruitment
// Charges / Dr Input / Cr TDS on Professional Charges / Cr vendor"), or asks
// a concept question ("two GST rates on one invoice?") and gets a practical
// Tally-grounded explanation.
//
// The one hard boundary: the ACTIVE exercise's own transactions must not be
// solved for the learner — that is the 3-step help flow's job (step 3
// eventually gives the answer, but only through the flow's progression). General
// concept/ledger/procedure questions are answered directly and completely,
// exactly like the pilot's reviewers did.
const SYSTEM_PROMPT = `You are the AIA Academy for a bookkeeping training programme, answering a learner's
free-form question in chat. Learners are B.Com freshers working practical Tally
exercises. Your reviewers' voice: direct, practical, specific — like a senior
accountant answering a junior's question in a work chat. Answer the question
actually asked; don't lecture around it.

Two kinds of question, treated differently:
1. General concept, ledger-selection, GST/TDS, or Tally-procedure questions
   ("which ledger for a background check payment?", "how do I invoice two GST
   rates on one bill?") — answer directly and completely, including the exact
   ledgers/Dr-Cr structure where relevant. This is what the House Practices
   Rulebook below is for; follow it, and cite the relevant rule section number
   inline when one clearly applies (e.g. "per Rulebook 13").
2. Questions asking you to solve a specific transaction of their CURRENT
   exercise ("what do I post for transaction 3?", "is INV-012 IGST or CGST?")
   — do NOT give the answer. Point them at the concept and the Rulebook
   section they need and remind them the "I'm stuck" help flow walks them
   there in three steps: first the right video module to watch, then a
   pointed hint, then the full answer with the explanation. Never state the
   specific posting for a current-exercise transaction.

If the question is not about accounting, Tally, or the training programme,
say briefly that you can only help with the training and its accounting
content.

Reference — Karbon VA House Practices Rulebook v0.2:
${RULEBOOK_TEXT}

Video module registry (when a question is really "where do I learn this?",
name the matching module by its exact title from this list):
${VIDEO_MODULE_LIST_BLOCK}

Reference — VA Training Module docs (ground concept explanations in these):
${MODULE_DOCS_BLOCK}

Never use an em dash anywhere in the text you produce; use a colon, comma, or full stop.

Respond only with JSON matching the provided schema.`;

export type QaContext = {
  question: string;
  // The active exercise's learner-facing scenario text (never the answer
  // key) so "current exercise" questions can be recognized as such. Null
  // when no exercise is active.
  exerciseScenario: string | null;
};

export function buildQaPrompt(context: QaContext): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  const exerciseBlock = context.exerciseScenario
    ? `Their current exercise (for recognizing rule-2 questions — never solve its transactions):\n${context.exerciseScenario}\n\n`
    : "";
  return {
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `${exerciseBlock}Learner's question: ${context.question}`,
      },
    ],
    jsonSchema: { name: "qa_response", schema: QA_JSON_SCHEMA },
  };
}

export function buildQaRetryPrompt(
  context: QaContext,
  validationError: string,
): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  const base = buildQaPrompt(context);
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

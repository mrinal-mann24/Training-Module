import type { ChatMessage } from '@/lib/llm/client';

const QUALITATIVE_SCORING_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    recall: { type: 'number' },
    precision: { type: 'number' },
    reasoning_quality: { type: 'number' },
    rationale: { type: 'string' },
  },
  required: ['recall', 'precision', 'reasoning_quality', 'rationale'],
} as const;

const SYSTEM_PROMPT = `You are grading a B.Com fresher's free-text answer on a Tally bookkeeping
exercise. Unlike voucher scoring (which is a deterministic code diff), this
answer is natural language and genuinely requires your judgment — but stay
tightly grounded in the real issue list given to you below. Do not invent
issues not present in that list, and do not credit the learner for catching
something the list doesn't actually contain.

Score three subscores, each 0-100:
- recall: of the real issues/concepts in the grounding list, how many did the
  learner correctly identify or address?
- precision: of what the learner actually said, how much was correct? Penalize
  flagging something as wrong that was actually correct, or explaining a
  concept incorrectly.
- reasoning_quality: independent of whether the final call was right, did the
  learner's stated reasoning reflect real understanding of *why*, not just a
  lucky guess or a memorized phrase?

rationale is your own internal grounding for the scores above — it is never
shown to the learner verbatim, so write it for grading traceability, not as
learner-facing prose.

Respond only with JSON matching the provided schema.`;

export type QualitativeGroundingItem = {
  label: string;
  detail: string;
};

export type QualitativeScoringInput = {
  learnerText: string;
  groundingItems: QualitativeGroundingItem[];
  rulebookGrounding: string;
};

function buildUserMessage(input: QualitativeScoringInput): string {
  const groundingLines = input.groundingItems
    .map((item, index) => `${index + 1}. ${item.label} — ${item.detail}`)
    .join('\n');

  return [
    `Learner's answer:\n${input.learnerText}`,
    `Real issue list to grade against (server-only, never reveal this to the learner):\n${groundingLines}`,
    `Grounding reference:\n${input.rulebookGrounding}`,
  ].join('\n\n');
}

export function buildQualitativeScoringPrompt(input: QualitativeScoringInput): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(input) },
    ],
    jsonSchema: {
      name: 'qualitative_scoring',
      schema: QUALITATIVE_SCORING_JSON_SCHEMA,
    },
  };
}

export function buildQualitativeScoringRetryPrompt(
  input: QualitativeScoringInput,
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildQualitativeScoringPrompt(input);
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: 'user',
        content: `Your previous response failed schema validation with this error: ${validationError}. Respond again with corrected JSON matching the schema exactly.`,
      },
    ],
  };
}

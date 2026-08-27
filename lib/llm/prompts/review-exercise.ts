import type { ChatMessage } from '@/lib/llm/client';
import type { ExerciseDifficultyLevel, ExerciseVariant } from '@/lib/schemas/exercise';

const REVIEW_EXERCISE_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    scenario: { type: 'string' },
    packet_items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          sequence: { type: 'integer' },
          presented_text: { type: 'string' },
        },
        required: ['sequence', 'presented_text'],
      },
    },
    difficulty_level: { type: 'string', enum: ['L0', 'L1', 'L2', 'L3', 'L4'] },
    variant: { type: 'string', enum: ['A', 'B'] },
  },
  required: ['scenario', 'packet_items', 'difficulty_level', 'variant'],
} as const;

const SYSTEM_PROMPT = `You are producing the learner-facing text for an open ledger review exercise.
The learner will read a numbered packet of line items and judge, in free text,
which ones look wrong and why. You are NOT deciding which items are anomalies —
that has already been decided for you. Your only job is turning the raw source
material below into natural, realistic-sounding ledger-entry descriptions, in
the exact order given, one presented_text per packet item, at the matching
sequence number. Do not add, remove, reorder, or merge items. Do not hint at
which ones are wrong — write every item in the same neutral, factual tone
regardless of whether it's flagged as an anomaly in your source material.

Never use an em dash anywhere in the text you produce; use a colon, comma, or full stop.

Respond only with JSON matching the provided schema. The scenario field is a
short framing paragraph (e.g. "Review this month's purchase ledger for [Company]
and flag anything that looks off."). variant should be "A".`;

export type ReviewSourceItem = {
  sequence: number;
  isAnomaly: boolean;
  sourceDescription: string;
};

export type ReviewExercisePromptParams = {
  difficultyLevel: ExerciseDifficultyLevel;
  variant: ExerciseVariant;
  items: ReviewSourceItem[];
};

function buildUserMessage(params: ReviewExercisePromptParams): string {
  const lines = params.items
    .map((item) => `${item.sequence}. [${item.isAnomaly ? 'ANOMALY' : 'CLEAN'}] ${item.sourceDescription}`)
    .join('\n');
  return `Difficulty level: ${params.difficultyLevel}\n\nSource material (internal — never reveal the ANOMALY/CLEAN tags to the learner):\n${lines}`;
}

export function buildReviewExercisePrompt(params: ReviewExercisePromptParams): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildUserMessage(params) },
    ],
    jsonSchema: {
      name: 'review_exercise',
      schema: REVIEW_EXERCISE_JSON_SCHEMA,
    },
  };
}

export function buildReviewExerciseRetryPrompt(
  params: ReviewExercisePromptParams,
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildReviewExercisePrompt(params);
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

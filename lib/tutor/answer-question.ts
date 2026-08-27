import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import { buildQaPrompt, buildQaRetryPrompt, type QaContext } from '@/lib/llm/prompts/qa';
import { QaResponseSchema, type QaResponse } from '@/lib/schemas/qa';

const MAX_ATTEMPTS = 3;

// Unit 15R: answers a learner's free-form chat question. Same bounded-retry
// + Zod-validation discipline as every other LLM call in this codebase. The
// context deliberately has no answer-key field — the prompt is grounded in
// the Rulebook plus the learner-facing scenario text only.
export async function answerQuestion(learnerId: string, context: QaContext): Promise<QaResponse> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null ? buildQaPrompt(context) : buildQaRetryPrompt(context, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'qa-response',
      learnerId,
      callType: 'qa-response',
    });

    const parsed = QaResponseSchema.safeParse(raw);

    if (parsed.success) {
      return parsed.data;
    }

    lastError = parsed.error.message;
  }

  throw new Error(`Q&A response failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

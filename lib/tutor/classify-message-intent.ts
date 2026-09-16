import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildMessageIntentPrompt,
  buildMessageIntentRetryPrompt,
  type MessageIntentContext,
} from '@/lib/llm/prompts/message-intent';
import { MessageIntentSchema } from '@/lib/schemas/message-intent';

// Two attempts, not the usual three: this call sits in front of the learner's
// reply, and a third attempt cannot fit inside the timeout anyway.
const MAX_ATTEMPTS = 2;
export const INTENT_TIMEOUT_MS = 4000;

export type IntentFallback = 'timeout' | 'invalid' | 'error';

export type ClassifiedIntent =
  | { intent: 'question' | 'answer'; source: 'llm' }
  | { intent: 'question'; source: 'fallback'; fallback: IntentFallback };

export type ClassifyMessageIntentDeps = {
  // Injected in tests; production uses the traced OpenRouter completion.
  complete?: typeof getTracedStructuredCompletion;
  timeoutMs?: number;
};

async function attempt(
  complete: typeof getTracedStructuredCompletion,
  learnerId: string,
  context: MessageIntentContext,
): Promise<ClassifiedIntent> {
  let lastError: string | null = null;
  try {
    for (let run = 1; run <= MAX_ATTEMPTS; run++) {
      const { messages, jsonSchema } =
        lastError === null
          ? buildMessageIntentPrompt(context)
          : buildMessageIntentRetryPrompt(context, lastError);

      const raw = await complete({
        messages,
        jsonSchema,
        traceName: 'message-intent',
        learnerId,
        callType: 'message-intent',
        // An empty env value must fall back to OPENROUTER_MODEL, not send "".
        model: process.env.OPENROUTER_INTENT_MODEL || undefined,
        extraMetadata: { expectedPart: context.expectedPart, textChars: context.text.length },
      });

      const parsed = MessageIntentSchema.safeParse(raw);
      if (parsed.success) {
        return { intent: parsed.data.intent, source: 'llm' };
      }
      lastError = parsed.error.message;
    }
    return { intent: 'question', source: 'fallback', fallback: 'invalid' };
  } catch {
    return { intent: 'question', source: 'fallback', fallback: 'error' };
  }
}

/**
 * Smart Send tie-break: asks the model whether a message the rules could not
 * place is a question or an attempt at the pending explain/review part.
 *
 * Never throws, and every failure (invalid output twice, a thrown error, or
 * no reply within the timeout) resolves to "question". That direction is
 * the safe one: a question answered by mistake costs one reply, while text
 * wrongly treated as an answer would reach scoring, which cannot be undone.
 * Even an "answer" verdict files nothing; the learner confirms first.
 *
 * The timeout races the call rather than cancelling it (the OpenRouter client
 * has no abort), so a slow reply still completes and is still billed.
 */
export async function classifyMessageIntent(
  learnerId: string,
  context: MessageIntentContext,
  deps: ClassifyMessageIntentDeps = {},
): Promise<ClassifiedIntent> {
  const complete = deps.complete ?? getTracedStructuredCompletion;
  const timeoutMs = deps.timeoutMs ?? INTENT_TIMEOUT_MS;

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ClassifiedIntent>((resolve) => {
    timer = setTimeout(() => resolve({ intent: 'question', source: 'fallback', fallback: 'timeout' }), timeoutMs);
  });

  try {
    return await Promise.race([attempt(complete, learnerId, context), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

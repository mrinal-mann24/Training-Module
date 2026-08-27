import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import { buildHintPrompt, buildHintRetryPrompt, type HintPromptContext } from '@/lib/llm/prompts/hint';
import { HintSchema, type Hint } from '@/lib/schemas/hint';

const MAX_ATTEMPTS = 3;

export async function generateHint(learnerId: string, context: HintPromptContext): Promise<Hint> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null ? buildHintPrompt(context) : buildHintRetryPrompt(context, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'hint-generation',
      learnerId,
      callType: 'hint-generation',
      extraMetadata: { rung: context.rung },
    });

    const parsed = HintSchema.safeParse(raw);

    if (parsed.success) {
      return parsed.data;
    }

    lastError = parsed.error.message;
  }

  throw new Error(`Hint generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}

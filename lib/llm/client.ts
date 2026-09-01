const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type StructuredCompletionParams = {
  messages: ChatMessage[];
  jsonSchema: {
    name: string;
    schema: Record<string, unknown>;
  };
  // Per-call model override (2026-09-01): source-document generation runs on
  // a faster model than coaching/batch design — see OPENROUTER_DOCUMENT_MODEL.
  // Falls back to OPENROUTER_MODEL when unset.
  model?: string;
};

// Thin fetch-based OpenRouter client (no SDK dependency — OpenRouter's API is
// OpenAI-compatible REST, so a wrapper is simpler than pulling in an SDK).
// Model is pinned via OPENROUTER_MODEL so it can change without a code change.
// The pinned model must support forced structured output (response_format:
// json_schema) — confirm this on OpenRouter's model page before changing it.
export async function getStructuredCompletion(
  params: StructuredCompletionParams,
): Promise<unknown> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = params.model ?? process.env.OPENROUTER_MODEL;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }
  if (!model) {
    throw new Error('OPENROUTER_MODEL is not set.');
  }

  const response = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: params.messages,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: params.jsonSchema.name,
          strict: true,
          schema: params.jsonSchema.schema,
        },
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = data.choices[0]?.message.content;
  if (!content) {
    throw new Error('OpenRouter response contained no message content.');
  }

  return JSON.parse(extractJsonPayload(content)) as unknown;
}

// Some models return the JSON wrapped in a markdown code fence despite the
// json_schema response_format (observed live 2026-09-01: Claude Sonnet 5 via
// OpenRouter returned "```json\n{...}\n```", raw JSON.parse threw
// "Unexpected token '`'", and Inngest retried the whole generation step —
// three multi-minute attempts). Strip a single wrapping fence; leave
// anything else untouched so genuine malformed output still fails loudly.
function extractJsonPayload(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

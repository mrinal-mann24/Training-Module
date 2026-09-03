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

// Token/cost accounting per call (2026-09-01): OpenRouter reports prompt/
// completion tokens and, with usage accounting enabled, the actual USD cost
// it charged — captured so Langfuse can attribute spend per call type,
// model, and learner. All fields null when the provider omits them.
export type StructuredCompletionUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  costUsd: number | null;
};

export type StructuredCompletionResult = {
  output: unknown;
  // The model that actually served the call (OpenRouter echoes the resolved
  // id), falling back to the requested one.
  model: string;
  usage: StructuredCompletionUsage;
};

// Thin fetch-based OpenRouter client (no SDK dependency — OpenRouter's API is
// OpenAI-compatible REST, so a wrapper is simpler than pulling in an SDK).
// Model is pinned via OPENROUTER_MODEL so it can change without a code change.
// The pinned model must support forced structured output (response_format:
// json_schema) — confirm this on OpenRouter's model page before changing it.
export async function getStructuredCompletion(
  params: StructuredCompletionParams,
): Promise<StructuredCompletionResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  const model = params.model ?? process.env.OPENROUTER_MODEL;

  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set.');
  }
  if (!model) {
    throw new Error('OPENROUTER_MODEL is not set.');
  }

  // The schema is ALSO stated in-band as a final system message: OpenRouter
  // only natively enforces response_format json_schema for some providers
  // (OpenAI models complied; Claude Sonnet 5 demonstrably never saw the
  // schema — observed live 2026-09-01 as three consecutive generations with
  // invented field names, every transactions[].sequence/description missing
  // and difficulty_level in the wrong format, burning ~7 minutes of retries).
  // With the schema in the prompt, the exact key names reach the model
  // regardless of provider-side enforcement; response_format stays on for
  // providers that do enforce it.
  const messagesWithSchema = [
    ...params.messages,
    {
      role: 'system' as const,
      content: `Your entire response must be a SINGLE JSON object — no markdown fences, no commentary — that validates against this JSON Schema exactly, using these exact key names and including every required field:\n${JSON.stringify(params.jsonSchema.schema)}`,
    },
  ];

  // Transient failures — an empty message (seen live 2026-09-03 regenerating
  // Praveen's Level 6: "OpenRouter response contained no message content"
  // on the first and only attempt), a 429/5xx, a dropped connection — are
  // retried a few times with a short backoff before the caller's own
  // validation retries or the job step fails. Non-transient errors (4xx
  // other than 429, invalid JSON) surface immediately.
  const TRANSIENT_ATTEMPTS = 3;
  let lastTransient: Error | null = null;
  type OpenRouterResponse = {
    model?: string;
    choices: Array<{ message: { content: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      cost?: number;
    };
  };
  let data: OpenRouterResponse | null = null;
  let content: string | undefined;

  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: messagesWithSchema,
          // OpenRouter usage accounting: include the actual charged cost (USD)
          // in the response's usage block, alongside token counts.
          usage: { include: true },
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
    } catch (error) {
      lastTransient = error instanceof Error ? error : new Error(String(error));
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      continue;
    }

    if (!response.ok) {
      const body = await response.text();
      const transient = response.status === 429 || response.status >= 500;
      if (!transient) {
        throw new Error(`OpenRouter request failed (${response.status}): ${body}`);
      }
      lastTransient = new Error(`OpenRouter request failed (${response.status}): ${body.slice(0, 300)}`);
      await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      continue;
    }

    data = (await response.json()) as OpenRouterResponse;
    content = data?.choices[0]?.message.content;
    if (content) {
      break;
    }
    lastTransient = new Error('OpenRouter response contained no message content.');
    await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
  }

  if (!content || !data) {
    throw lastTransient ?? new Error('OpenRouter response contained no message content.');
  }

  return {
    output: JSON.parse(extractJsonPayload(content)) as unknown,
    model: data.model ?? model,
    usage: {
      promptTokens: data.usage?.prompt_tokens ?? null,
      completionTokens: data.usage?.completion_tokens ?? null,
      totalTokens: data.usage?.total_tokens ?? null,
      costUsd: data.usage?.cost ?? null,
    },
  };
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

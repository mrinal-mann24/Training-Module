import { Langfuse } from 'langfuse';
import { getStructuredCompletion, type StructuredCompletionParams } from './client';

const langfuse = new Langfuse({
  secretKey: process.env.LANGFUSE_SECRET_KEY,
  publicKey: process.env.LANGFUSE_PUBLIC_KEY,
  baseUrl: process.env.LANGFUSE_BASE_URL,
  // Observability must never slow the learner down: a short timeout and no
  // retries, because an unreachable Langfuse host (observed live 2026-08-21:
  // every LLM call waited out a ~10s network timeout, adding more than a
  // minute to a scoring run) should cost milliseconds, not seconds.
  requestTimeout: 3000,
  fetchRetryCount: 0,
  enabled: Boolean(process.env.LANGFUSE_SECRET_KEY && process.env.LANGFUSE_PUBLIC_KEY),
});

export type CallType =
  | 'diagnostic-generation'
  | 'coaching'
  | 'hint-generation'
  | 'adaptive-generation'
  | 'source-document-generation'
  | 'qualitative-scoring'
  | 'review-exercise-generation'
  | 'qa-response'
  | 'finding-adjudication';

export type TracedCompletionParams = StructuredCompletionParams & {
  traceName: string;
  learnerId: string;
  callType: CallType;
  // Optional extra trace metadata (e.g. { rung: 3 } for hint-generation calls)
  // merged alongside callType — kept optional so existing call sites are unaffected.
  extraMetadata?: Record<string, unknown>;
};

// Wraps an OpenRouter structured completion in a Langfuse trace, tagged with
// the learner and call type so every LLM call from this unit onward is traced.
export async function getTracedStructuredCompletion(
  params: TracedCompletionParams,
): Promise<unknown> {
  const metadata = { callType: params.callType, ...params.extraMetadata };

  const trace = langfuse.trace({
    name: params.traceName,
    userId: params.learnerId,
    metadata,
  });

  const generation = trace.generation({
    name: params.traceName,
    input: params.messages,
    metadata,
  });

  try {
    const output = await getStructuredCompletion({
      messages: params.messages,
      jsonSchema: params.jsonSchema,
      model: params.model,
    });
    generation.end({ output });
    return output;
  } catch (error) {
    generation.end({
      output: null,
      statusMessage: error instanceof Error ? error.message : String(error),
      level: 'ERROR',
    });
    throw error;
  } finally {
    // Fire-and-forget: the SDK batches internally, and awaiting the flush
    // made every LLM call pay for Langfuse's network round-trip (or its
    // full timeout when the host is down). Tracing is observability — it
    // must never sit on the learner's critical path.
    void langfuse.flushAsync().catch(() => {});
  }
}

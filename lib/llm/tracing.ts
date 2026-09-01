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
    // The requested model; overwritten on end with the id OpenRouter actually
    // served, so Langfuse cost/latency dashboards group by real model.
    model: params.model ?? process.env.OPENROUTER_MODEL,
    metadata,
  });

  try {
    const result = await getStructuredCompletion({
      messages: params.messages,
      jsonSchema: params.jsonSchema,
      model: params.model,
    });
    generation.end({
      output: result.output,
      model: result.model,
      // Token usage + the USD cost OpenRouter actually charged — this is
      // what lights up Langfuse's cost/token dashboards (2026-09-01).
      usage: {
        input: result.usage.promptTokens ?? undefined,
        output: result.usage.completionTokens ?? undefined,
        total: result.usage.totalTokens ?? undefined,
        unit: 'TOKENS',
      },
      ...(result.usage.costUsd !== null
        ? { costDetails: { total: result.usage.costUsd } }
        : {}),
    });
    return result.output;
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

// Pushes a scored submission's outcome into Langfuse as SCORES on a
// per-submission trace (2026-09-01), so model/prompt changes can be
// correlated with learner results over time (Langfuse → Scores):
// weighted_score (0-1), passed (1/0), tb_tie_out (1/0). Fire-and-forget,
// same never-on-the-critical-path rule as the generation tracing above.
export function recordSubmissionScore(params: {
  learnerId: string;
  submissionId: string;
  weightedScore: number;
  overallResult: 'pass' | 'partial' | 'fail';
  tbTieOut: boolean;
}): void {
  try {
    const trace = langfuse.trace({
      name: 'submission-scored',
      userId: params.learnerId,
      metadata: { submissionId: params.submissionId, overallResult: params.overallResult },
    });
    trace.score({ name: 'weighted_score', value: params.weightedScore });
    trace.score({ name: 'passed', value: params.overallResult === 'pass' ? 1 : 0 });
    trace.score({ name: 'tb_tie_out', value: params.tbTieOut ? 1 : 0 });
    void langfuse.flushAsync().catch(() => {});
  } catch {
    // Observability failures never affect scoring.
  }
}

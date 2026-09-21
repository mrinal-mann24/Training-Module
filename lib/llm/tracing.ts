import { LangfuseClient } from '@langfuse/client';
import { LangfuseSpanProcessor } from '@langfuse/otel';
import { LangfuseOtelSpanAttributes, setLangfuseTracerProvider, startObservation, type LangfuseObservation } from '@langfuse/tracing';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { getStructuredCompletion, type StructuredCompletionParams } from './client';

// Langfuse tracing on the current SDK (2026-09-22). The `langfuse` v3
// package posted trace-create / generation-create events to
// /api/public/ingestion, which the Langfuse server now rejects ("Event type
// not accepted ... events_only"): every LLM call went untraced. The
// supported path is OpenTelemetry (@langfuse/tracing + @langfuse/otel) for
// traces and @langfuse/client for scores.
//
// Observability must never slow the learner down or fail a job: an ISOLATED
// tracer provider (nothing else in the app is instrumented), immediate
// export so a serverless function does not hold spans in a batch it never
// flushes, a short timeout, and every flush fire-and-forget. With no keys
// configured nothing is set up and every function below is a plain call.

const publicKey = process.env.LANGFUSE_PUBLIC_KEY;
const secretKey = process.env.LANGFUSE_SECRET_KEY;
const baseUrl = process.env.LANGFUSE_BASE_URL;
const enabled = Boolean(publicKey && secretKey);

const spanProcessor = enabled
  ? new LangfuseSpanProcessor({
      publicKey,
      secretKey,
      baseUrl,
      exportMode: 'immediate',
      // Seconds. An unreachable Langfuse host (observed live 2026-08-21:
      // every LLM call waited out a ~10s network timeout) should cost
      // little, and it is never awaited anyway.
      timeout: 3,
    })
  : null;

if (spanProcessor) {
  // Not the global provider: only Langfuse observations go through it.
  setLangfuseTracerProvider(new NodeTracerProvider({ spanProcessors: [spanProcessor] }));
}

const scoreClient = enabled ? new LangfuseClient({ publicKey, secretKey, baseUrl }) : null;

function flushInBackground(): void {
  void spanProcessor?.forceFlush().catch(() => {});
  void scoreClient?.flush().catch(() => {});
}

// The learner, the trace name and the trace metadata, written straight onto
// the observation's span. The SDK's propagateAttributes carries them through
// the OpenTelemetry context, which needs a GLOBAL context manager; this
// module deliberately registers nothing global, and without one the
// attributes were silently dropped (checked against an in-memory exporter).
function tagTrace(observation: LangfuseObservation, trace: { userId: string; name: string; metadata: Record<string, unknown> }): void {
  observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_USER_ID, trace.userId);
  observation.otelSpan.setAttribute(LangfuseOtelSpanAttributes.TRACE_NAME, trace.name);
  for (const [key, value] of Object.entries(trace.metadata)) {
    if (value === undefined || value === null) continue;
    observation.otelSpan.setAttribute(`${LangfuseOtelSpanAttributes.TRACE_METADATA}.${key}`, typeof value === 'string' ? value : JSON.stringify(value));
  }
}

export type CallType =
  | 'diagnostic-generation'
  | 'coaching'
  | 'hint-generation'
  | 'adaptive-generation'
  // Rebuild Stage 3 (2026-09-22): the model plans the month's events only.
  | 'batch-plan'
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
// the learner and call type so every LLM call is traced.
export async function getTracedStructuredCompletion(params: TracedCompletionParams): Promise<unknown> {
  const complete = () =>
    getStructuredCompletion({
      messages: params.messages,
      jsonSchema: params.jsonSchema,
      model: params.model,
      temperature: params.temperature,
    });
  if (!enabled) return (await complete()).output;

  const metadata = { callType: params.callType, ...params.extraMetadata };
  const generation = startObservation(
    params.traceName,
    {
      input: params.messages,
      // The requested model; overwritten on end with the id OpenRouter
      // actually served, so cost/latency dashboards group by real model.
      model: params.model ?? process.env.OPENROUTER_MODEL,
      metadata,
    },
    { asType: 'generation' },
  );
  tagTrace(generation, { userId: params.learnerId, name: params.traceName, metadata });
  try {
    const result = await complete();
    const usageDetails: Record<string, number> = {};
    if (result.usage.promptTokens !== null && result.usage.promptTokens !== undefined) usageDetails.input = result.usage.promptTokens;
    if (result.usage.completionTokens !== null && result.usage.completionTokens !== undefined) usageDetails.output = result.usage.completionTokens;
    if (result.usage.totalTokens !== null && result.usage.totalTokens !== undefined) usageDetails.total = result.usage.totalTokens;
    generation.update({
      output: result.output,
      model: result.model,
      // Token usage + the USD cost OpenRouter actually charged.
      usageDetails,
      ...(result.usage.costUsd !== null && result.usage.costUsd !== undefined ? { costDetails: { total: result.usage.costUsd } } : {}),
    });
    return result.output;
  } catch (error) {
    generation.update({ level: 'ERROR', statusMessage: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    generation.end();
    // Fire-and-forget: tracing never sits on the learner's critical path.
    flushInBackground();
  }
}

// Pushes a scored submission's outcome into Langfuse as SCORES on a
// per-submission trace (2026-09-01), so model/prompt changes can be
// correlated with learner results over time (Langfuse → Scores):
// weighted_score (0-1), passed (1/0), tb_tie_out (1/0). Fire-and-forget.
export function recordSubmissionScore(params: {
  learnerId: string;
  submissionId: string;
  weightedScore: number;
  overallResult: 'pass' | 'partial' | 'fail';
  tbTieOut: boolean;
}): void {
  if (!enabled || !scoreClient) return;
  try {
    const metadata = { submissionId: params.submissionId, overallResult: params.overallResult };
    const span = startObservation('submission-scored', { metadata });
    tagTrace(span, { userId: params.learnerId, name: 'submission-scored', metadata });
    span.end();
    const traceId = span.traceId;
    scoreClient.score.create({ traceId, name: 'weighted_score', value: params.weightedScore });
    scoreClient.score.create({ traceId, name: 'passed', value: params.overallResult === 'pass' ? 1 : 0 });
    scoreClient.score.create({ traceId, name: 'tb_tie_out', value: params.tbTieOut ? 1 : 0 });
    flushInBackground();
  } catch {
    // Observability failures never affect scoring.
  }
}

// Grounding violations on a coaching attempt (2026-09-16): which checks the
// model's feedback failed, and whether the code-composed fallback shipped
// instead. Recorded as its own trace so a prompt or model change that starts
// tripping the validator shows up in Langfuse rather than only as blander
// feedback. Fire-and-forget, never on the learner's critical path.
export function recordCoachingGroundingViolations(params: {
  learnerId: string;
  attempt: number;
  violations: string[];
  usedFallback: boolean;
}): void {
  if (!enabled || !scoreClient) return;
  try {
    const metadata = { callType: 'coaching', attempt: params.attempt, usedFallback: params.usedFallback };
    const span = startObservation('coaching-grounding', { metadata });
    tagTrace(span, { userId: params.learnerId, name: 'coaching-grounding', metadata });
    span.startObservation(params.usedFallback ? 'grounding-fallback' : 'grounding-retry', { level: 'WARNING', output: { violations: params.violations } }, { asType: 'event' });
    span.end();
    const traceId = span.traceId;
    scoreClient.score.create({ traceId, name: 'coaching_grounding_violations', value: params.violations.length });
    flushInBackground();
  } catch {
    // Observability failures never affect coaching.
  }
}

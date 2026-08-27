import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import { buildSourceDocumentPrompt, buildSourceDocumentRetryPrompt } from '@/lib/llm/prompts/source-document';
import { GeneratedSourceDocumentSchema, type GeneratedSourceDocument, type SourceDocumentType } from '@/lib/schemas/source-document';
import type { AnswerKeyEntry } from '@/lib/schemas/exercise';

const MAX_ATTEMPTS = 3;

// Generates the structured content for one source document, grounded in the
// specific answer-key entry it represents so its figures are internally
// consistent with what a correct posting would require. Same bounded-retry
// pattern as every other LLM call type in this codebase — validated against
// GeneratedSourceDocumentSchema, retried with the validation error fed back
// into the prompt, never persisted/rendered unvalidated.
export async function generateSourceDocument(
  learnerId: string,
  docType: SourceDocumentType,
  entry: AnswerKeyEntry,
  // All account names on this transaction's legs — the document's party name
  // is pinned to these (fix for a live-observed PDF titled with an invented
  // "Shree Traders" that appeared nowhere in the batch, 2026-08-24).
  partyAccounts: string[] = [],
): Promise<GeneratedSourceDocument> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildSourceDocumentPrompt(docType, entry, partyAccounts)
        : buildSourceDocumentRetryPrompt(docType, entry, partyAccounts, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'source-document-generation',
      learnerId,
      callType: 'source-document-generation',
      extraMetadata: { docType, transactionSequence: entry.sequence },
    });

    const parsed = GeneratedSourceDocumentSchema.safeParse(raw);

    if (parsed.success) {
      return parsed.data;
    }

    lastError = parsed.error.message;
  }

  throw new Error(
    `Source document generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

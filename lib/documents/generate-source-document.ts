import { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import {
  buildBankStatementBatchPrompt,
  buildBankStatementBatchRetryPrompt,
  buildSourceDocumentPrompt,
  buildSourceDocumentRetryPrompt,
  type BankStatementLineInput,
} from '@/lib/llm/prompts/source-document';
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
      // Documents are simple structured content — a faster model (set via
      // OPENROUTER_DOCUMENT_MODEL) cuts the batch tail dramatically; falls
      // back to the main OPENROUTER_MODEL when unset.
      model: process.env.OPENROUTER_DOCUMENT_MODEL,
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

// Generates ONE combined bank statement for all of a batch's bank-side
// transactions — a real statement is a single period document listing every
// movement, never one PDF per transaction (live intern feedback,
// 2026-09-01). Same bounded validate-and-retry pattern as above; the result
// is additionally checked to carry exactly one line per input transaction so
// a statement that silently drops or invents lines is retried, not rendered.
export async function generateBankStatementDocument(
  learnerId: string,
  lines: BankStatementLineInput[],
  // The statement's account holder — pinned to the learner's real company so
  // the PDF never invents one (live 2026-09-01: "Bank Statement — ABC
  // Trading Co." on a Blossom Retail batch).
  companyName: string,
): Promise<GeneratedSourceDocument> {
  let lastError: string | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const { messages, jsonSchema } =
      lastError === null
        ? buildBankStatementBatchPrompt(lines, companyName)
        : buildBankStatementBatchRetryPrompt(lines, companyName, lastError);

    const raw = await getTracedStructuredCompletion({
      messages,
      jsonSchema,
      traceName: 'source-document-generation',
      learnerId,
      callType: 'source-document-generation',
      // Documents are simple structured content — a faster model (set via
      // OPENROUTER_DOCUMENT_MODEL) cuts the batch tail dramatically; falls
      // back to the main OPENROUTER_MODEL when unset.
      model: process.env.OPENROUTER_DOCUMENT_MODEL,
      extraMetadata: {
        docType: 'bank_statement',
        transactionSequences: lines.map((line) => line.entry.sequence).join(','),
      },
    });

    const parsed = GeneratedSourceDocumentSchema.safeParse(raw);

    if (parsed.success) {
      if (parsed.data.doc_type !== 'bank_statement') {
        lastError = `Expected doc_type "bank_statement", got "${parsed.data.doc_type}".`;
        continue;
      }
      if (parsed.data.content.transactions.length !== lines.length) {
        lastError = `The statement has ${parsed.data.content.transactions.length} line(s) but ${lines.length} transaction(s) were provided — produce exactly one statement line per listed transaction.`;
        continue;
      }
      return parsed.data;
    }

    lastError = parsed.error.message;
  }

  throw new Error(
    `Bank statement generation failed validation after ${MAX_ATTEMPTS} attempts: ${lastError}`,
  );
}

import type { ChatMessage } from '@/lib/llm/client';
import { CONCEPT_TAGS, type ExerciseVariant } from '@/lib/schemas/exercise';
import { EXERCISE_JSON_SCHEMA } from './exercise-json-schema';

const SYSTEM_PROMPT = `You are generating the diagnostic placement exercise for a B.Com fresher learning
Tally bookkeeping. This exercise is scored but not taught — it establishes the
learner's starting level. Fixed scenario template: a small set of straightforward,
single-concept transactions (sales, purchase, payment, receipt) for one fictional
trading business, at difficulty L0. Every learner gets one of two seeded variants
(A or B), differing only in company/party names and amounts, not in concept mix.
Produce learner-facing scenario prose and transactions, plus the hidden answer key
for each transaction: correct account, Dr/Cr, amount, voucher type (e.g. Sales,
Purchase, Payment, Receipt), and narration. These L0 transactions are single-concept
drills with no GST or TDS component, so set gst_head, gst_rate, tds_section, tds_rate,
and tds_base to null and bill_reference to null unless a transaction is explicitly a
bill-settling entry. Tag each answer key entry's concept_tags with exactly one tag
from this fixed vocabulary matching the voucher type it drills: ${CONCEPT_TAGS.join(', ')}.
This is the diagnostic — it stays direct-entry, so set requires_source_document to
false and source_document_type to null on every entry.
Respond only with JSON matching the provided schema.`;

export function buildDiagnosticPrompt(variant: ExerciseVariant): {
  messages: ChatMessage[];
  jsonSchema: { name: string; schema: Record<string, unknown> };
} {
  return {
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `Generate diagnostic exercise variant ${variant}.` },
    ],
    jsonSchema: {
      name: 'diagnostic_exercise',
      schema: EXERCISE_JSON_SCHEMA,
    },
  };
}

export function buildDiagnosticRetryPrompt(
  variant: ExerciseVariant,
  validationError: string,
): { messages: ChatMessage[]; jsonSchema: { name: string; schema: Record<string, unknown> } } {
  const base = buildDiagnosticPrompt(variant);
  return {
    ...base,
    messages: [
      ...base.messages,
      {
        role: 'user',
        content: `Your previous response failed schema validation with this error: ${validationError}. Respond again with corrected JSON matching the schema exactly.`,
      },
    ],
  };
}

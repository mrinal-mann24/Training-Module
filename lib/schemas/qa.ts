import { z } from 'zod';

// Unit 15R: free-form chat Q&A ("which ledger does a background-check payment
// go to?"), the pilot program's most-used interaction. Deliberately minimal:
// one prose field. The grounding/no-answer-leak rules live in the prompt
// (lib/llm/prompts/qa.ts); this schema is the validation boundary between the
// model and the chat, per architecture.md invariant 3.
export const QaResponseSchema = z.object({
  answer: z.string().min(1),
});

export type QaResponse = z.infer<typeof QaResponseSchema>;

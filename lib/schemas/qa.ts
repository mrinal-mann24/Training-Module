import { z } from 'zod';

// Unit 15R: free-form chat Q&A ("which ledger does a background-check payment
// go to?"), the pilot program's most-used interaction. What the chat stores
// and shows is one prose field.
export const QaResponseSchema = z.object({
  answer: z.string().min(1),
});

export type QaResponse = z.infer<typeof QaResponseSchema>;

// What the MODEL returns (2026-09-17): the answer plus the ids of the
// rulebook excerpts, module docs and video registry entries it rests on, so
// answer-question.ts can check every rate, threshold, section number and
// video title against what was actually cited. The citations are stripped
// before the answer is shown or stored.
export const QaModelOutputSchema = z.object({
  answer: z.string().min(1),
  citations: z.array(z.string()),
});

export type QaModelOutput = z.infer<typeof QaModelOutputSchema>;

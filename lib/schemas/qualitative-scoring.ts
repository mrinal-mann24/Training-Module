import { z } from 'zod';

// LLM-judged scoring for free-text answers (explain-the-entry, ledger
// review) — unlike scoring.ts's deterministic diff, natural language can't
// be code-diffed, so this genuinely calls the LLM (score-qualitative.ts).
// rationale is internal grounding for why the model scored what it scored —
// never shown to the learner as raw text, same discipline as scoring.ts's
// error codes; the learner only ever sees the plain-language framing built
// from these subscores (never the numbers themselves — see
// combine-scoring.ts / MessageBubble.tsx).
export const QualitativeScoringSchema = z.object({
  recall: z.number().min(0).max(100),
  precision: z.number().min(0).max(100),
  reasoning_quality: z.number().min(0).max(100),
  rationale: z.string(),
});
export type QualitativeScoring = z.infer<typeof QualitativeScoringSchema>;

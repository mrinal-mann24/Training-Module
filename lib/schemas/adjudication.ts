import { z } from 'zod';
import { SCORED_FIELDS } from '@/lib/schemas/scoring';

// Hybrid scoring (2026-08-20, user decision): the deterministic engine is the
// FACT-FINDER, the LLM is the JUDGE. Every finding the engine flags is
// adjudicated — upheld (a real error) or dismissed (an acceptable variation:
// alternate ledger naming the aliases didn't anticipate, a legitimate
// structural difference, a ref-format quirk). The pilot calibration showed
// why: of 98 originally-flagged transactions on a real submission, 86 were
// engine rigidity and 12 were real errors. Dismissals must never be silent —
// each carries a reason, and a missing verdict means the engine's finding
// stands (fail-safe in adjudicate-findings.ts).
export const AdjudicationVerdictSchema = z.object({
  sequence: z.number().int().positive(),
  field: z.enum(SCORED_FIELDS),
  // The expected leg an account finding is about (2026-09-17): dismissals
  // are keyed per leg, so excusing one leg's naming never clears another
  // leg of the same transaction. Null for voucher-level fields.
  leg: z.number().int().nonnegative().nullable().optional(),
  verdict: z.enum(['uphold', 'dismiss']),
  // Internal-only: stored nowhere learner-facing; exists so a human reviewing
  // traces can audit why a finding was dismissed.
  reason: z.string(),
});

export const AdjudicationSchema = z.object({
  verdicts: z.array(AdjudicationVerdictSchema),
});

export type AdjudicationVerdict = z.infer<typeof AdjudicationVerdictSchema>;
export type Adjudication = z.infer<typeof AdjudicationSchema>;

import { z } from 'zod';

// Smart Send (2026-09-15): while an explain or review text part is pending,
// the learner's typed message is routed either as a question (answered by
// Q&A) or as an answer (offered back for one-tap confirmation before it is
// filed and scored). Rules decide first (lib/chat/message-intent-rules.ts);
// this schema is the validation boundary for the LLM tie-break used only when
// the rules cannot decide (architecture.md invariant 3). `reason` is kept for
// the Langfuse trace and never leaves lib/.
export const MessageIntentSchema = z.object({
  intent: z.enum(['question', 'answer']),
  reason: z.string().min(1),
});

export type MessageIntent = z.infer<typeof MessageIntentSchema>;

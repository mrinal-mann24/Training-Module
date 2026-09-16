import type { TextPartType } from '@/lib/schemas/exercise';

// How a typed part is named to the learner ("Send this as your explanation?").
// No server imports, so client components can use it too.
export const TEXT_PART_LABEL: Record<TextPartType, string> = {
  explain_text: 'explanation',
  review_text: 'ledger review',
};

import type { SubmissionPartType } from '@/lib/schemas/exercise';

// Pure union for the parts checklist (2026-09-16), kept out of the hook so it
// can be tested in node. Two sources feed the checklist, a database read and
// Realtime INSERT events, and they overlap by design: the read happens once
// the channel is live, so a part can arrive by both routes. Union, never
// replace, so neither source can erase what the other already reported.
//
// Order is stable: existing parts keep their positions and new ones are
// appended, which keeps React from reshuffling the rendered list.
export function mergeReceivedParts(
  current: readonly SubmissionPartType[],
  incoming: readonly SubmissionPartType[],
): SubmissionPartType[] {
  const additions = incoming.filter((part, index) => !current.includes(part) && incoming.indexOf(part) === index);
  return additions.length === 0 ? [...current] : [...current, ...additions];
}

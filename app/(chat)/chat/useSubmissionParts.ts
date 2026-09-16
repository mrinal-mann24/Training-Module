import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { SubmissionPartType } from '@/lib/schemas/exercise';
import { getSubmissionPartsStatus } from './actions';
import { mergeReceivedParts } from './merge-received-parts';

// The received parts of one submission, for the parts checklist. Two sources,
// unioned (mergeReceivedParts):
//
// 1. A database read, made the moment the Realtime channel reports
//    SUBSCRIBED.
// 2. Realtime INSERT events on submission_parts for this submission.
//
// Why the read happens AFTER subscribing (2026-09-16). This hook used to be
// seeded from a read its parent made before mounting it, passed in as the
// initial value of useState. React reads a useState initial value on the
// first render only, and on that render the read had not returned, so the
// hook started from [] and the result was silently dropped. From then on it
// learned only from INSERT events, and submitFiles writes both file parts
// BEFORE this hook ever subscribes, so those inserts were never delivered.
// Every multi-part upload therefore showed "Daybook — waiting · Trial Balance
// — waiting" for parts that were already stored.
//
// Reading once the channel is live closes the gap from both sides: anything
// written before the read is in the read, and anything written after arrives
// as an INSERT. SUBSCRIBED fires again after a reconnect, which re-reads and
// so also recovers any event missed while disconnected.
//
// `enabled` is false when no checklist is shown (a plain two-file upload), so
// no channel is opened for nothing.
export function useSubmissionParts(submissionId: string, enabled: boolean): SubmissionPartType[] {
  const [receivedParts, setReceivedParts] = useState<SubmissionPartType[]>([]);

  useEffect(() => {
    if (!enabled) {
      return;
    }

    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    (async () => {
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) {
        return;
      }
      if (session) {
        await supabase.realtime.setAuth(session.access_token);
      }
      // Checked again: the component can unmount during setAuth, and a channel
      // opened after cleanup has already run would never be removed.
      if (cancelled) {
        return;
      }

      channel = supabase
        .channel(`submission-parts-${submissionId}`)
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'submission_parts',
            filter: `submission_id=eq.${submissionId}`,
          },
          (payload) => {
            const partType = (payload.new as { part_type: SubmissionPartType }).part_type;
            setReceivedParts((current) => mergeReceivedParts(current, [partType]));
          },
        )
        .subscribe((status) => {
          if (status !== 'SUBSCRIBED') {
            return;
          }
          getSubmissionPartsStatus(submissionId)
            .then((result) => {
              if (!cancelled) {
                setReceivedParts((current) => mergeReceivedParts(current, result.receivedParts));
              }
            })
            // A failed read only means the checklist catches up on the next
            // INSERT or reconnect instead of now. It is display state, never
            // the source of truth: the scoring job reads the database itself.
            .catch(() => {});
        });
    })();

    return () => {
      cancelled = true;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [submissionId, enabled]);

  return receivedParts;
}

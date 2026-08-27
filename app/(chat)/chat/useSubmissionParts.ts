import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { SubmissionPartType } from '@/lib/schemas/exercise';

// Subscribes to Postgres Changes INSERT events on submission_parts, filtered
// to one submission's rows, via Supabase Realtime — same pattern as Unit 07's
// useSubmissionStatus.ts. Seeded with the parts already received at mount
// (initialReceivedParts, from getSubmissionPartsStatus) so the checklist is
// correct even if some parts arrived before this component mounted, not just
// ones that arrive afterward — Realtime subscriptions only catch events from
// the moment they connect, same "only forward in time" behavior as
// step.waitForEvent on the job side.
export function useSubmissionParts(
  submissionId: string,
  initialReceivedParts: SubmissionPartType[],
): SubmissionPartType[] {
  const [receivedParts, setReceivedParts] = useState<SubmissionPartType[]>(initialReceivedParts);

  useEffect(() => {
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
            setReceivedParts((current) => (current.includes(partType) ? current : [...current, partType]));
          },
        )
        .subscribe();
    })();

    return () => {
      cancelled = true;
      if (channel) {
        supabase.removeChannel(channel);
      }
    };
  }, [submissionId]);

  return receivedParts;
}

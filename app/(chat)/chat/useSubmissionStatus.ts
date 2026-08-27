import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import type { SubmissionStatus } from '@/lib/db/queries/submissions';
import type { ValidityError } from '@/lib/tutor/submission-gate';

type SubmissionRowUpdate = {
  status: SubmissionStatus;
  validity_errors: ValidityError[] | null;
};

// Subscribes to Postgres Changes UPDATE events on a single submissions row via
// Supabase Realtime — no polling. The browser client carries the learner's
// session, so the table's existing RLS select policy (auth.uid() = learner_id)
// is enforced per-subscriber automatically; this hook can only ever receive
// updates for a submission the caller already owns.
export function useSubmissionStatus(submissionId: string, onUpdate: (row: SubmissionRowUpdate) => void) {
  const [status, setStatus] = useState<SubmissionStatus>('validating');

  useEffect(() => {
    const supabase = createClient();
    let channel: ReturnType<typeof supabase.channel> | null = null;
    let cancelled = false;

    // Realtime caches a connection's authorization at subscribe time, keyed
    // off whatever JWT was last handed to the socket. Explicitly resending
    // the current session's access token immediately before subscribing
    // forces a fresh RLS check for this channel, rather than relying on
    // auto-refresh having already propagated to an already-open socket.
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
        .channel(`submission-status-${submissionId}`)
        .on(
          'postgres_changes',
          {
            event: 'UPDATE',
            schema: 'public',
            table: 'submissions',
            filter: `id=eq.${submissionId}`,
          },
          (payload) => {
            const row = payload.new as SubmissionRowUpdate;
            setStatus(row.status);
            onUpdate(row);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submissionId]);

  return status;
}

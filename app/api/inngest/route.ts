import { serve } from 'inngest/next';
import { inngest } from '@/lib/jobs/client';
import { runScoring } from '@/lib/jobs/run-scoring';
import { waitForSubmission } from '@/lib/jobs/wait-for-submission';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [runScoring, waitForSubmission],
});

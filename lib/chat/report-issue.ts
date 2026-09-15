import type { SupabaseClient } from '@supabase/supabase-js';
import { ISSUE_MESSAGE_MAX_LENGTH } from '@/lib/chat/issue-limits';
import { ReportIssueInputSchema } from '@/lib/schemas/learner-issue';
import { getLatestExercise, type ExerciseForLearner } from '@/lib/db/queries/exercises';
import { getLatestSubmissionForExercise } from '@/lib/db/queries/submissions';
import type { SubmissionStatus } from '@/lib/db/queries/submissions';
import {
  getLearnerIssuesSince,
  insertLearnerIssue,
  type LearnerIssue,
  type NewLearnerIssue,
} from '@/lib/db/queries/learner-issues';

// Learner issue reports (2026-09-15). Issues go to the owner, never to the
// tutor: nothing here calls an LLM or reads the answer key, so the issue box
// cannot become a side door for hints.

export const ISSUES_PER_HOUR = 5;
// The same text sent again within this window is the same issue (double
// click, a retry after a slow network), not a new one.
export const DUPLICATE_WINDOW_MS = 10 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const SEND_FAILED_MESSAGE = "Your issue didn't go through just now. Please try again in a minute.";

export type IssueGate =
  | { kind: 'allowed' }
  | { kind: 'duplicate'; issue: LearnerIssue }
  | { kind: 'rate_limited' };

function normalizeForComparison(message: string): string {
  return message.replace(/\s+/g, ' ').trim().toLowerCase();
}

// `recentIssues` is the last hour of the learner's issues, newest first, so a
// duplicate resolves to the most recent matching row. The duplicate check
// runs before the limit: resending the issue already on record is answered
// with that record, never with a "too many issues" refusal. A row whose
// timestamp does not parse counts toward the limit (fail closed) but is never
// treated as a duplicate.
export function gateIssue(message: string, recentIssues: LearnerIssue[], now: Date): IssueGate {
  const nowMs = now.getTime();
  const target = normalizeForComparison(message);
  const ageOf = (issue: LearnerIssue) => nowMs - Date.parse(issue.created_at);

  const duplicate = recentIssues.find(
    (issue) => normalizeForComparison(issue.message) === target && ageOf(issue) < DUPLICATE_WINDOW_MS,
  );
  if (duplicate) {
    return { kind: 'duplicate', issue: duplicate };
  }

  const inLastHour = recentIssues.filter((issue) => !(ageOf(issue) >= HOUR_MS)).length;
  return inLastHour >= ISSUES_PER_HOUR ? { kind: 'rate_limited' } : { kind: 'allowed' };
}

export type IssueContext = Omit<NewLearnerIssue, 'learner_id' | 'message'>;

// Snapshot of where the learner was when they reported. Kept as plain values
// as well as ids, because a reset deletes the exercise and submission rows.
export function buildIssueContext(
  exercise: Pick<ExerciseForLearner, 'id' | 'difficulty_level' | 'created_at'> | null,
  submission: { id: string; status: SubmissionStatus } | null,
): IssueContext {
  return {
    exercise_id: exercise?.id ?? null,
    exercise_level: exercise?.difficulty_level ?? null,
    exercise_created_at: exercise?.created_at ?? null,
    submission_id: exercise && submission ? submission.id : null,
    submission_status: exercise && submission ? submission.status : null,
  };
}

async function loadIssueContext(supabase: SupabaseClient, learnerId: string): Promise<IssueContext> {
  // The context is a convenience for the owner. A failed lookup must never
  // stop the learner's issue from being recorded.
  try {
    const exercise = await getLatestExercise(supabase, learnerId);
    const submission = exercise ? await getLatestSubmissionForExercise(supabase, learnerId, exercise.id) : null;
    return buildIssueContext(exercise, submission);
  } catch {
    return buildIssueContext(null, null);
  }
}

export type ReportIssueOutcome = { status: 'sent'; issue: LearnerIssue } | { status: 'error'; error: string };

type ReportLearnerIssueParams = {
  // Authenticated client: reads are scoped to the learner by RLS.
  supabase: SupabaseClient;
  // Service-role client: the only writer of learner_issues.
  serviceRoleClient: SupabaseClient;
  learnerId: string;
  // Straight from the Server Action, so it is validated here, not trusted.
  rawMessage: unknown;
  now?: Date;
};

export async function reportLearnerIssue({
  supabase,
  serviceRoleClient,
  learnerId,
  rawMessage,
  now = new Date(),
}: ReportLearnerIssueParams): Promise<ReportIssueOutcome> {
  const parsed = ReportIssueInputSchema.safeParse({ message: rawMessage });
  if (!parsed.success) {
    const tooLong = parsed.error.issues.some((issue) => issue.code === 'too_big');
    return {
      status: 'error',
      error: tooLong
        ? `That's a bit long. Please keep it under ${ISSUE_MESSAGE_MAX_LENGTH} characters.`
        : 'Type your issue before sending.',
    };
  }
  const message = parsed.data.message;

  let recentIssues: LearnerIssue[];
  try {
    recentIssues = await getLearnerIssuesSince(supabase, learnerId, new Date(now.getTime() - HOUR_MS).toISOString());
  } catch {
    return { status: 'error', error: SEND_FAILED_MESSAGE };
  }

  const gate = gateIssue(message, recentIssues, now);
  if (gate.kind === 'duplicate') {
    return { status: 'sent', issue: gate.issue };
  }
  if (gate.kind === 'rate_limited') {
    return {
      status: 'error',
      error: `You've sent ${ISSUES_PER_HOUR} issues in the last hour. We already have them, so please wait a little before sending another.`,
    };
  }

  const context = await loadIssueContext(supabase, learnerId);

  try {
    const issue = await insertLearnerIssue(serviceRoleClient, { learner_id: learnerId, message, ...context });
    return { status: 'sent', issue };
  } catch {
    return { status: 'error', error: SEND_FAILED_MESSAGE };
  }
}

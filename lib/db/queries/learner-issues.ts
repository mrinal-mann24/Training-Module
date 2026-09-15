import type { SupabaseClient } from '@supabase/supabase-js';
import type { IssueStatus } from '@/lib/schemas/learner-issue';

// What the learner sees of their own issue. The context snapshot columns are
// for the owner's triage and are never selected for the chat.
export type LearnerIssue = {
  id: string;
  message: string;
  status: IssueStatus;
  admin_reply: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type NewLearnerIssue = {
  learner_id: string;
  message: string;
  exercise_id: string | null;
  submission_id: string | null;
  exercise_level: string | null;
  exercise_created_at: string | null;
  submission_status: string | null;
};

const LEARNER_ISSUE_SELECT = 'id, message, status, admin_reply, created_at, resolved_at';

// Service-role only: learners have no insert grant on learner_issues (see the
// migration header), so the action writes after validating and rate-limiting.
export async function insertLearnerIssue(
  serviceRoleClient: SupabaseClient,
  issue: NewLearnerIssue,
): Promise<LearnerIssue> {
  const { data, error } = await serviceRoleClient
    .from('learner_issues')
    .insert(issue)
    .select(LEARNER_ISSUE_SELECT)
    .single();

  if (error) {
    throw error;
  }

  return data;
}

// The chat's "Your issues" list, newest first. Authenticated client: RLS
// scopes it to the caller's own rows.
export async function getLearnerIssues(
  supabase: SupabaseClient,
  learnerId: string,
  limit = 20,
): Promise<LearnerIssue[]> {
  const { data, error } = await supabase
    .from('learner_issues')
    .select(LEARNER_ISSUE_SELECT)
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    throw error;
  }

  return data ?? [];
}

// Rate-limit and duplicate lookback: every issue since `sinceIso`, newest
// first.
export async function getLearnerIssuesSince(
  supabase: SupabaseClient,
  learnerId: string,
  sinceIso: string,
): Promise<LearnerIssue[]> {
  const { data, error } = await supabase
    .from('learner_issues')
    .select(LEARNER_ISSUE_SELECT)
    .eq('learner_id', learnerId)
    .gte('created_at', sinceIso)
    .order('created_at', { ascending: false });

  if (error) {
    throw error;
  }

  return data ?? [];
}

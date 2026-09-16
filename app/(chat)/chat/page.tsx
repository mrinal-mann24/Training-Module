import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getLearnerProfile, isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { getLatestExercise, type ExerciseForLearner } from '@/lib/db/queries/exercises';
import { getHintDepthForExercise } from '@/lib/db/queries/hint-requests';
import { getLearnerIssues } from '@/lib/db/queries/learner-issues';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getConceptMasteryMap, hasFailedConceptForSubmission } from '@/lib/db/queries/mastery';
import { getLatestScoredSubmissionForExercise } from '@/lib/db/queries/submissions';
import { currentMajorModule } from '@/lib/tutor/major-modules';
import { correctionInviteLine, isCorrectionOpen } from '@/lib/tutor/correction-round';
import { buildChatTimeline } from '@/lib/chat/build-timeline';
import { isAiaOnboardingDue } from '@/lib/tutor/documents-mode';
import { ChatShell } from './ChatShell';

// Whether the latest exercise is still open for a corrected re-upload, and
// the line that says so. Null when it is not.
async function loadCorrectionInvite(
  supabase: SupabaseClient,
  learnerId: string,
  exercise: ExerciseForLearner,
): Promise<string | null> {
  const latestScored = await getLatestScoredSubmissionForExercise(supabase, learnerId, exercise.id);
  if (!latestScored) {
    return null;
  }

  const anyConceptFailed = await hasFailedConceptForSubmission(supabase, learnerId, latestScored.id);
  if (
    !isCorrectionOpen({
      requiredParts: exercise.requiredParts,
      latestRound: latestScored.correction_round,
      anyConceptFailed,
    })
  ) {
    return null;
  }

  return correctionInviteLine(latestScored.correction_round + 1);
}

export default async function ChatPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  if (!(await isLearnerOnboarded(supabase, user.id))) {
    redirect('/onboarding');
  }

  const profile = await getLearnerProfile(supabase, user.id);
  if (!profile) {
    redirect('/onboarding');
  }

  const walkthroughCompleted = profile.walkthrough_completed_at != null;
  const initialExercise = walkthroughCompleted
    ? await getLatestExercise(supabase, user.id)
    : null;

  const [initialHintDepth, masteryMap, initialIssues] = await Promise.all([
    initialExercise ? getHintDepthForExercise(supabase, user.id, initialExercise.id) : Promise.resolve(0),
    getConceptMasteryMap(supabase, user.id),
    // Issue reports (2026-09-15): the list is a convenience, so a failed read
    // (or the learner_issues migration not applied yet) shows no list rather
    // than taking the whole chat down.
    getLearnerIssues(supabase, user.id).catch(() => []),
  ]);

  // Documents mode (2026-09-09): once three concepts are mastered the learner
  // gets the one-time AI Accountant setup popup before anything else.
  const aiaOnboardingDue = isAiaOnboardingDue({
    walkthroughCompleted,
    aiaOnboardingCompletedAt: profile.aia_onboarding_completed_at,
    mastery: masteryMap.values(),
  });

  // Chat-history rebuild (2026-08-24): the FULL conversation — every
  // exercise, submission, feedback, hint, and Q&A exchange — is reassembled
  // server-side on every load, so a refresh never loses the thread.
  const initialModuleTitle = currentMajorModule(masteryMap).title;

  // Correction round (2026-09-16): a learner who left for Tally and came
  // back must still be told the exercise is waiting for corrected exports.
  // Derived from rows on every load, never stored, so it cannot go stale.
  const correctionInvite = initialExercise
    ? await loadCorrectionInvite(supabase, user.id, initialExercise)
    : null;

  const initialMessages = walkthroughCompleted
    ? await buildChatTimeline(supabase, user.id, initialModuleTitle, correctionInvite)
    : [];

  return (
    <ChatShell
      licenseMode={profile.license_mode}
      walkthroughCompleted={walkthroughCompleted}
      aiaOnboardingDue={aiaOnboardingDue}
      initialExercise={initialExercise}
      initialHintDepth={initialHintDepth}
      initialModuleTitle={initialModuleTitle}
      initialMessages={initialMessages}
      initialIssues={initialIssues}
    />
  );
}

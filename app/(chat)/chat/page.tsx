import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getLearnerProfile, isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { getLatestExercise } from '@/lib/db/queries/exercises';
import { getHintDepthForExercise } from '@/lib/db/queries/hint-requests';
import { getConceptMasteryMap, getModuleNumber } from '@/lib/db/queries/mastery';
import { buildChatTimeline } from '@/lib/chat/build-timeline';
import { isAiaOnboardingDue } from '@/lib/tutor/documents-mode';
import { ChatShell } from './ChatShell';

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

  const [initialHintDepth, initialModuleNumber, masteryMap] = await Promise.all([
    initialExercise ? getHintDepthForExercise(supabase, user.id, initialExercise.id) : Promise.resolve(0),
    getModuleNumber(supabase, user.id),
    getConceptMasteryMap(supabase, user.id),
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
  const initialMessages = walkthroughCompleted
    ? await buildChatTimeline(supabase, user.id, initialModuleNumber)
    : [];

  return (
    <ChatShell
      licenseMode={profile.license_mode}
      walkthroughCompleted={walkthroughCompleted}
      aiaOnboardingDue={aiaOnboardingDue}
      initialExercise={initialExercise}
      initialHintDepth={initialHintDepth}
      initialModuleNumber={initialModuleNumber}
      initialMessages={initialMessages}
    />
  );
}

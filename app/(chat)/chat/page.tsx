import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { getLearnerProfile, isLearnerOnboarded } from '@/lib/db/queries/learner-profile';
import { getLatestExercise } from '@/lib/db/queries/exercises';
import { getHintDepthForExercise } from '@/lib/db/queries/hint-requests';
import { getModuleNumber } from '@/lib/db/queries/mastery';
import { buildChatTimeline } from '@/lib/chat/build-timeline';
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

  const [initialHintDepth, initialModuleNumber] = await Promise.all([
    initialExercise ? getHintDepthForExercise(supabase, user.id, initialExercise.id) : Promise.resolve(0),
    getModuleNumber(supabase, user.id),
  ]);

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
      initialExercise={initialExercise}
      initialHintDepth={initialHintDepth}
      initialModuleNumber={initialModuleNumber}
      initialMessages={initialMessages}
    />
  );
}

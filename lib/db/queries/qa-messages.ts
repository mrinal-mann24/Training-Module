import type { SupabaseClient } from '@supabase/supabase-js';

export type QaMessage = {
  id: string;
  question: string;
  answer: string;
  created_at: string;
};

// One row per Q&A exchange (question + tutor answer), written by the
// askQuestion action through the authenticated client after the LLM answers —
// the chat-history rebuild (lib/chat/build-timeline.ts) renders each row as
// two messages.
export async function insertQaMessage(
  supabase: SupabaseClient,
  learnerId: string,
  question: string,
  answer: string,
): Promise<void> {
  const { error } = await supabase.from('qa_messages').insert({
    learner_id: learnerId,
    question,
    answer,
  });

  if (error) {
    throw error;
  }
}

export async function getQaMessagesForLearner(
  supabase: SupabaseClient,
  learnerId: string,
): Promise<QaMessage[]> {
  const { data, error } = await supabase
    .from('qa_messages')
    .select('id, question, answer, created_at')
    .eq('learner_id', learnerId)
    .order('created_at', { ascending: true });

  if (error) {
    throw error;
  }

  return data ?? [];
}

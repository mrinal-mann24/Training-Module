import type { Coaching } from '@/lib/schemas/coaching';
import type { Hint } from '@/lib/schemas/hint';
import type { SourceDocumentType } from '@/lib/schemas/source-document';

// Chat message shape. Kept minimal, grows only as units need more.
export type MessageRole = 'assistant' | 'learner';
export type MessageKind =
  | 'walkthrough'
  | 'exercise'
  | 'submission'
  | 'submission-result-invalid'
  | 'submission-result-scored'
  | 'hint'
  // Unit 15R: free-form Q&A — a learner's question and the tutor's grounded
  // answer. Both render as plain content bubbles (no special fields).
  | 'qa-question'
  | 'qa-answer';

export type ChatMessage = {
  id: string;
  role: MessageRole;
  content: string;
  kind: MessageKind;
  // Only set for kind: 'submission' — filenames only, never raw XML content.
  attachmentNames?: string[];
  // Only set for kind: 'submission-result-scored'. Renders only the composed
  // feedback_text fields from the coaching schema — never error codes,
  // weights, or anything derived from answer_key.
  //
  // 2026-09-16: overallResult (pass/partial/fail) was removed from this
  // shape rather than merely left unrendered. The verdict still exists
  // server-side and still drives mastery; keeping it on the client type
  // would let any future component put the badge back by accident.
  scoringFeedback?: { feedback: Coaching };
  // Only set for kind: 'hint'. Renders only the composed hint_text/rung —
  // never the answer_key it was grounded in.
  hint?: Hint;
  // Only set for kind: 'exercise'. Small inline progress label ("Module 3 ·
  // Level 2") per Unit 09's design note — no new screen, just this label on
  // the exercise message itself.
  progressLabel?: string;
  // Only set for kind: 'exercise', when the exercise has one or more
  // generated source documents (Unit 10). Rendered as document cards below
  // the scenario text in the same message — never a separate message, per
  // spec. url is a signed Storage URL, resolved server-side.
  sourceDocuments?: { id: string; docType: SourceDocumentType; documentName: string; url: string }[];
};

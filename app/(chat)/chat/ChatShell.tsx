'use client';

import { useRef, useState, useTransition } from 'react';
import { formatExerciseContent } from '@/lib/chat/exercise-content';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { SourceDocumentType } from '@/lib/schemas/source-document';
import { MessageBubble } from './MessageBubble';
import { ThinkingIndicator } from './ThinkingIndicator';
import { Composer } from './Composer';
import { PendingSubmission } from './PendingSubmission';
import { getWalkthroughSteps } from './walkthrough-config';
import { askQuestion, confirmWalkthrough, requestHint, submitFiles, submitTextPart } from './actions';
import { logOut } from '@/app/dashboard/actions';
import type { ChatMessage } from './message';

type ExerciseSourceDocument = { id: string; docType: SourceDocumentType; documentName: string; url: string };

// Unit 11: a 'review' exercise has no transactions, only reviewPacketItems
// (the learner-facing review packet — real entries mixed with seeded
// distractors, presented as plain text, per generate-review-exercise.ts).
// Exactly one of the two is ever non-empty for a given exercise.
function exerciseToMessages(
  exercise: ExerciseForLearner,
  moduleNumber: number,
  sourceDocuments: ExerciseSourceDocument[],
): ChatMessage[] {
  const itemLines =
    exercise.reviewPacketItems.length > 0
      ? exercise.reviewPacketItems.map((item) => `${item.sequence}. ${item.presented_text}`).join('\n')
      : exercise.transactions.map((transaction) => `${transaction.sequence}. ${transaction.description}`).join('\n');

  return [
    {
      id: `exercise-${exercise.id}`,
      role: 'assistant',
      kind: 'exercise',
      content: formatExerciseContent(exercise.scenario, itemLines, exercise.requiredParts),
      // Small inline progress label, existing token styles only — no new
      // screen (Unit 09's design note; the full progress view is Unit 12).
      progressLabel: `Module ${moduleNumber} · Level ${exercise.difficulty_level.replace('L', '')}`,
      // Document cards sit below the scenario text in this same message, per
      // Unit 10's design note — never a separate message.
      sourceDocuments: sourceDocuments.length > 0 ? sourceDocuments : undefined,
    },
  ];
}

type ChatShellProps = {
  licenseMode: LicenseMode;
  walkthroughCompleted: boolean;
  initialExercise: ExerciseForLearner | null;
  // Prior hint_requests count for initialExercise, fetched server-side so the
  // hint button's label is correct on first render/reload, not just after a
  // hint is requested in the current session.
  initialHintDepth: number;
  // Count of mastered concepts + 1, for the progress label — see
  // getModuleNumber's comment for why this is derived, not stored.
  initialModuleNumber: number;
  // Chat-history rebuild (2026-08-24): the full persisted conversation,
  // reassembled server-side (lib/chat/build-timeline.ts) — the timeline
  // opens with this and appends everything that happens live.
  initialMessages: ChatMessage[];
};

export function ChatShell({
  licenseMode,
  walkthroughCompleted,
  initialExercise,
  initialHintDepth,
  initialModuleNumber,
  initialMessages,
}: ChatShellProps) {
  const walkthroughSteps = getWalkthroughSteps(licenseMode);

  const [stepIndex, setStepIndex] = useState(0);
  const [showWalkthrough, setShowWalkthrough] = useState(!walkthroughCompleted);
  const [exercise, setExercise] = useState<ExerciseForLearner | null>(initialExercise);
  const [moduleNumber, setModuleNumber] = useState(initialModuleNumber);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Holds both submission-related messages and hint messages, appended in
  // chronological order — a single timeline, same pattern already used for
  // interleaving learner submission chips with their scored/invalid results.
  const [submissionMessages, setSubmissionMessages] = useState<ChatMessage[]>([]);
  const [pendingSubmissionIds, setPendingSubmissionIds] = useState<string[]>([]);
  const [hasRequestedHint, setHasRequestedHint] = useState(initialHintDepth > 0);
  const [isPending, startTransition] = useTransition();
  const [isSubmittingFiles, startFileSubmit] = useTransition();
  const [isSubmittingTextPart, startTextPartSubmit] = useTransition();
  const [isRequestingHint, startHintRequest] = useTransition();
  const [isAskingQuestion, startAskQuestion] = useTransition();
  // GPT-style composer support: bumping the signal clears attached files
  // after a fully-dispatched send; the ref remembers that the learner was
  // already asked about extra files so the next Send proceeds.
  const [composerResetSignal, setComposerResetSignal] = useState(0);
  const extraFilesConfirmedRef = useRef(false);

  const walkthroughMessages: ChatMessage[] = walkthroughSteps
    .slice(0, stepIndex + 1)
    .map((step) => ({
      id: step.id,
      role: 'assistant',
      kind: 'walkthrough',
      content: step.content,
    }));

  // The timeline opens with the FULL persisted conversation (rebuilt
  // server-side on every load — refresh loses nothing), then everything that
  // happens live in this session appends via submissionMessages.
  const messages: ChatMessage[] = showWalkthrough
    ? walkthroughMessages
    : [...initialMessages, ...submissionMessages];

  const isLastStep = stepIndex === walkthroughSteps.length - 1;
  const currentStep = walkthroughSteps[stepIndex];

  function handleSubmissionResult(message: ChatMessage) {
    setSubmissionMessages((current) => [...current, message]);
    setPendingSubmissionIds((current) => current.filter((id) => `submission-result-${id}` !== message.id));
  }

  // Auto-delivery of the adaptively generated next exercise (Unit 09) — the
  // learner never has to ask for it. Appends the exercise to the timeline and
  // makes it the one the composer and hint button now act on.
  function handleNextExercise(
    nextExercise: ExerciseForLearner,
    hintDepth: number,
    nextModuleNumber: number,
    nextSourceDocuments: ExerciseSourceDocument[],
  ) {
    // The new exercise is appended to the running timeline rather than
    // replacing it: the learner keeps their previous submission and its
    // feedback on screen, and the next exercise arrives underneath like the
    // next message in a conversation. Clearing the timeline here (as this
    // originally did) wiped the submission and feedback the moment the next
    // exercise was auto-delivered, so the learner never saw what they were
    // being told to improve on.
    setSubmissionMessages((current) => [
      ...current,
      ...exerciseToMessages(nextExercise, nextModuleNumber, nextSourceDocuments),
    ]);
    setExercise(nextExercise);
    setModuleNumber(nextModuleNumber);
    setHasRequestedHint(hintDepth > 0);
  }

  function appendTutorNote(content: string) {
    setSubmissionMessages((current) => [
      ...current,
      { id: `tutor-note-${Date.now()}`, role: 'assistant', kind: 'qa-answer', content },
    ]);
  }

  // GPT-style unified send (2026-08-24): one composer, one Send. Routing:
  // no files → the text is a question (or an explain/review answer, which
  // Composer's textPartType placeholder covers via handleSubmitTextPart);
  // 1 file → conversational nudge for the second (files stay attached);
  // 3+ files → asks once, a second Send proceeds and the server picks the
  // Day Book + Trial Balance pair by content; 2 files → submit. Text sent
  // alongside files is treated as a question after the submission goes in.
  function handleSend(files: File[], text: string) {
    const textPartType =
      exercise?.requiredParts.includes('explain_text') || exercise?.requiredParts.includes('review_text');

    if (files.length === 0) {
      if (text.length === 0) {
        return;
      }
      if (textPartType) {
        handleSubmitTextPart(text);
      } else {
        handleAskQuestion(text);
      }
      return;
    }

    if (files.length === 1) {
      appendTutorNote(
        `I've got "${files[0].name}". I still need the other export. Attach the second file (I need the Day Book AND the Trial Balance) and press Send again.`,
      );
      return;
    }

    if (files.length > 2 && !extraFilesConfirmedRef.current) {
      extraFilesConfirmedRef.current = true;
      appendTutorNote(
        `You've attached ${files.length} files, but I only use two: the Day Book and the Trial Balance. Remove the extras, or press Send again and I'll pick the right two myself.`,
      );
      return;
    }

    extraFilesConfirmedRef.current = false;

    // Same file attached twice (hit live 2026-08-27: the Day Book uploaded
    // twice crashed the upload at the middleware body cap). Catch it here,
    // conversationally, before 11 MB leaves the browser.
    if (files.length === 2 && files[0].name === files[1].name && files[0].size === files[1].size) {
      appendTutorNote(
        "It looks like you've attached the same file twice. I need two DIFFERENT exports: the Day Book and the Trial Balance. Remove one copy, attach the missing export, and press Send again.",
      );
      return;
    }

    // Stay safely under the 25 MB server body limit; a normal pair is ~6 MB.
    const MAX_TOTAL_UPLOAD_BYTES = 20 * 1024 * 1024;
    if (files.reduce((sum, file) => sum + file.size, 0) > MAX_TOTAL_UPLOAD_BYTES) {
      appendTutorNote(
        "Those files are too large for me to take in one go (more than 20 MB together). Make sure you're sending the Tally XML exports themselves, not a backup or a zip, and try again.",
      );
      return;
    }

    const learnerMessage: ChatMessage = {
      id: `submission-${Date.now()}`,
      role: 'learner',
      kind: 'submission',
      content: text.length > 0 ? text : 'Submitted for review.',
      attachmentNames: files.map((file) => file.name),
    };
    setSubmissionMessages((current) => [...current, learnerMessage]);
    setErrorMessage(null);

    startFileSubmit(async () => {
      const formData = new FormData();
      for (const file of files) {
        formData.append('files', file);
      }

      const result = await submitFiles(formData);

      if (result.status === 'error') {
        // Conversational, like the rest of the chat — the files stay
        // attached so the learner can fix the selection and resend.
        appendTutorNote(result.error);
        return;
      }

      setComposerResetSignal((current) => current + 1);
      // The upload Server Action has already returned — parsing, the validity
      // gate, scoring, and coaching all run in the background Inngest job.
      // PendingSubmission below subscribes to this row via Supabase Realtime
      // and reports the result (invalid or scored) once the job updates it.
      setPendingSubmissionIds((current) =>
        current.includes(result.submission.id) ? current : [...current, result.submission.id],
      );

      // Text sent alongside the files is a genuine question — answer it too,
      // GPT-style, rather than silently dropping it.
      if (text.length > 0 && !textPartType) {
        handleAskQuestion(text);
      }
    });
  }

  function handleSubmitTextPart(text: string) {
    const learnerMessage: ChatMessage = {
      id: `submission-text-${Date.now()}`,
      role: 'learner',
      kind: 'submission',
      content: text,
    };
    setSubmissionMessages((current) => [...current, learnerMessage]);
    setErrorMessage(null);

    startTextPartSubmit(async () => {
      const result = await submitTextPart(text);

      if (result.status === 'error') {
        setErrorMessage(result.error);
        return;
      }

      // A text part and a file part for the same exercise can resolve to the
      // same submissionId (getOpenSubmissionForExercise joins whichever part
      // arrives second onto the submission the first part created) — only
      // track it once so PendingSubmission doesn't render twice for one
      // in-flight submission.
      setPendingSubmissionIds((current) =>
        current.includes(result.submission.id) ? current : [...current, result.submission.id],
      );
    });
  }

  // Unit 15R: free-form Q&A — appends the learner's question immediately,
  // then the tutor's grounded answer when it returns, both into the same
  // running timeline as every other message.
  function handleAskQuestion(text: string) {
    const questionMessage: ChatMessage = {
      id: `qa-question-${Date.now()}`,
      role: 'learner',
      kind: 'qa-question',
      content: text,
    };
    setSubmissionMessages((current) => [...current, questionMessage]);
    setErrorMessage(null);

    startAskQuestion(async () => {
      const result = await askQuestion(text);
      if (result.status === 'error') {
        setErrorMessage(result.error);
        return;
      }
      setSubmissionMessages((current) => [
        ...current,
        {
          id: `qa-answer-${Date.now()}`,
          role: 'assistant',
          kind: 'qa-answer',
          content: result.answer,
        },
      ]);
    });
  }

  function handleRequestHint() {
    if (!exercise) {
      return;
    }
    setErrorMessage(null);
    startHintRequest(async () => {
      const result = await requestHint(exercise.id);

      if (result.status === 'error') {
        setErrorMessage(result.error);
        return;
      }

      const hintMessage: ChatMessage = {
        id: `hint-${Date.now()}`,
        role: 'assistant',
        kind: 'hint',
        content: result.hint.hint_text,
        hint: result.hint,
      };
      setSubmissionMessages((current) => [...current, hintMessage]);
      setHasRequestedHint(true);
    });
  }

  // Fetch-or-create the diagnostic and append it to the timeline. Called from
  // the walkthrough's final step AND from the empty-state recovery button
  // below — confirmWalkthrough is self-healing (creates the exercise if none
  // exists, returns the existing one otherwise), so both paths are safe to
  // call any number of times.
  function deliverDiagnostic() {
    setErrorMessage(null);
    startTransition(async () => {
      const result = await confirmWalkthrough();
      if (result.status === 'error') {
        setErrorMessage(result.error);
        return;
      }
      // Appended rather than rendered from `exercise` state, for the same
      // reason as handleNextExercise: the timeline is what renders, and this
      // diagnostic is its first entry when the learner arrives with no
      // exercise already loaded (initialExercise is null on this path).
      setSubmissionMessages((current) => [
        ...current,
        ...exerciseToMessages(result.exercise, moduleNumber, result.sourceDocuments),
      ]);
      setExercise(result.exercise);
      setShowWalkthrough(false);
    });
  }

  function handleStepAction() {
    if (!isLastStep) {
      setStepIndex((index) => index + 1);
      return;
    }
    deliverDiagnostic();
  }

  return (
    <div className="flex h-screen flex-col bg-bg-canvas">
      {/* Slim persistent header so the learner always has a visible,
          unambiguous Log out — the chat screen previously had none, and the
          only logout lived on the dashboard (2026-08-31). */}
      <header className="flex items-center justify-between border-b border-border bg-background px-4 py-2.5 font-body">
        <span className="text-base font-semibold tracking-tight text-foreground">✦ AIA Academy</span>
        <form action={logOut}>
          <button
            type="submit"
            className="cursor-pointer rounded-lg border border-border bg-background px-4 py-1.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary"
          >
            Log out
          </button>
        </form>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-6">
        {/* Phase 4 (spec 16): widescreen — messages live in a centered
            ~1150px column instead of spanning the whole window. */}
        <div className="mx-auto w-full max-w-287.5 space-y-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {!showWalkthrough && !exercise && messages.length === 0 && (
          <div className="flex flex-col items-start gap-2">
            <p className="text-base text-text-secondary">
              You&apos;re all set up — your first exercise is ready when you are.
            </p>
            <button
              type="button"
              onClick={deliverDiagnostic}
              disabled={isPending}
              className="rounded-md bg-accent px-4 py-2 text-base text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {isPending ? 'Getting your exercise…' : 'Start my training'}
            </button>
          </div>
        )}

        {showWalkthrough && currentStep && (
          <div className="flex justify-start">
            <button
              type="button"
              onClick={handleStepAction}
              disabled={isPending}
              className="rounded-md bg-accent px-4 py-2 text-base text-white hover:bg-accent-hover disabled:opacity-60"
            >
              {isPending ? 'Generating…' : currentStep.buttonLabel}
            </button>
          </div>
        )}

        {(isPending || isSubmittingFiles || isSubmittingTextPart || isRequestingHint) && <ThinkingIndicator />}

        {exercise &&
          pendingSubmissionIds.map((submissionId) => (
            <PendingSubmission
              key={submissionId}
              submissionId={submissionId}
              exerciseId={exercise.id}
              requiredParts={exercise.requiredParts}
              onResult={handleSubmissionResult}
              onNextExercise={handleNextExercise}
            />
          ))}

        {errorMessage && <p className="text-sm text-status-error">{errorMessage}</p>}
        </div>
      </div>

      <Composer
        disabled={showWalkthrough || exercise === null}
        onSend={handleSend}
        isSending={isSubmittingFiles || isSubmittingTextPart}
        requiredParts={exercise?.requiredParts ?? []}
        onAskQuestion={handleAskQuestion}
        isAsking={isAskingQuestion}
        resetSignal={composerResetSignal}
        hasRequestedHint={hasRequestedHint}
        isRequestingHint={isRequestingHint}
        onRequestHint={handleRequestHint}
      />
    </div>
  );
}

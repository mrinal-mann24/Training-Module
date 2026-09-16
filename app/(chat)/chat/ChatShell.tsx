'use client';

import { useReducer, useRef, useState, useTransition } from 'react';
import { formatExerciseContent } from '@/lib/chat/exercise-content';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { SourceDocumentType } from '@/lib/schemas/source-document';
import { MessageBubble } from './MessageBubble';
import { ThinkingIndicator } from './ThinkingIndicator';
import { Composer } from './Composer';
import { PendingSubmission } from './PendingSubmission';
import { getWalkthroughSteps } from './walkthrough-config';
import {
  askQuestion,
  confirmAiaOnboarding,
  confirmWalkthrough,
  requestHint,
  sendTypedMessage,
  submitFiles,
  submitTextPart,
} from './actions';
import type { SendTypedMessageResult } from './actions';
import { AnswerConfirmation } from './AnswerConfirmation';
import { NO_CONFIRMATION, answerConfirmationReducer } from './answer-confirmation';
import { TEXT_PART_LABEL } from '@/lib/chat/text-part-labels';
import { textPartTypeFor } from '@/lib/tutor/submission-routing';
import { AiaOnboarding } from './AiaOnboarding';
import { ReportIssue } from './ReportIssue';
import type { LearnerIssue } from '@/lib/db/queries/learner-issues';
import { logOut } from '@/app/(auth)/login/actions';
import type { ChatMessage } from '@/lib/chat/message';

type ExerciseSourceDocument = { id: string; docType: SourceDocumentType; documentName: string; url: string };

// Unit 11: a 'review' exercise has no transactions, only reviewPacketItems
// (the learner-facing review packet — real entries mixed with seeded
// distractors, presented as plain text, per generate-review-exercise.ts).
// Exactly one of the two is ever non-empty for a given exercise.
function exerciseToMessages(
  exercise: ExerciseForLearner,
  moduleTitle: string,
  sourceDocuments: ExerciseSourceDocument[],
): ChatMessage[] {
  // Documents-only batches (2026-09-10) show no transaction lines.
  const itemLines = exercise.documentsOnly
    ? ''
    : exercise.reviewPacketItems.length > 0
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
      progressLabel: `${moduleTitle} · Level ${exercise.difficulty_level.replace('L', '')}`,
      // Document cards sit below the scenario text in this same message, per
      // Unit 10's design note — never a separate message.
      sourceDocuments: sourceDocuments.length > 0 ? sourceDocuments : undefined,
    },
  ];
}

type ChatShellProps = {
  licenseMode: LicenseMode;
  walkthroughCompleted: boolean;
  // Documents mode (2026-09-09): show the one-time AI Accountant setup popup
  // before the learner can do anything else this session.
  aiaOnboardingDue: boolean;
  initialExercise: ExerciseForLearner | null;
  // Prior hint_requests count for initialExercise, fetched server-side so the
  // hint button's label is correct on first render/reload, not just after a
  // hint is requested in the current session.
  initialHintDepth: number;
  // The learner-facing module the chip names (2026-09-16), derived from the
  // same mastery map /progress and the dashboard bar use, so the three
  // screens can never name different modules for the same learner.
  initialModuleTitle: string;
  // Chat-history rebuild (2026-08-24): the full persisted conversation,
  // reassembled server-side (lib/chat/build-timeline.ts) — the timeline
  // opens with this and appends everything that happens live.
  initialMessages: ChatMessage[];
  // Issue reports (2026-09-15): the learner's own reported issues, newest
  // first, for the "Report an issue" box.
  initialIssues: LearnerIssue[];
};

export function ChatShell({
  licenseMode,
  walkthroughCompleted,
  aiaOnboardingDue,
  initialExercise,
  initialHintDepth,
  initialModuleTitle,
  initialMessages,
  initialIssues,
}: ChatShellProps) {
  const walkthroughSteps = getWalkthroughSteps(licenseMode);

  const [stepIndex, setStepIndex] = useState(0);
  const [showWalkthrough, setShowWalkthrough] = useState(!walkthroughCompleted);
  const [showAiaOnboarding, setShowAiaOnboarding] = useState(aiaOnboardingDue);
  const [exercise, setExercise] = useState<ExerciseForLearner | null>(initialExercise);
  const [moduleTitle, setModuleTitle] = useState(initialModuleTitle);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // Holds both submission-related messages and hint messages, appended in
  // chronological order — a single timeline, same pattern already used for
  // interleaving learner submission chips with their scored/invalid results.
  const [submissionMessages, setSubmissionMessages] = useState<ChatMessage[]>([]);
  const [pendingSubmissionIds, setPendingSubmissionIds] = useState<string[]>([]);
  const [hasRequestedHint, setHasRequestedHint] = useState(initialHintDepth > 0);
  const [isPending, startTransition] = useTransition();
  const [isSubmittingFiles, startFileSubmit] = useTransition();
  const [isRoutingMessage, startRouting] = useTransition();
  const [isResolvingAnswer, startResolveAnswer] = useTransition();
  // Smart Send's "Submit answer / It's a question" card (answer-confirmation.ts).
  const [confirmation, dispatchConfirmation] = useReducer(answerConfirmationReducer, NO_CONFIRMATION);
  // Set synchronously on the first tap, so a double-click can't send twice
  // before the reducer's new phase reaches the next render.
  const resolvingAnswerRef = useRef(false);
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

  // Smart Send: an open card whose exercise is no longer the current one can
  // only be dismissed, never filed (the server refuses it too).
  const draftIsStale =
    confirmation.phase !== 'none' && (exercise === null || confirmation.draft.exerciseId !== exercise.id);

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
    nextModuleTitle: string,
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
      ...exerciseToMessages(nextExercise, nextModuleTitle, nextSourceDocuments),
    ]);
    setExercise(nextExercise);
    setModuleTitle(nextModuleTitle);
    setHasRequestedHint(hintDepth > 0);
    // An open Smart Send card for the previous exercise turns stale by itself
    // (draftIsStale). Deliberately not handled here: PendingSubmission keeps
    // the onNextExercise it mounted with, so this closure can hold old state.
  }

  function appendTutorNote(content: string) {
    setSubmissionMessages((current) => [
      ...current,
      { id: `tutor-note-${crypto.randomUUID()}`, role: 'assistant', kind: 'qa-answer', content },
    ]);
  }

  // GPT-style unified send (2026-08-24) + Smart Send (2026-09-15): one
  // composer, one Send. Routing: no files → on an explain/review exercise the
  // server decides whether the text is a question or the typed part
  // (handleTypedMessage), anywhere else it is a question; 1 file →
  // conversational nudge for the second (files stay attached); 3+ files →
  // asks once, a second Send proceeds and the server picks the Day Book +
  // Trial Balance pair by content; 2 files → submit, and text sent alongside
  // is routed the same way once the upload is in.
  function handleSend(files: File[], text: string) {
    const textPartType = exercise ? textPartTypeFor(exercise.requiredParts) : null;

    if (files.length === 0) {
      if (text.length === 0) {
        return;
      }
      supersedeWaitingAnswer();
      if (textPartType) {
        handleTypedMessage(text);
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

    supersedeWaitingAnswer();
    const learnerMessage: ChatMessage = {
      id: `submission-${crypto.randomUUID()}`,
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

      // Text sent alongside the files (Garima typed her Level 3 explanation in
      // the same message as the two XMLs, 2026-09-03): on an explain/review
      // exercise it goes through Smart Send routing like any typed message,
      // so a real answer gets the one-tap confirmation and a question is
      // answered; otherwise it's a genuine question, never silently dropped.
      if (text.length > 0 && textPartType) {
        applyRoutedMessage(await sendTypedMessage(text), true);
      } else if (text.length > 0) {
        handleAskQuestion(text);
      }
    });
  }

  // Smart Send: a card still waiting for a choice is dropped, and says so,
  // when the learner sends something new instead.
  function supersedeWaitingAnswer() {
    if (confirmation.phase !== 'pending') {
      return;
    }
    dispatchConfirmation({ type: 'dismiss' });
    // A stale card already says it was not sent.
    if (!draftIsStale) {
      appendTutorNote('Not sent. You sent a new message instead.');
    }
  }

  // Typed text on an explain/review exercise: the server answers a question
  // or hands back an answer for confirmation (lib/chat/route-typed-message.ts).
  function handleTypedMessage(text: string) {
    setSubmissionMessages((current) => [
      ...current,
      { id: `typed-${crypto.randomUUID()}`, role: 'learner', kind: 'qa-question', content: text },
    ]);
    setErrorMessage(null);
    startRouting(async () => {
      try {
        applyRoutedMessage(await sendTypedMessage(text), false);
      } catch {
        setErrorMessage("I couldn't read that just now. Please send it again.");
      }
    });
  }

  function applyRoutedMessage(result: SendTypedMessageResult, filesAlreadyIn: boolean) {
    if (result.status === 'answered') {
      appendTutorNote(result.answer);
      return;
    }
    if (result.status === 'needs-confirmation') {
      dispatchConfirmation({
        type: 'offer',
        draft: { exerciseId: result.exerciseId, partType: result.partType, text: result.text, filesAlreadyIn },
      });
      return;
    }
    if (filesAlreadyIn) {
      appendTutorNote(`Your files are in, but I couldn't read your message: ${result.error}`);
      return;
    }
    setErrorMessage(result.error);
  }

  // "Submit answer": files the confirmed text exactly as before Smart Send.
  function handleSubmitAnswer() {
    if (confirmation.phase !== 'pending' || resolvingAnswerRef.current || draftIsStale) {
      return;
    }
    const { draft } = confirmation;
    resolvingAnswerRef.current = true;
    dispatchConfirmation({ type: 'submit' });
    setErrorMessage(null);

    startResolveAnswer(async () => {
      try {
        const result = await submitTextPart(draft.text, draft.exerciseId);
        dispatchConfirmation({ type: 'resolved' });
        if (result.status === 'error') {
          // Server-decided (already scored, already received, no exercise):
          // retrying the same card would only repeat it.
          appendTutorNote(result.error);
          return;
        }
        appendTutorNote(`Sent as your ${TEXT_PART_LABEL[draft.partType]}.`);
        // A text part and a file part for the same exercise can resolve to
        // the same submissionId, so track it once (one PendingSubmission).
        setPendingSubmissionIds((current) =>
          current.includes(result.submission.id) ? current : [...current, result.submission.id],
        );
      } catch {
        dispatchConfirmation({ type: 'failed' });
        setErrorMessage("I couldn't send that just now. Tap Submit answer again.");
      } finally {
        resolvingAnswerRef.current = false;
      }
    });
  }

  // "It's a question": answers the same text instead, with no second bubble.
  function handleAnswerIsQuestion() {
    if (confirmation.phase !== 'pending' || resolvingAnswerRef.current) {
      return;
    }
    const { draft } = confirmation;
    resolvingAnswerRef.current = true;
    dispatchConfirmation({ type: 'ask' });
    setErrorMessage(null);

    startResolveAnswer(async () => {
      try {
        const result = await askQuestion(draft.text);
        dispatchConfirmation({ type: 'resolved' });
        if (result.status === 'error') {
          setErrorMessage(result.error);
          return;
        }
        appendTutorNote(result.answer);
      } catch {
        dispatchConfirmation({ type: 'failed' });
        setErrorMessage("I couldn't reach the tutor just now. Tap It's a question again.");
      } finally {
        resolvingAnswerRef.current = false;
      }
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
        ...exerciseToMessages(result.exercise, moduleTitle, result.sourceDocuments),
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
      {showAiaOnboarding && (
        <AiaOnboarding
          onComplete={async () => {
            const result = await confirmAiaOnboarding();
            if (result.status === 'error') return result.error;
            setShowAiaOnboarding(false);
            return null;
          }}
        />
      )}
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

      {/* Relative wrapper so the floating "Report an issue" button sits over
          the bottom-right of the message area and never over the composer;
          the extra bottom padding keeps the last message clear of it. */}
      <div className="relative flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto px-4 pt-6 pb-20">
        {/* Phase 4 (spec 16): widescreen — messages live in a centered
            ~1150px column instead of spanning the whole window. */}
        <div className="mx-auto w-full max-w-287.5 space-y-4">
        {messages.map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}

        {confirmation.phase !== 'none' && (
          <AnswerConfirmation
            partType={confirmation.draft.partType}
            filesAlreadyIn={confirmation.draft.filesAlreadyIn}
            phase={confirmation.phase}
            stale={draftIsStale}
            onSubmit={handleSubmitAnswer}
            onAsk={handleAnswerIsQuestion}
          />
        )}

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

        {(isPending || isSubmittingFiles || isRoutingMessage || isResolvingAnswer || isRequestingHint) && (
          <ThinkingIndicator />
        )}

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
      <ReportIssue initialIssues={initialIssues} />
      </div>

      <Composer
        disabled={showWalkthrough || showAiaOnboarding || exercise === null}
        onSend={handleSend}
        isSending={isSubmittingFiles || isRoutingMessage || isResolvingAnswer || isAskingQuestion}
        requiredParts={exercise?.requiredParts ?? []}
        resetSignal={composerResetSignal}
        hasRequestedHint={hasRequestedHint}
        isRequestingHint={isRequestingHint}
        onRequestHint={handleRequestHint}
      />
    </div>
  );
}

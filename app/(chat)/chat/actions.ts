'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import {
  completeWalkthrough,
  completeAiaOnboarding,
  getLearnerProfile,
  hasCompletedWalkthrough,
} from '@/lib/db/queries/learner-profile';
import { createDiagnosticExercise } from '@/lib/tutor/create-diagnostic-exercise';
import { getSignedPackFileCards, freshSignedUrlForPackFile } from '@/lib/db/queries/exercise-packs';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import { getExerciseAnswerKey, getLatestDiagnosticExercise, getLatestExercise } from '@/lib/db/queries/exercises';
import {
  insertSubmission,
  getLatestScoredSubmissionForExercise,
  getOpenSubmissionForExercise,
  hasScoredSubmissionForExercise,
  updateSubmissionFilePaths,
  getSubmission,
} from '@/lib/db/queries/submissions';
import type { Submission, SubmissionStatus } from '@/lib/db/queries/submissions';
import type { ValidityError } from '@/lib/tutor/submission-gate';
import { getFeedbackForLearner } from '@/lib/db/queries/scoring-results';
import {
  insertHintRequest,
  getHintDepthForExercise,
  getLatestHintForExerciseAfter,
} from '@/lib/db/queries/hint-requests';
import { getConceptMasteryMap, hasFailedConceptForSubmission } from '@/lib/db/queries/mastery';
import { currentMajorModule } from '@/lib/tutor/major-modules';
import { correctionInviteLine, isCorrectionOpen } from '@/lib/tutor/correction-round';
import { inngest } from '@/lib/jobs/client';
import type { Coaching } from '@/lib/schemas/coaching';
import type { Hint } from '@/lib/schemas/hint';
import type { SourceDocumentType } from '@/lib/schemas/source-document';
import type { SubmissionPartType } from '@/lib/schemas/exercise';
import { determineNextRung, findReusableDeepHint } from '@/lib/tutor/hint-ladder';
import { generateHint } from '@/lib/tutor/generate-hint';
import { answerLearnerQuestion } from '@/lib/chat/answer-learner-question';
import { routeTypedMessage, type RouteTypedMessageResult } from '@/lib/chat/route-typed-message';
import { TEXT_PART_LABEL } from '@/lib/chat/text-part-labels';
import {
  getSourceDocumentsForExercise,
  getSignedSourceDocumentUrls,
  freshSignedUrlForDocument,
} from '@/lib/db/queries/source-documents';
import { insertSubmissionPart, getSubmissionParts } from '@/lib/db/queries/submission-parts';
import { submissionXmlPaths, uploadSubmissionXmlFiles } from '@/lib/db/queries/submission-files';
import { pairTallyUploads } from '@/lib/tutor/pair-tally-uploads';
import { fileSubmissionEvents, textPartTypeFor } from '@/lib/tutor/submission-routing';
import { reportLearnerIssue, type ReportIssueOutcome } from '@/lib/chat/report-issue';
import {
  ASK_QUESTION_INVALID_MESSAGE,
  AskQuestionInputSchema,
  GetNextExerciseInputSchema,
  REPORT_ISSUE_INVALID_MESSAGE,
  RefreshDocumentUrlInputSchema,
  ReportIssueActionInputSchema,
  RequestHintInputSchema,
  SEND_TYPED_MESSAGE_EMPTY_MESSAGE,
  SendTypedMessageInputSchema,
  SUBMIT_FILES_NEED_BOTH_MESSAGE,
  SUBMIT_TEXT_PART_INVALID_MESSAGE,
  SubmissionIdInputSchema,
  SubmitFilesInputSchema,
  SubmitTextPartInputSchema,
  TEXT_PART_STALE_MESSAGE,
} from '@/lib/schemas/chat-actions';

type ExerciseSourceDocument = { id: string; docType: SourceDocumentType; documentName: string; url: string };

// Fetches an exercise's source documents and resolves each to a signed URL,
// via the authenticated client so the exercise-documents Storage select
// policy's learner-scoping applies naturally (see source-documents.ts).
async function getExerciseSourceDocuments(
  supabase: Awaited<ReturnType<typeof createClient>>,
  exerciseId: string,
): Promise<ExerciseSourceDocument[]> {
  const documents = await getSourceDocumentsForExercise(supabase, exerciseId);
  if (documents.length === 0) {
    return [];
  }
  return getSignedSourceDocumentUrls(supabase, documents);
}

// Sign-on-click (2026-09-01): the card asks for a fresh URL the moment the
// learner clicks, so a link can never be stale however long the chat sat
// open (Supabase Storage rejected expired links with `"exp" claim timestamp
// check failed`, observed live). Pack files are shared content keyed by
// storage path; generated documents are per-learner and keyed by row id, so
// only the id is trusted from the client and the path is read server-side.
export async function refreshDocumentUrl(
  documentId: string,
  kind: 'source-document' | 'pack-file',
): Promise<string | null> {
  if (!RefreshDocumentUrlInputSchema.safeParse({ documentId, kind }).success) {
    return null;
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return null;
  }

  return kind === 'pack-file'
    ? freshSignedUrlForPackFile(supabase, documentId)
    : freshSignedUrlForDocument(supabase, documentId);
}

// Documents mode (2026-09-09): records that the learner finished the one-time
// AI Accountant setup popup. Idempotent; nothing else happens here — the
// next batch already comes out in documents mode based on mastery.
export async function confirmAiaOnboarding(): Promise<{ status: 'ok' } | { status: 'error'; error: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  try {
    await completeAiaOnboarding(supabase, user.id);
  } catch {
    return { status: 'error', error: "I couldn't save that just now. Press the button again." };
  }
  return { status: 'ok' };
}

export type ConfirmWalkthroughResult =
  | { status: 'generated'; exercise: ExerciseForLearner; sourceDocuments: ExerciseSourceDocument[] }
  | { status: 'error'; error: string };

export async function confirmWalkthrough(): Promise<ConfirmWalkthroughResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Guards against duplicate exercise generation on double-click or refresh:
  // completeWalkthrough only updates the row if walkthrough_completed_at is
  // still null, so a second call here is a no-op and we just fetch the
  // exercise the first call already generated.
  const alreadyCompleted = await hasCompletedWalkthrough(supabase, user.id);

  if (!alreadyCompleted) {
    await completeWalkthrough(supabase, user.id);
  }

  // Exercise creation is keyed on "no diagnostic exists yet", NOT on "the
  // walkthrough was just completed" — this makes the action self-healing: a
  // learner whose walkthrough is marked complete but who has no exercise
  // (data reset, or a failure between the two steps) gets one on the next
  // call instead of a dead-end blank chat (bug observed live 2026-08-19).
  // Duplicate-generation safety is preserved: the exercise-existence check
  // is the guard, so a double-click still creates at most one.
  let exercise = await getLatestDiagnosticExercise(supabase, user.id);

  if (!exercise) {
    const serviceRoleClient = createServiceRoleClient();
    try {
      // Authored pack first, generated diagnostic only as the fallback (see
      // lib/tutor/create-diagnostic-exercise.ts).
      await createDiagnosticExercise({ supabase, serviceRoleClient, learnerId: user.id });
    } catch (error) {
      return {
        status: 'error',
        error: error instanceof Error ? error.message : 'Exercise generation failed.',
      };
    }
    exercise = await getLatestDiagnosticExercise(supabase, user.id);
  }

  if (!exercise) {
    return { status: 'error', error: "I hit a snag getting your exercise ready. Give it a second and press the button again, I'll pick up where I left off." };
  }

  const sourceDocuments =
    exercise.packFiles.length > 0
      ? await getSignedPackFileCards(supabase, exercise.packFiles)
      : await getExerciseSourceDocuments(supabase, exercise.id);

  return { status: 'generated', exercise, sourceDocuments };
}

export type SubmitFilesResult =
  | { status: 'accepted'; submission: Submission }
  | { status: 'error'; error: string };

// A submission already in 'scoring' has every part it is going to get, and
// its files are being read right now. Taking another upload for it cannot be
// honoured: the Storage policy (20260916150000) refuses to overwrite a scoring
// submission's files, so before this check a re-send failed with "send both
// files again" on every attempt. It must not start a second submission either,
// which would score the exercise twice. So say plainly what is happening.
// A job that crashes mid-scoring does not leave this message up forever: the
// jobs' onFailure moves the submission to 'invalid', which is re-submittable.
const STILL_SCORING_MESSAGE =
  "This batch is being scored right now, so I can't take anything more for it. Your feedback will appear here shortly.";

// The files and rows are saved but the scoring job could not be started, most
// often because the job server was unreachable. Pressing Send again is a real
// fix, not a hope: it rejoins this 'validating' submission, overwrites the
// files, leaves the recorded parts, and sends the events again.
const FILES_SAVED_NOT_STARTED_MESSAGE =
  "I saved your files, but couldn't start checking them just now. Nothing you did wrong. Press Send again in a moment and I'll pick up from there.";

// Shown when the displayed exercise already has a scored submission: the next
// batch is generated a few minutes after scoring, and in that window the old
// exercise is still the latest one (see hasScoredSubmissionForExercise).
const ALREADY_SCORED_MESSAGE =
  "This exercise has already been scored, so I won't take a second submission for it. Your next batch is being prepared and will appear here in a minute or two. Refresh the page if it hasn't shown up.";

// Server Action: authenticates, uploads both XML files to learner-scoped
// Storage paths, creates (or joins, for a multi-part exercise where a
// text part already arrived first) the submissions row, records both file
// parts in submission_parts, then sends the Inngest event chosen by
// lib/tutor/submission-routing.ts and returns immediately. It does not await
// parsing, the gate, scoring, or coaching — those run in a background job,
// and the client picks up the result via a Supabase Realtime subscription on
// this row.
export async function submitFiles(formData: FormData): Promise<SubmitFilesResult> {
  const parsed = SubmitFilesInputSchema.safeParse({ files: formData.getAll('files') });
  if (!parsed.success) {
    return { status: 'error', error: parsed.error.issues[0]?.message ?? SUBMIT_FILES_NEED_BOTH_MESSAGE };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // Which file is the Day Book and which the Trial Balance is decided by
  // content, never by filename (lib/tutor/pair-tally-uploads.ts).
  const pairing = await pairTallyUploads(parsed.data.files);
  if (pairing.status === 'unpaired') {
    return { status: 'error', error: pairing.error };
  }
  const daybookUpload = pairing.daybook;
  const trialbalanceUpload = pairing.trialbalance;

  const daybookFile = daybookUpload.file;
  const trialbalanceFile = trialbalanceUpload.file;

  const profile = await getLearnerProfile(supabase, user.id);
  if (!profile) {
    return { status: 'error', error: "I couldn't load your profile just now. Refresh the page and try again, and if it keeps happening, log out and back in." };
  }

  // The learner always submits against whatever exercise is currently
  // displayed — diagnostic, adaptive, or explain, whichever is most recent.
  const exercise = await getLatestExercise(supabase, user.id);
  if (!exercise) {
    return { status: 'error', error: "I don't see an active exercise to score this against. Refresh the page, and if there's still nothing, use the Start my training button and I'll set you up." };
  }
  if (!exercise.requiredParts.includes('daybook_xml') || !exercise.requiredParts.includes('trialbalance_xml')) {
    const isReview = exercise.requiredParts.includes('review_text');
    return {
      status: 'error',
      error: isReview
        ? "No files needed for this one! It's a written review: look through the books in the exercise above and type what you found in the message box. Tell me what looks off and why, in your own words."
        : 'This one is answered in writing, not with file uploads. Type your answer in the message box and send it.',
    };
  }
  // A scored exercise takes another submission only while a correction round
  // is open (2026-09-16): the learner was shown a help step and asked for
  // corrected exports, and this is them. Outside that, the old refusal
  // stands, because the next batch is already on its way.
  const latestScored = await getLatestScoredSubmissionForExercise(supabase, user.id, exercise.id);
  let correctionRound = 0;
  if (latestScored) {
    const anyConceptFailed = await hasFailedConceptForSubmission(supabase, user.id, latestScored.id);
    const open = isCorrectionOpen({
      requiredParts: exercise.requiredParts,
      latestRound: latestScored.correction_round,
      anyConceptFailed,
    });
    if (!open) {
      return { status: 'error', error: ALREADY_SCORED_MESSAGE };
    }
    correctionRound = latestScored.correction_round + 1;
  }

  const daybookBuffer = daybookUpload.buffer;
  const trialbalanceBuffer = trialbalanceUpload.buffer;

  // Joins an already-open submission for this exercise (a text part may have
  // arrived first, out of order) rather than always creating a new row —
  // see getOpenSubmissionForExercise's comment.
  const existingSubmission = await getOpenSubmissionForExercise(supabase, user.id, exercise.id);
  if (existingSubmission?.status === 'scoring') {
    return { status: 'error', error: STILL_SCORING_MESSAGE };
  }
  const submissionId = existingSubmission?.id ?? crypto.randomUUID();

  const paths = submissionXmlPaths(user.id, submissionId);
  const { daybookPath, trialbalancePath } = paths;

  const upload = await uploadSubmissionXmlFiles(supabase, paths, {
    daybook: daybookBuffer,
    trialbalance: trialbalanceBuffer,
  });
  if (upload.status === 'failed') {
    return {
      status: 'error',
      error:
        upload.file === 'daybook'
          ? "Something went wrong on my side while saving your Day Book file. Nothing you did wrong, just send both files again."
          : "Something went wrong on my side while saving your Trial Balance file. Nothing you did wrong, just send both files again.",
    };
  }

  if (existingSubmission) {
    await updateSubmissionFilePaths(supabase, submissionId, daybookPath, trialbalancePath);
  } else {
    await insertSubmission(
      supabase,
      submissionId,
      user.id,
      exercise.id,
      daybookPath,
      trialbalancePath,
      { daybook: daybookFile.name, trialbalance: trialbalanceFile.name },
      correctionRound,
    );
  }

  await insertSubmissionPart(supabase, submissionId, 'daybook_xml', { storage_path: daybookPath });
  await insertSubmissionPart(supabase, submissionId, 'trialbalance_xml', { storage_path: trialbalancePath });

  // Plain two-file exercises go straight to run-scoring; multi-part ones wake
  // wait-for-submission once per file.
  //
  // Everything above is already written, so a failed send must not throw
  // (2026-09-16). Unhandled, it left a 'validating' submission with no job and
  // crashed the chat, which is exactly how a live submission was stranded.
  // Returned as an error instead, the files stay attached in the composer and
  // a second Send repairs it (see FILES_SAVED_NOT_STARTED_MESSAGE).
  try {
    await inngest.send(fileSubmissionEvents(submissionId, exercise.requiredParts));
  } catch {
    return { status: 'error', error: FILES_SAVED_NOT_STARTED_MESSAGE };
  }

  const submission: Submission = {
    id: submissionId,
    learner_id: user.id,
    exercise_id: exercise.id,
    daybook_path: daybookPath,
    trialbalance_path: trialbalancePath,
    daybook_filename: daybookFile.name,
    trialbalance_filename: trialbalanceFile.name,
    status: 'validating',
    validity_errors: null,
    correction_round: correctionRound,
    created_at: new Date().toISOString(),
  };

  return { status: 'accepted', submission };
}

export type SubmitTextPartResult =
  | { status: 'accepted'; submission: Submission }
  | { status: 'error'; error: string };

// Server Action: the learner's free-text explain/review answer, sent as an
// ordinary chat message (no special input UI — Composer just routes it
// here instead of the normal chat flow when the active exercise requires a
// text part; see ChatShell.tsx). Joins the exercise's open submission if the
// file parts already arrived first, or creates a new submissions row if this
// text part is the first thing to arrive (out-of-order arrival is the whole
// point of this unit's job).
export async function submitTextPart(text: string, expectedExerciseId?: string): Promise<SubmitTextPartResult> {
  if (!SubmitTextPartInputSchema.safeParse({ text, expectedExerciseId }).success) {
    return { status: 'error', error: SUBMIT_TEXT_PART_INVALID_MESSAGE };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const exercise = await getLatestExercise(supabase, user.id);
  if (!exercise) {
    return { status: 'error', error: "I don't see an active exercise to score this against. Refresh the page, and if there's still nothing, use the Start my training button and I'll set you up." };
  }

  // Smart Send: a confirmed draft carries the exercise it was written for. If
  // the next exercise has arrived since, never file it against that one.
  if (expectedExerciseId !== undefined && exercise.id !== expectedExerciseId) {
    return { status: 'error', error: TEXT_PART_STALE_MESSAGE };
  }

  const partType = textPartTypeFor(exercise.requiredParts);

  if (!partType) {
    return { status: 'error', error: "This exercise is scored from your Tally exports, so I can't take a typed answer for it. If that was a question for me, just ask it again and I'll answer. When you're ready to submit, attach the Day Book and Trial Balance XMLs." };
  }
  if (await hasScoredSubmissionForExercise(supabase, user.id, exercise.id)) {
    return { status: 'error', error: ALREADY_SCORED_MESSAGE };
  }

  const existingSubmission = await getOpenSubmissionForExercise(supabase, user.id, exercise.id);
  if (existingSubmission?.status === 'scoring') {
    return { status: 'error', error: STILL_SCORING_MESSAGE };
  }

  // Smart Send (2026-09-15): the part may already be in (a second tap, another
  // tab). The unique (submission_id, part_type) constraint would otherwise
  // throw out of this action instead of answering the learner.
  if (existingSubmission) {
    const parts = await getSubmissionParts(supabase, existingSubmission.id);
    const received = parts.find((part) => part.part_type === partType);
    if (received) {
      // The SAME text already stored means this is a retry of an answer that
      // was saved but whose event never went out: the send below threw, the
      // card stayed open, and the learner tapped Submit answer again
      // (2026-09-16). Send the event now and report it filed, because it is.
      // Answering "I already have your explanation" here would close the card,
      // and any retyped text would then find the part received and be routed
      // to Q&A: the same dead end Smart Send was just fixed to remove.
      //
      // Re-sending is safe. The job reads parts from the database, not from
      // events, and the singleton skips a duplicate run. A throw here reaches
      // the client's catch, which keeps the card open for another try.
      const storedText = (received.content as { text?: unknown } | null)?.text;
      if (storedText === text) {
        await inngest.send({ name: 'submission/part-received', data: { submissionId: existingSubmission.id, partType } });
        return { status: 'accepted', submission: existingSubmission };
      }
      return {
        status: 'error',
        error: `I already have your ${TEXT_PART_LABEL[partType]} for this exercise, so there's nothing more to send. Your result will show here once it's scored.`,
      };
    }
  }

  // A text-only part has no Storage upload, so unlike submitFiles the id
  // isn't needed before the insert — but it's generated the same way for
  // consistency, and insertSubmission now always takes an explicit id.
  const submissionId = existingSubmission?.id ?? crypto.randomUUID();
  if (!existingSubmission) {
    await insertSubmission(supabase, submissionId, user.id, exercise.id, null, null);
  }

  await insertSubmissionPart(supabase, submissionId, partType, { text });

  // Deliberately NOT caught (2026-09-16), unlike submitFiles. A returned error
  // closes the confirmation card and discards the draft; a thrown one keeps
  // the card open with "Tap Submit answer again" (ChatShell's catch). The part
  // is already saved, so that retry lands in the same-text branch above,
  // which re-sends the event and reports it filed.
  await inngest.send({
    name: 'submission/part-received',
    data: { submissionId, partType },
  });

  const submission: Submission = existingSubmission ?? {
    id: submissionId,
    learner_id: user.id,
    exercise_id: exercise.id,
    // Text parts never open a correction round: explain and review batches
    // are outside the loop (see supportsCorrectionRounds).
    correction_round: 0,
    daybook_path: null,
    trialbalance_path: null,
    daybook_filename: null,
    trialbalance_filename: null,
    status: 'validating',
    validity_errors: null,
    created_at: new Date().toISOString(),
  };

  return { status: 'accepted', submission };
}

export type GetSubmissionStatusResult =
  | { status: 'found'; submissionStatus: SubmissionStatus; validityErrors: ValidityError[] | null }
  | { status: 'not-found' };

// Read once when a PendingSubmission mounts, before/alongside its Realtime
// subscription. Postgres Changes only delivers events that occur *after*
// subscribe() completes, and the background job can finish before the
// subscription is open (the Server Action's own upload latency is enough) —
// so without this catch-up read, a fast job's terminal status update is
// missed permanently and the UI spins forever. The subscription still handles
// the normal case where the job finishes after the client is listening.
export async function getSubmissionStatus(submissionId: string): Promise<GetSubmissionStatusResult> {
  if (!SubmissionIdInputSchema.safeParse({ submissionId }).success) {
    return { status: 'not-found' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // RLS (auth.uid() = learner_id) scopes this to the caller's own submission;
  // a submission belonging to another learner reads as not-found.
  const submission = await getSubmission(supabase, submissionId);
  if (!submission || submission.learner_id !== user.id) {
    return { status: 'not-found' };
  }

  return {
    status: 'found',
    submissionStatus: submission.status,
    validityErrors: submission.validity_errors,
  };
}

export type GetSubmissionPartsStatusResult = {
  requiredParts: SubmissionPartType[];
  receivedParts: SubmissionPartType[];
};

// Feeds the chat's live status checklist ("Daybook ✓ · Trial Balance ✓ ·
// Explanation — waiting"), read once on mount alongside the Realtime
// subscription that keeps it current as parts arrive (see
// useSubmissionParts.ts).
export async function getSubmissionPartsStatus(submissionId: string): Promise<GetSubmissionPartsStatusResult> {
  // No error variant in this result: an invalid id reads as nothing required
  // and nothing received.
  if (!SubmissionIdInputSchema.safeParse({ submissionId }).success) {
    return { requiredParts: [], receivedParts: [] };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const parts = await getSubmissionParts(supabase, submissionId);
  const exercise = await getLatestExercise(supabase, user.id);

  return {
    requiredParts: exercise?.requiredParts ?? [],
    receivedParts: parts.map((part) => part.part_type),
  };
}

export type GetScoringFeedbackResult = { status: 'found'; feedback: Coaching } | { status: 'not-found' };

// Called by the client once its Realtime subscription observes a submission's
// status flip to 'scored' — fetches only the composed feedback fields
// (getFeedbackForLearner already excludes error_codes at the query level).
export async function getScoringFeedback(submissionId: string): Promise<GetScoringFeedbackResult> {
  if (!SubmissionIdInputSchema.safeParse({ submissionId }).success) {
    return { status: 'not-found' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const feedback = await getFeedbackForLearner(supabase, submissionId);
  if (!feedback) {
    return { status: 'not-found' };
  }

  return { status: 'found', feedback: feedback.feedback_text };
}

export type RequestHintResult = { status: 'given'; hint: Hint } | { status: 'error'; error: string };

const NO_EXERCISE_TO_HELP_WITH_MESSAGE = "I couldn't find an active exercise to help with. Refresh the page and try again.";

// Server Action: determines the learner's next rung for this exercise (rung
// selection is derived from prior hint_requests rows, never trusted from the
// client), calls generate-hint.ts grounded in the exercise's answer_key, and
// persists the hint_requests row. Only the composed Hint (rung, hint_text,
// concept_tag) is returned — the answer_key itself never leaves this function.
export async function requestHint(exerciseId: string): Promise<RequestHintResult> {
  if (!RequestHintInputSchema.safeParse({ exerciseId }).success) {
    return { status: 'error', error: NO_EXERCISE_TO_HELP_WITH_MESSAGE };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const serviceRoleClient = createServiceRoleClient();

  const [exercise, answerKey, rung] = await Promise.all([
    getLatestExercise(supabase, user.id),
    getExerciseAnswerKey(serviceRoleClient, exerciseId),
    determineNextRung(supabase, user.id, exerciseId),
  ]);

  if (!exercise || exercise.id !== exerciseId || !answerKey) {
    return { status: 'error', error: NO_EXERCISE_TO_HELP_WITH_MESSAGE };
  }

  // Step-3 reuse (2026-08-27): a later click repeats the stored full answer
  // instead of generating a fresh one (see findReusableDeepHint). No new
  // hint_requests row: depth is already at step 3.
  const reusedHint = await findReusableDeepHint(supabase, user.id, exerciseId, rung);
  if (reusedHint) {
    return { status: 'given', hint: reusedHint };
  }

  let hint: Hint;
  try {
    hint = await generateHint(user.id, {
      rung,
      scenario: exercise.scenario,
      transactions: exercise.transactions,
      answerKey,
      // Authored packs carry their content in files, ~100 transactions —
      // hint steps must never solve arbitrary entries from them.
      packMode: exercise.packFiles.length > 0,
    });
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Hint generation failed.',
    };
  }

  // Uses the authenticated client, not service-role — hint_requests has an
  // insert RLS policy scoped to auth.uid() = learner_id (unlike exercises'
  // answer_key, this row is safe for the learner to write themselves).
  await insertHintRequest(supabase, user.id, exerciseId, hint);

  return { status: 'given', hint };
}

export type GetNextExerciseResult =
  | {
      status: 'found';
      exercise: ExerciseForLearner;
      hintDepth: number;
      moduleTitle: string;
      sourceDocuments: ExerciseSourceDocument[];
    }
  // A correction round opened instead of a new batch (2026-09-16): the
  // learner keeps the exercise they have, reads this help step, and sends
  // corrected exports. Carried on this result rather than a second poll,
  // because the client is already polling here after every scoring.
  | { status: 'correction'; hint: Hint; inviteLine: string; round: number }
  | { status: 'not-found' };

// Called by PendingSubmission once its Realtime subscription observes a
// submission's status flip to 'scored' and the caller has confirmed a newer
// exercise now exists — the mastery recompute + adaptive generation steps
// (lib/jobs/run-scoring.ts) already ran server-side by that point, so the
// learner's latest exercise is the freshly generated adaptive one. This is
// the auto-delivery path: the learner never has to ask for the next
// exercise, per the spec.
export async function getNextExercise(previousExerciseId: string): Promise<GetNextExerciseResult> {
  if (!GetNextExerciseInputSchema.safeParse({ previousExerciseId }).success) {
    return { status: 'not-found' };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const exercise = await getLatestExercise(supabase, user.id);
  if (!exercise) {
    return { status: 'not-found' };
  }

  // Still on the same exercise: either the next batch is still generating
  // (keep polling) or a correction round opened and this is its help step.
  if (exercise.id === previousExerciseId) {
    const latestScored = await getLatestScoredSubmissionForExercise(supabase, user.id, exercise.id);
    if (!latestScored) {
      return { status: 'not-found' };
    }

    const anyConceptFailed = await hasFailedConceptForSubmission(supabase, user.id, latestScored.id);
    if (
      !isCorrectionOpen({
        requiredParts: exercise.requiredParts,
        latestRound: latestScored.correction_round,
        anyConceptFailed,
      })
    ) {
      return { status: 'not-found' };
    }

    // The job writes the hint a moment after scoring flips the status, so a
    // miss here just means "not yet": the caller keeps polling.
    const hint = await getLatestHintForExerciseAfter(supabase, user.id, exercise.id, latestScored.created_at);
    if (!hint) {
      return { status: 'not-found' };
    }

    const round = latestScored.correction_round + 1;
    return { status: 'correction', hint, inviteLine: correctionInviteLine(round), round };
  }

  const [hintDepth, masteryMap, sourceDocuments] = await Promise.all([
    getHintDepthForExercise(supabase, user.id, exercise.id),
    getConceptMasteryMap(supabase, user.id),
    getExerciseSourceDocuments(supabase, exercise.id),
  ]);

  return {
    status: 'found',
    exercise,
    hintDepth,
    moduleTitle: currentMajorModule(masteryMap).title,
    sourceDocuments,
  };
}

export type AskQuestionResult =
  | { status: 'answered'; answer: string }
  | { status: 'error'; error: string };

// Unit 15R: free-form tutor Q&A. Grounded in the Rulebook and the active
// exercise's learner-facing scenario only — the answer key never enters the
// prompt context (answer-question.ts's QaContext has no field for it).
export async function askQuestion(question: string): Promise<AskQuestionResult> {
  const parsed = AskQuestionInputSchema.safeParse({ question });
  if (!parsed.success) {
    return { status: 'error', error: ASK_QUESTION_INVALID_MESSAGE };
  }
  const trimmed = parsed.data.question;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const exercise = await getLatestExercise(supabase, user.id);

  // Answer + persist the exchange (lib/chat/answer-learner-question.ts, shared
  // with Smart Send routing).
  return answerLearnerQuestion({
    supabase,
    learnerId: user.id,
    question: trimmed,
    exerciseScenario: exercise?.scenario ?? null,
  });
}

export type SendTypedMessageResult = RouteTypedMessageResult;

// Smart Send (2026-09-15): everything the learner types with no files
// attached. A question comes back answered. On an explain/review exercise an
// answer comes back as needs-confirmation and is filed only when the learner
// taps Submit answer (which calls submitTextPart). Routing, the rules and the
// LLM tie-break live in lib/chat/route-typed-message.ts.
export async function sendTypedMessage(text: string): Promise<SendTypedMessageResult> {
  const parsed = SendTypedMessageInputSchema.safeParse({ text });
  if (!parsed.success) {
    return { status: 'error', error: parsed.error.issues[0]?.message ?? SEND_TYPED_MESSAGE_EMPTY_MESSAGE };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  try {
    return await routeTypedMessage({ supabase, learnerId: user.id, text: parsed.data.text });
  } catch {
    return { status: 'error', error: "I couldn't read that just now. Please send it again." };
  }
}

export type ReportIssueResult = ReportIssueOutcome;

// Learner issue reports (2026-09-15): the chat's "Report an issue" box. The
// issue is stored for the owner with a snapshot of the learner's current
// batch and is never sent to the tutor or any LLM. Validation, the duplicate
// and hourly limits, and the service-role write all live in
// lib/chat/report-issue.ts; this action only checks the message is text and
// authenticates.
export async function reportIssue(message: string): Promise<ReportIssueResult> {
  if (!ReportIssueActionInputSchema.safeParse({ message }).success) {
    return { status: 'error', error: REPORT_ISSUE_INVALID_MESSAGE };
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  return reportLearnerIssue({
    supabase,
    serviceRoleClient: createServiceRoleClient(),
    learnerId: user.id,
    rawMessage: message,
  });
}

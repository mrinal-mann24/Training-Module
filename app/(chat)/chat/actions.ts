'use server';

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { createServiceRoleClient } from '@/lib/supabase/service-role';
import {
  completeWalkthrough,
  getLearnerProfile,
  hasCompletedWalkthrough,
} from '@/lib/db/queries/learner-profile';
import { generateDiagnosticExercise } from '@/lib/tutor/generate-exercise';
import { assignPackDiagnostic } from '@/lib/tutor/assign-pack-exercise';
import { getSignedPackFileCards, freshSignedUrlForPackFile } from '@/lib/db/queries/exercise-packs';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import { getExerciseAnswerKey, getLatestDiagnosticExercise, getLatestExercise } from '@/lib/db/queries/exercises';
import {
  insertSubmission,
  getOpenSubmissionForExercise,
  updateSubmissionFilePaths,
  getSubmission,
} from '@/lib/db/queries/submissions';
import type { Submission, SubmissionStatus } from '@/lib/db/queries/submissions';
import type { ValidityError } from '@/lib/tutor/submission-gate';
import { getFeedbackForLearner } from '@/lib/db/queries/scoring-results';
import { insertHintRequest, getHintDepthForExercise, getLatestDeepHintForExercise } from '@/lib/db/queries/hint-requests';
import { getModuleNumber } from '@/lib/db/queries/mastery';
import { inngest } from '@/lib/jobs/client';
import type { Coaching } from '@/lib/schemas/coaching';
import type { OverallResult } from '@/lib/schemas/scoring';
import type { Hint } from '@/lib/schemas/hint';
import type { SourceDocumentType } from '@/lib/schemas/source-document';
import type { SubmissionPartType } from '@/lib/schemas/exercise';
import { determineNextRung } from '@/lib/tutor/hint-ladder';
import { generateHint } from '@/lib/tutor/generate-hint';
import { answerQuestion } from '@/lib/tutor/answer-question';
import {
  getSourceDocumentsForExercise,
  getSignedSourceDocumentUrls,
  freshSignedUrlForDocument,
} from '@/lib/db/queries/source-documents';
import { insertSubmissionPart, getSubmissionParts } from '@/lib/db/queries/submission-parts';
import { identifyTallyFile } from '@/lib/parsing/identify-tally-file';
import { insertQaMessage } from '@/lib/db/queries/qa-messages';

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
      // Unit 14R: the diagnostic is the authored pack (pilot program's Day-1
      // file set + personalized message), assigned with no LLM call. Falls
      // back to the original generated diagnostic only if no pack is seeded
      // for the learner's variant, so an unseeded environment still works.
      const profile = await getLearnerProfile(supabase, user.id);
      const assigned = await assignPackDiagnostic(serviceRoleClient, user.id, profile?.full_name ?? null);
      if (!assigned) {
        await generateDiagnosticExercise(serviceRoleClient, user.id);
      }
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

// Server Action: authenticates, uploads both XML files to learner-scoped
// Storage paths, creates (or joins, for a multi-part exercise where a
// text part already arrived first) the submissions row, records both file
// parts in submission_parts, then sends the appropriate Inngest event and
// returns immediately. It does not await parsing, the gate, scoring, or
// coaching — those run in a background job, and the client picks up the
// result via a Supabase Realtime subscription on this row.
//
// Unit 11: exercises with exactly the original two required parts
// (diagnostic/adaptive — daybook_xml + trialbalance_xml) keep sending
// submission/uploaded, routing through Unit 07's original run-scoring job
// unchanged, per the spec's explicit "don't route simple submissions through
// the more complex waiting logic unnecessarily." An 'explain' exercise has
// more than two required parts (also needs explain_text), so it routes
// through submission/part-received into wait-for-submission.ts instead.
export async function submitFiles(formData: FormData): Promise<SubmitFilesResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  // GPT-style composer (2026-08-24): files arrive through one generic upload
  // control, unlabeled — which one is the Day Book and which the Trial
  // Balance is decided by CONTENT (identifyTallyFile), never by filename or
  // by which button was clicked. Extra files beyond the recognized pair are
  // ignored (the client has already confirmed proceeding with the pair).
  const uploaded = formData.getAll('files').filter((entry): entry is File => entry instanceof File);

  if (uploaded.length < 2) {
    return {
      status: 'error',
      error: "I need both exports to score your work: the Day Book and the Trial Balance. Attach the two files together and hit Send, and I'll take it from there.",
    };
  }

  if (uploaded.some((file) => !file.name.toLowerCase().endsWith('.xml'))) {
    return { status: 'error', error: "One of those files isn't a Tally XML export, so I can't read it. In Tally, export the Day Book (Detailed) and the Trial Balance as XML, then send me both." };
  }

  const classified = await Promise.all(
    uploaded.map(async (file) => {
      const buffer = Buffer.from(await file.arrayBuffer());
      return { file, buffer, kind: identifyTallyFile(buffer) };
    }),
  );

  const daybookUpload = classified.find((entry) => entry.kind === 'daybook');
  const trialbalanceUpload = classified.find((entry) => entry.kind === 'trialbalance');

  if (!daybookUpload || !trialbalanceUpload) {
    const readableKinds = classified
      .map((entry) => {
        const label =
          entry.kind === 'daybook' ? 'a Day Book' : entry.kind === 'trialbalance' ? 'a Trial Balance' : 'not a Tally export I recognize';
        return `"${entry.file.name}" looks like ${label}`;
      })
      .join('; ');
    return {
      status: 'error',
      error: `I couldn't find both files in what you attached: ${readableKinds}. I need one Detailed Day Book export and one Trial Balance export. Check the exports in Tally and send both again.`,
    };
  }

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

  const daybookBuffer = daybookUpload.buffer;
  const trialbalanceBuffer = trialbalanceUpload.buffer;

  // Joins an already-open submission for this exercise (a text part may have
  // arrived first, out of order) rather than always creating a new row —
  // see getOpenSubmissionForExercise's comment.
  const existingSubmission = await getOpenSubmissionForExercise(supabase, user.id, exercise.id);
  const submissionId = existingSubmission?.id ?? crypto.randomUUID();

  const daybookPath = `${user.id}/${submissionId}/daybook.xml`;
  const trialbalancePath = `${user.id}/${submissionId}/trialbalance.xml`;

  const { error: daybookUploadError } = await supabase.storage
    .from('submissions')
    .upload(daybookPath, daybookBuffer, { contentType: 'application/xml' });
  if (daybookUploadError) {
    return { status: 'error', error: "Something went wrong on my side while saving your Day Book file. Nothing you did wrong, just send both files again." };
  }

  const { error: trialbalanceUploadError } = await supabase.storage
    .from('submissions')
    .upload(trialbalancePath, trialbalanceBuffer, { contentType: 'application/xml' });
  if (trialbalanceUploadError) {
    return {
      status: 'error',
      error: "Something went wrong on my side while saving your Trial Balance file. Nothing you did wrong, just send both files again.",
    };
  }

  if (existingSubmission) {
    await updateSubmissionFilePaths(supabase, submissionId, daybookPath, trialbalancePath);
  } else {
    await insertSubmission(supabase, submissionId, user.id, exercise.id, daybookPath, trialbalancePath, {
      daybook: daybookFile.name,
      trialbalance: trialbalanceFile.name,
    });
  }

  await insertSubmissionPart(supabase, submissionId, 'daybook_xml', { storage_path: daybookPath });
  await insertSubmissionPart(supabase, submissionId, 'trialbalance_xml', { storage_path: trialbalancePath });

  const isSimpleTwoFileExercise = exercise.requiredParts.length === 2;

  if (isSimpleTwoFileExercise) {
    await inngest.send({ name: 'submission/uploaded', data: { submissionId } });
  } else {
    // Two events, one per part type — wait-for-submission.ts's per-part
    // waitForEvent calls match on partType, so whichever specific part the
    // job is actually parked waiting on (if either) needs its own event to
    // be woken correctly, not one event carrying an arbitrary part type.
    await inngest.send([
      { name: 'submission/part-received', data: { submissionId, partType: 'daybook_xml' as SubmissionPartType } },
      { name: 'submission/part-received', data: { submissionId, partType: 'trialbalance_xml' as SubmissionPartType } },
    ]);
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
export async function submitTextPart(text: string): Promise<SubmitTextPartResult> {
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

  const partType: SubmissionPartType | null = exercise.requiredParts.includes('explain_text')
    ? 'explain_text'
    : exercise.requiredParts.includes('review_text')
      ? 'review_text'
      : null;

  if (!partType) {
    return { status: 'error', error: "This exercise is scored from your Tally exports, so I can't take a typed answer for it. If that was a question for me, just ask it again and I'll answer. When you're ready to submit, attach the Day Book and Trial Balance XMLs." };
  }

  const existingSubmission = await getOpenSubmissionForExercise(supabase, user.id, exercise.id);

  // A text-only part has no Storage upload, so unlike submitFiles the id
  // isn't needed before the insert — but it's generated the same way for
  // consistency, and insertSubmission now always takes an explicit id.
  const submissionId = existingSubmission?.id ?? crypto.randomUUID();
  if (!existingSubmission) {
    await insertSubmission(supabase, submissionId, user.id, exercise.id, null, null);
  }

  await insertSubmissionPart(supabase, submissionId, partType, { text });

  await inngest.send({
    name: 'submission/part-received',
    data: { submissionId, partType },
  });

  const submission: Submission = existingSubmission ?? {
    id: submissionId,
    learner_id: user.id,
    exercise_id: exercise.id,
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

export type GetScoringFeedbackResult =
  | { status: 'found'; overallResult: OverallResult; feedback: Coaching }
  | { status: 'not-found' };

// Called by the client once its Realtime subscription observes a submission's
// status flip to 'scored' — fetches only the composed feedback fields
// (getFeedbackForLearner already excludes error_codes at the query level).
export async function getScoringFeedback(submissionId: string): Promise<GetScoringFeedbackResult> {
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

  return { status: 'found', overallResult: feedback.overall_result, feedback: feedback.feedback_text };
}

export type RequestHintResult = { status: 'given'; hint: Hint } | { status: 'error'; error: string };

// Server Action: determines the learner's next rung for this exercise (rung
// selection is derived from prior hint_requests rows, never trusted from the
// client), calls generate-hint.ts grounded in the exercise's answer_key, and
// persists the hint_requests row. Only the composed Hint (rung, hint_text,
// concept_tag) is returned — the answer_key itself never leaves this function.
export async function requestHint(exerciseId: string): Promise<RequestHintResult> {
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
    return { status: 'error', error: "I couldn't find an active exercise to help with. Refresh the page and try again." };
  }

  // Step-3 reuse (2026-08-27): once the full answer exists for this
  // exercise, every later click repeats THAT stored answer instead of
  // generating a fresh one. Regeneration picked a different random
  // transaction per click on pack exercises, leaking the authored key one
  // entry at a time. No new hint_requests row: depth is already at step 3.
  if (rung === 3) {
    const existingDeepHint = await getLatestDeepHintForExercise(supabase, user.id, exerciseId);
    if (existingDeepHint) {
      return { status: 'given', hint: { ...existingDeepHint.hint_content, rung: 3 } };
    }
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
      moduleNumber: number;
      sourceDocuments: ExerciseSourceDocument[];
    }
  | { status: 'not-found' };

// Called by PendingSubmission once its Realtime subscription observes a
// submission's status flip to 'scored' and the caller has confirmed a newer
// exercise now exists — the mastery recompute + adaptive generation steps
// (lib/jobs/run-scoring.ts) already ran server-side by that point, so the
// learner's latest exercise is the freshly generated adaptive one. This is
// the auto-delivery path: the learner never has to ask for the next
// exercise, per the spec.
export async function getNextExercise(previousExerciseId: string): Promise<GetNextExerciseResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const exercise = await getLatestExercise(supabase, user.id);
  if (!exercise || exercise.id === previousExerciseId) {
    return { status: 'not-found' };
  }

  const [hintDepth, moduleNumber, sourceDocuments] = await Promise.all([
    getHintDepthForExercise(supabase, user.id, exercise.id),
    getModuleNumber(supabase, user.id),
    getExerciseSourceDocuments(supabase, exercise.id),
  ]);

  return { status: 'found', exercise, hintDepth, moduleNumber, sourceDocuments };
}

export type AskQuestionResult =
  | { status: 'answered'; answer: string }
  | { status: 'error'; error: string };

// Unit 15R: free-form tutor Q&A. Grounded in the Rulebook and the active
// exercise's learner-facing scenario only — the answer key never enters the
// prompt context (answer-question.ts's QaContext has no field for it).
export async function askQuestion(question: string): Promise<AskQuestionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect('/login');
  }

  const trimmed = question.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) {
    return { status: 'error', error: "That message is a bit too long for me to take in one go. Keep it under 2000 characters and I'm happy to help." };
  }

  const exercise = await getLatestExercise(supabase, user.id);

  try {
    const response = await answerQuestion(user.id, {
      question: trimmed,
      exerciseScenario: exercise?.scenario ?? null,
    });
    // Persisted so the exchange survives a refresh (chat-history rebuild,
    // 2026-08-24). A failed insert must not eat the answer the learner is
    // waiting on — history just won't carry this one exchange.
    try {
      await insertQaMessage(supabase, user.id, trimmed, response.answer);
    } catch {
      // non-fatal
    }
    return { status: 'answered', answer: response.answer };
  } catch (error) {
    return {
      status: 'error',
      error: error instanceof Error ? error.message : 'Could not answer right now. Please try again.',
    };
  }
}

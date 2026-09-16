import { z } from 'zod';

// Input boundaries for the chat Server Actions in app/(chat)/chat/actions.ts.
// Each action parses its arguments with one of these before it
// authenticates, and answers invalid input with its own existing result
// shape. The rules mirror what the actions already accepted; the only new
// limits are the caps marked ASSUMPTION on inputs that used to be unbounded.
// A schema without a transform hands back its input unchanged, so an action
// may keep using its own parameters once the parse succeeds.

// Every row id the chat sends back came from a Postgres uuid column or
// crypto.randomUUID(). z.guid() accepts any 8-4-4-4-12 hex id; z.uuid() would
// also enforce RFC version bits and turn away hand-seeded ids. A malformed id
// used to fail inside the database query instead.
const RowIdSchema = z.guid();

// ASSUMPTION: new cap on values that are only compared or used as a lookup
// key (a pack file's storage path, a previous exercise id). Real values are
// well under 100 characters.
export const OPAQUE_ID_MAX_LENGTH = 1024;

export const RefreshDocumentUrlInputSchema = z.object({
  // A generated document's row id, or a pack file's storage path.
  documentId: z.string().min(1).max(OPAQUE_ID_MAX_LENGTH),
  kind: z.enum(['source-document', 'pack-file']),
});

export const SUBMIT_FILES_NEED_BOTH_MESSAGE =
  "I need both exports to score your work: the Day Book and the Trial Balance. Attach the two files together and hit Send, and I'll take it from there.";
export const SUBMIT_FILES_TOO_MANY_MESSAGE =
  "That's more files than I can take in one go. Attach just the Day Book and Trial Balance exports and send them again.";
export const SUBMIT_FILES_NOT_XML_MESSAGE =
  "One of those files isn't a Tally XML export, so I can't read it. In Tally, export the Day Book (Detailed) and the Trial Balance as XML, then send me both.";

// ASSUMPTION: new cap. A learner sends the Day Book and Trial Balance pair,
// sometimes with a stray extra; every file is parsed on the server.
export const SUBMIT_FILES_MAX_COUNT = 20;

// `files` is formData.getAll('files'). Entries that are not files are
// dropped, not rejected. Then two files are the minimum and every file must
// be named .xml (any case). When several rules fail, the first issue is the
// count, then the extension: the order the action always checked them in.
// Which file is which is decided later, by content.
export const SubmitFilesInputSchema = z.object({
  files: z
    .array(z.unknown())
    .transform((entries) => entries.filter((entry): entry is File => entry instanceof File))
    .pipe(
      z
        .array(z.instanceof(File))
        .min(2, SUBMIT_FILES_NEED_BOTH_MESSAGE)
        .max(SUBMIT_FILES_MAX_COUNT, SUBMIT_FILES_TOO_MANY_MESSAGE)
        .refine(
          (files) => files.every((file) => file.name.toLowerCase().endsWith('.xml')),
          SUBMIT_FILES_NOT_XML_MESSAGE,
        ),
    ),
});

// ASSUMPTION: new cap. Typed explanations and reviews run to a few
// paragraphs and the composer sets no limit, so this sits far above any real
// answer. The text is not trimmed and may be empty, as before.
export const TEXT_PART_MAX_LENGTH = 20000;
export const SUBMIT_TEXT_PART_INVALID_MESSAGE = `I couldn't take that answer. Keep it under ${TEXT_PART_MAX_LENGTH} characters and send it again.`;

export const SubmitTextPartInputSchema = z.object({
  text: z.string().max(TEXT_PART_MAX_LENGTH),
  // Smart Send: the exercise a confirmed draft was written for. When present,
  // the action refuses to file the text against any other exercise.
  expectedExerciseId: RowIdSchema.optional(),
});

export const TEXT_PART_STALE_MESSAGE =
  "That answer was for your previous exercise, so I didn't file it. Type your answer for the new exercise and send it.";

export const SEND_TYPED_MESSAGE_EMPTY_MESSAGE = 'Type a message before sending.';
export const SEND_TYPED_MESSAGE_TOO_LONG_MESSAGE = `That's too long for one message. Please keep it under ${TEXT_PART_MAX_LENGTH} characters.`;

// Smart Send (2026-09-15): anything typed with no files attached. Trimmed,
// then 1 to TEXT_PART_MAX_LENGTH characters, the ceiling a typed answer
// already has. Routing decides afterwards whether it is a question (which must
// then also fit AskQuestionInputSchema) or an answer awaiting confirmation.
export const SendTypedMessageInputSchema = z.object({
  text: z
    .string()
    .trim()
    .min(1, SEND_TYPED_MESSAGE_EMPTY_MESSAGE)
    .max(TEXT_PART_MAX_LENGTH, SEND_TYPED_MESSAGE_TOO_LONG_MESSAGE),
});

// getSubmissionStatus, getSubmissionPartsStatus and getScoringFeedback.
export const SubmissionIdInputSchema = z.object({
  submissionId: RowIdSchema,
});

export const RequestHintInputSchema = z.object({
  exerciseId: RowIdSchema,
});

// The previous exercise id is only compared with the latest exercise's id,
// never queried, so any string has always been accepted.
export const GetNextExerciseInputSchema = z.object({
  previousExerciseId: z.string().max(OPAQUE_ID_MAX_LENGTH),
});

export const QUESTION_MAX_LENGTH = 2000;
// The action's original wording, used for an empty question as well as a
// long one.
export const ASK_QUESTION_INVALID_MESSAGE = `That message is a bit too long for me to take in one go. Keep it under ${QUESTION_MAX_LENGTH} characters and I'm happy to help.`;

// Trimmed first, then 1 to 2000 characters: exactly the original check. The
// parsed question is the trimmed text the tutor answers and history stores.
export const AskQuestionInputSchema = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX_LENGTH),
});

// The message rules (control characters stripped, trimmed, 1 to 2000
// characters) and their wording live in ReportIssueInputSchema, applied
// inside lib/chat/report-issue.ts. The action boundary only checks that the
// message is text; a non-string gets the answer that module gives an empty
// message.
export const REPORT_ISSUE_INVALID_MESSAGE = 'Type your issue before sending.';

export const ReportIssueActionInputSchema = z.object({
  message: z.string(),
});

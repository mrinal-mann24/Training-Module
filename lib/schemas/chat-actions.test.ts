import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ASK_QUESTION_INVALID_MESSAGE,
  AskQuestionInputSchema,
  GetNextExerciseInputSchema,
  OPAQUE_ID_MAX_LENGTH,
  QUESTION_MAX_LENGTH,
  REPORT_ISSUE_INVALID_MESSAGE,
  RefreshDocumentUrlInputSchema,
  ReportIssueActionInputSchema,
  RequestHintInputSchema,
  SEND_TYPED_MESSAGE_EMPTY_MESSAGE,
  SEND_TYPED_MESSAGE_TOO_LONG_MESSAGE,
  SendTypedMessageInputSchema,
  SUBMIT_FILES_MAX_COUNT,
  SUBMIT_FILES_NEED_BOTH_MESSAGE,
  SUBMIT_FILES_NOT_XML_MESSAGE,
  SUBMIT_FILES_TOO_MANY_MESSAGE,
  SUBMIT_TEXT_PART_INVALID_MESSAGE,
  SubmissionIdInputSchema,
  SubmitFilesInputSchema,
  SubmitTextPartInputSchema,
  TEXT_PART_MAX_LENGTH,
} from './chat-actions';

function xmlExport(name: string): File {
  return new File(['<ENVELOPE/>'], name);
}

// A seeded id that is not an RFC-versioned uuid, but is a valid Postgres uuid.
const HAND_SEEDED_ID = '11111111-1111-1111-1111-111111111111';

describe('RefreshDocumentUrlInputSchema', () => {
  it('accepts a generated document row id and a pack file storage path', () => {
    expect(RefreshDocumentUrlInputSchema.safeParse({ documentId: randomUUID(), kind: 'source-document' }).success).toBe(true);
    expect(
      RefreshDocumentUrlInputSchema.safeParse({ documentId: 'pack-a/opening-trial-balance.xlsx', kind: 'pack-file' }).success,
    ).toBe(true);
  });

  it('rejects an empty id, an overlong id and an unknown kind', () => {
    expect(RefreshDocumentUrlInputSchema.safeParse({ documentId: '', kind: 'pack-file' }).success).toBe(false);
    expect(
      RefreshDocumentUrlInputSchema.safeParse({ documentId: 'p'.repeat(OPAQUE_ID_MAX_LENGTH + 1), kind: 'pack-file' }).success,
    ).toBe(false);
    expect(RefreshDocumentUrlInputSchema.safeParse({ documentId: randomUUID(), kind: 'certificate' }).success).toBe(false);
  });
});

describe('SubmitFilesInputSchema', () => {
  it('drops entries that are not files and keeps the files in upload order', () => {
    const result = SubmitFilesInputSchema.safeParse({ files: ['stray text', xmlExport('a.xml'), xmlExport('b.XML')] });

    expect(result.success).toBe(true);
    expect(result.data?.files.map((file) => file.name)).toEqual(['a.xml', 'b.XML']);
  });

  it('asks for both exports when fewer than two files arrive, before checking the extension', () => {
    expect(SubmitFilesInputSchema.safeParse({ files: [xmlExport('notes.txt')] }).error?.issues[0]?.message).toBe(
      SUBMIT_FILES_NEED_BOTH_MESSAGE,
    );
    expect(SubmitFilesInputSchema.safeParse({ files: ['stray text', xmlExport('a.xml')] }).error?.issues[0]?.message).toBe(
      SUBMIT_FILES_NEED_BOTH_MESSAGE,
    );
    expect(SubmitFilesInputSchema.safeParse({ files: [] }).error?.issues[0]?.message).toBe(SUBMIT_FILES_NEED_BOTH_MESSAGE);
  });

  it('rejects a file that is not named .xml', () => {
    expect(
      SubmitFilesInputSchema.safeParse({ files: [xmlExport('daybook.xml'), xmlExport('tb.pdf')] }).error?.issues[0]?.message,
    ).toBe(SUBMIT_FILES_NOT_XML_MESSAGE);
  });

  it('accepts up to the file cap and turns away more', () => {
    const files = (count: number) => Array.from({ length: count }, (_, index) => xmlExport(`export-${index}.xml`));

    expect(SubmitFilesInputSchema.safeParse({ files: files(SUBMIT_FILES_MAX_COUNT) }).success).toBe(true);
    expect(SubmitFilesInputSchema.safeParse({ files: files(SUBMIT_FILES_MAX_COUNT + 1) }).error?.issues[0]?.message).toBe(
      SUBMIT_FILES_TOO_MANY_MESSAGE,
    );
  });

  it('keeps the wording the action has always used', () => {
    expect(SUBMIT_FILES_NEED_BOTH_MESSAGE).toBe(
      "I need both exports to score your work: the Day Book and the Trial Balance. Attach the two files together and hit Send, and I'll take it from there.",
    );
    expect(SUBMIT_FILES_NOT_XML_MESSAGE).toBe(
      "One of those files isn't a Tally XML export, so I can't read it. In Tally, export the Day Book (Detailed) and the Trial Balance as XML, then send me both.",
    );
  });
});

describe('SubmitTextPartInputSchema', () => {
  it('keeps the text exactly as sent, including surrounding space and an empty answer', () => {
    expect(SubmitTextPartInputSchema.safeParse({ text: '  Rent is an expense.  ' }).data?.text).toBe('  Rent is an expense.  ');
    expect(SubmitTextPartInputSchema.safeParse({ text: '' }).success).toBe(true);
  });

  it('accepts text up to the cap and rejects anything longer or not text', () => {
    expect(SubmitTextPartInputSchema.safeParse({ text: 'a'.repeat(TEXT_PART_MAX_LENGTH) }).success).toBe(true);
    expect(SubmitTextPartInputSchema.safeParse({ text: 'a'.repeat(TEXT_PART_MAX_LENGTH + 1) }).success).toBe(false);
    expect(SubmitTextPartInputSchema.safeParse({ text: 42 }).success).toBe(false);
  });

  it('tells the learner the limit', () => {
    expect(SUBMIT_TEXT_PART_INVALID_MESSAGE).toContain(`${TEXT_PART_MAX_LENGTH} characters`);
  });
});

describe('row id schemas', () => {
  it.each([
    ['SubmissionIdInputSchema', (id: unknown) => SubmissionIdInputSchema.safeParse({ submissionId: id }).success],
    ['RequestHintInputSchema', (id: unknown) => RequestHintInputSchema.safeParse({ exerciseId: id }).success],
  ])('%s accepts generated and hand-seeded uuids and nothing else', (_name, accepts) => {
    expect(accepts(randomUUID())).toBe(true);
    expect(accepts(HAND_SEEDED_ID)).toBe(true);
    expect(accepts('not-an-id')).toBe(false);
    expect(accepts('')).toBe(false);
    expect(accepts(42)).toBe(false);
  });
});

describe('GetNextExerciseInputSchema', () => {
  it('accepts any string up to the cap, because the id is only compared', () => {
    expect(GetNextExerciseInputSchema.safeParse({ previousExerciseId: '' }).success).toBe(true);
    expect(GetNextExerciseInputSchema.safeParse({ previousExerciseId: randomUUID() }).success).toBe(true);
    expect(GetNextExerciseInputSchema.safeParse({ previousExerciseId: 'x'.repeat(OPAQUE_ID_MAX_LENGTH + 1) }).success).toBe(
      false,
    );
    expect(GetNextExerciseInputSchema.safeParse({ previousExerciseId: null }).success).toBe(false);
  });
});

describe('AskQuestionInputSchema', () => {
  it('hands back the trimmed question', () => {
    expect(AskQuestionInputSchema.safeParse({ question: '  What is GST?  ' }).data?.question).toBe('What is GST?');
  });

  it('measures the length after trimming, as the action always did', () => {
    expect(AskQuestionInputSchema.safeParse({ question: `  ${'q'.repeat(QUESTION_MAX_LENGTH)}  ` }).success).toBe(true);
    expect(AskQuestionInputSchema.safeParse({ question: 'q'.repeat(QUESTION_MAX_LENGTH + 1) }).success).toBe(false);
  });

  it('rejects a blank question and anything that is not text', () => {
    expect(AskQuestionInputSchema.safeParse({ question: '   ' }).success).toBe(false);
    expect(AskQuestionInputSchema.safeParse({ question: 42 }).success).toBe(false);
  });

  it('keeps the wording the action has always used', () => {
    expect(ASK_QUESTION_INVALID_MESSAGE).toBe(
      "That message is a bit too long for me to take in one go. Keep it under 2000 characters and I'm happy to help.",
    );
  });
});

describe('SendTypedMessageInputSchema', () => {
  it('trims the text and accepts up to the typed-answer cap', () => {
    expect(SendTypedMessageInputSchema.parse({ text: '  which ledger?  ' })).toEqual({ text: 'which ledger?' });
    expect(SendTypedMessageInputSchema.safeParse({ text: 'x'.repeat(TEXT_PART_MAX_LENGTH) }).success).toBe(true);
  });

  it('rejects an empty message with the empty wording', () => {
    const result = SendTypedMessageInputSchema.safeParse({ text: '   ' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(SEND_TYPED_MESSAGE_EMPTY_MESSAGE);
  });

  it('rejects an over-long message with the length wording', () => {
    const result = SendTypedMessageInputSchema.safeParse({ text: 'x'.repeat(TEXT_PART_MAX_LENGTH + 1) });
    expect(result.error?.issues[0]?.message).toBe(SEND_TYPED_MESSAGE_TOO_LONG_MESSAGE);
  });

  it('rejects a non-string', () => {
    expect(SendTypedMessageInputSchema.safeParse({ text: 42 }).success).toBe(false);
  });
});

describe('SubmitTextPartInputSchema expectedExerciseId', () => {
  it('accepts a draft tied to an exercise id or none, and rejects a malformed id', () => {
    expect(SubmitTextPartInputSchema.safeParse({ text: 'x', expectedExerciseId: randomUUID() }).success).toBe(true);
    expect(SubmitTextPartInputSchema.safeParse({ text: 'x' }).success).toBe(true);
    expect(SubmitTextPartInputSchema.safeParse({ text: 'x', expectedExerciseId: 'not-an-id' }).success).toBe(false);
  });
});

describe('ReportIssueActionInputSchema', () => {
  it('only requires text, leaving the message rules to the issue module', () => {
    expect(ReportIssueActionInputSchema.safeParse({ message: '' }).success).toBe(true);
    expect(ReportIssueActionInputSchema.safeParse({ message: 'x'.repeat(5000) }).success).toBe(true);
    expect(ReportIssueActionInputSchema.safeParse({ message: null }).success).toBe(false);
  });

  it('answers a non-string with the issue module wording for an empty message', () => {
    expect(REPORT_ISSUE_INVALID_MESSAGE).toBe('Type your issue before sending.');
  });
});

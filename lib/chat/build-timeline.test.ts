import { describe, expect, it } from 'vitest';
import { assembleTimeline } from './build-timeline';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { Submission } from '@/lib/db/queries/submissions';

function exercise(id: string, createdAt: string): ExerciseForLearner {
  return {
    id,
    kind: 'diagnostic',
    scenario: `Scenario ${id}`,
    transactions: [{ sequence: 1, description: 'Sold goods' }],
    packFiles: [],
    expectedVoucherCount: null,
    reviewPacketItems: [],
    difficulty_level: 'L0',
    variant: 'A',
    requiredParts: ['daybook_xml', 'trialbalance_xml'],
    created_at: createdAt,
  };
}

function submission(id: string, createdAt: string, overrides: Partial<Submission> = {}): Submission {
  return {
    id,
    learner_id: 'learner-1',
    exercise_id: 'ex-1',
    daybook_path: 'p/daybook.xml',
    trialbalance_path: 'p/trialbalance.xml',
    daybook_filename: 'My Daybook.xml',
    trialbalance_filename: 'My TB.xml',
    status: 'scored',
    validity_errors: null,
    created_at: createdAt,
    ...overrides,
  };
}

describe('assembleTimeline', () => {
  it('orders the full conversation chronologically with stable tiebreaks', () => {
    const messages = assembleTimeline({
      exercises: [exercise('ex-1', '2026-08-01T10:00:00Z'), exercise('ex-2', '2026-08-01T12:00:00Z')],
      submissions: [submission('sub-1', '2026-08-01T11:00:00Z')],
      feedbacks: [
        {
          submission_id: 'sub-1',
          overall_result: 'partial',
          feedback_text: { opening_line: 'r', went_well: ['p'], needs_work: [], next_note: 'n' },
          created_at: '2026-08-01T11:30:00Z',
        },
      ],
      hints: [
        {
          id: 'h1',
          exercise_id: 'ex-1',
          learner_id: 'learner-1',
          rung: 1,
          hint_content: { rung: 1, hint_text: 'look again', concept_tag: 'gst_classification' },
          created_at: '2026-08-01T10:30:00Z',
        },
      ],
      qaMessages: [
        { id: 'q1', question: 'which ledger?', answer: 'Recruitment Charges', created_at: '2026-08-01T10:15:00Z' },
      ],
      sourceDocumentsByExercise: new Map(),
      currentModuleNumber: 1,
    });

    expect(messages.map((message) => message.id)).toEqual([
      'exercise-ex-1',
      'qa-q-q1',
      'qa-a-q1',
      'hint-h1',
      'submission-sub-1',
      'submission-result-sub-1',
      'exercise-ex-2',
    ]);
  });

  it('renders real filenames as chips and a corrective message for invalid submissions', () => {
    const messages = assembleTimeline({
      exercises: [],
      submissions: [
        submission('sub-2', '2026-08-01T09:00:00Z', {
          status: 'invalid',
          validity_errors: [{ code: 'voucher_count_mismatch', message: 'Count is off.' }],
        }),
      ],
      feedbacks: [],
      hints: [],
      qaMessages: [],
      sourceDocumentsByExercise: new Map(),
      currentModuleNumber: 1,
    });

    expect(messages[0].attachmentNames).toEqual(['My Daybook.xml', 'My TB.xml']);
    expect(messages[1].kind).toBe('submission-result-invalid');
    expect(messages[1].content).toContain('Count is off.');
  });

  it('falls back to generic chip labels for pre-migration submissions', () => {
    const messages = assembleTimeline({
      exercises: [],
      submissions: [submission('sub-3', '2026-08-01T09:00:00Z', { daybook_filename: null, trialbalance_filename: null })],
      feedbacks: [],
      hints: [],
      qaMessages: [],
      sourceDocumentsByExercise: new Map(),
      currentModuleNumber: 1,
    });

    expect(messages[0].attachmentNames).toEqual(['Day Book.xml', 'Trial Balance.xml']);
  });
});

import { describe, expect, it } from 'vitest';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { Submission } from '@/lib/db/queries/submissions';
import type { ConceptAttempt, ConceptMastery } from '@/lib/db/queries/mastery';
import type { ConceptTag } from '@/lib/schemas/exercise';
import {
  buildLearnerReport,
  escapeHtml,
  formatDuration,
  formatIndiaTime,
  renderLearnerReportHtml,
  type LearnerReportInput,
} from './learner-report';

function exercise(overrides: Partial<ExerciseForLearner> & { id: string; created_at: string }): ExerciseForLearner {
  return {
    kind: 'adaptive',
    scenario: 'A month of trading.',
    transactions: [{ sequence: 1, description: 'On 05-Jun-2025, sold goods to Bengaluru Boutique.' }],
    packFiles: [],
    expectedVoucherCount: null,
    reviewPacketItems: [],
    documentsOnly: false,
    difficulty_level: 'L2',
    variant: 'A',
    requiredParts: ['daybook_xml', 'trialbalance_xml'],
    ...overrides,
  };
}

function submission(overrides: Partial<Submission> & { id: string; exercise_id: string; created_at: string }): Submission {
  return {
    learner_id: 'learner-1',
    daybook_path: 'a/daybook.xml',
    trialbalance_path: 'a/tb.xml',
    daybook_filename: 'DayBook.xml',
    trialbalance_filename: 'TrialBal.xml',
    status: 'scored',
    validity_errors: null,
    correction_round: 0,
    ...overrides,
  } as Submission;
}

function attempt(submissionId: string, tag: ConceptTag, result: 'pass' | 'fail'): ConceptAttempt {
  return {
    id: `${submissionId}-${tag}`,
    learner_id: 'learner-1',
    exercise_id: 'ex-1',
    submission_id: submissionId,
    concept_tag: tag,
    result,
    hint_rungs_used: 0,
    created_at: '2026-09-21T05:00:00Z',
  } as ConceptAttempt;
}

function input(overrides: Partial<LearnerReportInput> = {}): LearnerReportInput {
  return {
    learner: { id: 'learner-1', name: 'Test Learner', email: 'test@example.com', licenseMode: 'educational', onboardedAt: '2026-09-01T04:00:00Z', aiaOnboardingCompletedAt: null },
    generatedAt: '2026-09-29T06:00:00Z',
    exercises: [],
    documentsByExercise: new Map(),
    submissions: [],
    scores: [],
    hints: [],
    attempts: [],
    questions: [],
    issues: [],
    mastery: new Map<ConceptTag, ConceptMastery>(),
    ...overrides,
  };
}

describe('buildLearnerReport', () => {
  it('orders months by issue time and names each by the month it covers', () => {
    const report = buildLearnerReport(
      input({
        exercises: [
          exercise({ id: 'ex-2', created_at: '2026-09-10T04:00:00Z' }),
          exercise({ id: 'ex-1', created_at: '2026-09-01T04:00:00Z', transactions: [], packFiles: [{ label: 'Sales Register', storage_path: 'p/s.xlsx' }], expectedVoucherCount: 99 }),
        ],
      }),
    );
    expect(report.months.map((month) => [month.ordinal, month.exerciseId, month.title])).toEqual([
      [1, 'ex-1', 'Authored pack'],
      [2, 'ex-2', 'June 2025'],
    ]);
    expect(report.months[0].transactionCount).toBe(99);
  });

  it('numbers the chances, carries the score and splits the topics passed and failed', () => {
    const report = buildLearnerReport(
      input({
        exercises: [exercise({ id: 'ex-1', created_at: '2026-09-20T04:00:00Z' })],
        submissions: [
          submission({ id: 'sub-2', exercise_id: 'ex-1', created_at: '2026-09-22T10:30:00Z', correction_round: 1 }),
          submission({ id: 'sub-1', exercise_id: 'ex-1', created_at: '2026-09-21T04:00:00Z' }),
        ],
        scores: [
          {
            submission_id: 'sub-1',
            weighted_score: 0.9459459,
            overall_result: 'pass',
            tb_tie_out: true,
            error_codes: ['BILL_REFERENCE_WRONG', 'NARRATION_MISSING', 'BILL_REFERENCE_WRONG'],
            feedback_text: { opening_line: 'Good month.', went_well: ['Amounts are right.'], needs_work: ['Bill references.'], next_note: 'Fix and resend.' },
            created_at: '2026-09-21T04:05:00Z',
          },
        ],
        attempts: [attempt('sub-1', 'sales_voucher_basics', 'pass'), attempt('sub-1', 'customer_advance', 'fail')],
      }),
    );
    const [first, second] = report.months[0].uploads;
    expect([first.chance, second.chance]).toEqual([1, 2]);
    expect(first.scorePercent).toBe(94.6);
    expect(first.errorCodes).toEqual([
      { code: 'BILL_REFERENCE_WRONG', count: 2 },
      { code: 'NARRATION_MISSING', count: 1 },
    ]);
    expect(first.passed).toEqual(['sales_voucher_basics']);
    expect(first.failed).toEqual(['customer_advance']);
    expect(first.feedback?.needs_work).toEqual(['Bill references.']);
    expect(second.scorePercent).toBeNull();
    expect(second.feedback).toBeNull();
  });

  it('measures the time from issue to the first upload and to the last scored upload', () => {
    const report = buildLearnerReport(
      input({
        exercises: [exercise({ id: 'ex-1', created_at: '2026-09-20T04:00:00Z' })],
        submissions: [
          submission({ id: 'sub-1', exercise_id: 'ex-1', created_at: '2026-09-20T06:00:00Z', status: 'invalid', validity_errors: [{ code: 'trial_balance_too_sparse', message: 'Group level.' }] }),
          submission({ id: 'sub-2', exercise_id: 'ex-1', created_at: '2026-09-22T04:00:00Z' }),
        ],
      }),
    );
    const month = report.months[0];
    expect(month.msToFirstUpload).toBe(2 * 60 * 60 * 1000);
    expect(month.msToFinalScore).toBe(48 * 60 * 60 * 1000);
    expect(month.uploads[0].rejections).toEqual(['Group level.']);
  });

  it('leaves the times empty for a month with no upload', () => {
    const month = buildLearnerReport(input({ exercises: [exercise({ id: 'ex-1', created_at: '2026-09-20T04:00:00Z' })] })).months[0];
    expect(month.uploads).toEqual([]);
    expect(month.msToFirstUpload).toBeNull();
    expect(month.msToFinalScore).toBeNull();
  });

  it('files a question under the month that was open when it was asked', () => {
    const report = buildLearnerReport(
      input({
        exercises: [exercise({ id: 'ex-1', created_at: '2026-09-01T04:00:00Z' }), exercise({ id: 'ex-2', created_at: '2026-09-10T04:00:00Z' })],
        questions: [
          { id: 'q1', question: 'How do I record an advance?', answer: 'Use a receipt voucher.', created_at: '2026-09-05T04:00:00Z' },
          { id: 'q2', question: 'Which report?', answer: 'The Day Book.', created_at: '2026-09-11T04:00:00Z' },
        ],
      }),
    );
    expect(report.months[0].questions.map((entry) => entry.question)).toEqual(['How do I record an advance?']);
    expect(report.months[1].questions.map((entry) => entry.question)).toEqual(['Which report?']);
  });

  it('keeps an issue with no known month in the separate list', () => {
    const report = buildLearnerReport(
      input({
        exercises: [exercise({ id: 'ex-1', created_at: '2026-09-01T04:00:00Z' })],
        issues: [
          { message: 'Invoice missing', status: 'open', admin_reply: null, exercise_id: 'ex-1', created_at: '2026-09-02T04:00:00Z', resolved_at: null },
          { message: 'Cannot log in', status: 'resolved', admin_reply: 'Fixed.', exercise_id: null, created_at: '2026-09-03T04:00:00Z', resolved_at: '2026-09-03T05:00:00Z' },
        ],
      }),
    );
    expect(report.months[0].issues.map((issue) => issue.message)).toEqual(['Invoice missing']);
    expect(report.otherIssues.map((issue) => issue.message)).toEqual(['Cannot log in']);
  });

  it('reports progress over the five modules', () => {
    const mastery = new Map<ConceptTag, ConceptMastery>([
      ['sales_voucher_basics', { learner_id: 'learner-1', concept_tag: 'sales_voucher_basics', status: 'mastered', consecutive_clean_count: 3, last_attempt_result: 'pass', escalation_active: false, updated_at: '2026-09-21T04:00:00Z' }],
    ]);
    const report = buildLearnerReport(input({ mastery }));
    expect(report.modules).toHaveLength(5);
    expect(report.progress.masteredCount).toBe(1);
    expect(report.modules[0].masteredCount).toBe(1);
  });
});

describe('formatting', () => {
  it('writes durations in plain words', () => {
    expect(formatDuration(null)).toBe('not yet');
    expect(formatDuration(20 * 1000)).toBe('under a minute');
    expect(formatDuration(35 * 60 * 1000)).toBe('35 minutes');
    expect(formatDuration(2 * 60 * 60 * 1000 + 5 * 60 * 1000)).toBe('2 hours 5 min');
    expect(formatDuration(60 * 60 * 60 * 1000)).toBe('2 days 12 hours');
  });

  it('shows times in India time', () => {
    expect(formatIndiaTime('2026-09-21T04:25:19Z')).toMatch(/^21 Sept? 2026,? 09:55 IST$/);
    expect(formatIndiaTime(null)).toBe('not recorded');
  });

  it('escapes text a learner typed', () => {
    expect(escapeHtml(`<script>alert("x")</script> & 'y'`)).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;');
  });
});

describe('renderLearnerReportHtml', () => {
  it('renders the month, the score and the feedback, with learner text escaped', () => {
    const html = renderLearnerReportHtml(
      buildLearnerReport(
        input({
          exercises: [exercise({ id: 'ex-1', created_at: '2026-09-20T04:00:00Z' })],
          submissions: [submission({ id: 'sub-1', exercise_id: 'ex-1', created_at: '2026-09-21T04:00:00Z' })],
          scores: [
            {
              submission_id: 'sub-1',
              weighted_score: 0.5,
              overall_result: 'partial',
              tb_tie_out: false,
              error_codes: [],
              feedback_text: { opening_line: 'Half way.', went_well: [], needs_work: ['GST head.'], next_note: 'Try again.' },
              created_at: '2026-09-21T04:05:00Z',
            },
          ],
          questions: [{ id: 'q1', question: 'Is <b>this</b> right?', answer: 'Yes.', created_at: '2026-09-20T05:00:00Z' }],
        }),
      ),
    );
    expect(html).toContain('Month 1: June 2025');
    expect(html).toContain('score 50%');
    expect(html).toContain('Trial Balance does NOT tie out');
    expect(html).toContain('GST head.');
    expect(html).toContain('Is &lt;b&gt;this&lt;/b&gt; right?');
    expect(html).not.toContain('<b>this</b>');
  });

  it('says so when nothing has been issued yet', () => {
    expect(renderLearnerReportHtml(buildLearnerReport(input()))).toContain('No month has been issued yet.');
  });
});

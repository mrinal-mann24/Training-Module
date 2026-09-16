import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';
import type { ScoringResult } from '@/lib/schemas/scoring';
import { MAX_CORRECTION_ROUNDS } from '@/lib/tutor/correction-round';
import { openCorrectionRoundOrAdvance, type CorrectionDeps } from './advance-learner';

// Never dereferenced: every query and LLM call is injected.
const supabase = {} as unknown as SupabaseClient;

const EXERCISE: ExerciseForLearner = {
  id: 'exercise-1',
  kind: 'adaptive',
  scenario: 'Blossom Retail, May.',
  transactions: [{ sequence: 1, description: 'Sale to Coimbatore Interiors' }],
  packFiles: [],
  expectedVoucherCount: null,
  reviewPacketItems: [],
  documentsOnly: false,
  difficulty_level: 'L2',
  variant: 'A',
  requiredParts: ['daybook_xml', 'trialbalance_xml'],
  created_at: '2026-05-01T00:00:00.000Z',
};

const SCORED_AT = '2026-05-20T10:00:00.000Z';

const CLEAN: ScoringResult['concept_results'] = [{ concept_tag: 'sales_voucher_basics', result: 'pass' }];
const FAILING: ScoringResult['concept_results'] = [
  { concept_tag: 'sales_voucher_basics', result: 'pass' },
  { concept_tag: 'gst_classification', result: 'fail' },
];

function makeDeps(overrides: Partial<CorrectionDeps> = {}): CorrectionDeps {
  return {
    nextRung: vi.fn<CorrectionDeps['nextRung']>().mockResolvedValue(1),
    existingHint: vi.fn<CorrectionDeps['existingHint']>().mockResolvedValue(null),
    loadAnswerKey: vi.fn<CorrectionDeps['loadAnswerKey']>().mockResolvedValue({ entries: [] }),
    makeHint: vi
      .fn<CorrectionDeps['makeHint']>()
      .mockResolvedValue({ rung: 1, hint_text: 'Watch the GST module.', concept_tag: 'gst_classification' }),
    saveHint: vi.fn<CorrectionDeps['saveHint']>().mockResolvedValue({
      id: 'hint-1',
      exercise_id: EXERCISE.id,
      learner_id: 'learner-1',
      rung: 1,
      hint_content: { rung: 1, hint_text: 'Watch the GST module.', concept_tag: 'gst_classification' },
      created_at: '2026-05-02T00:00:00.000Z',
    }),
    advance: vi.fn<CorrectionDeps['advance']>().mockResolvedValue('generated'),
    ...overrides,
  };
}

function run(
  params: { conceptResults: ScoringResult['concept_results']; submissionCorrectionRound: number; exercise?: ExerciseForLearner },
  deps: CorrectionDeps,
) {
  return openCorrectionRoundOrAdvance(
    supabase,
    {
      learnerId: 'learner-1',
      exercise: params.exercise ?? EXERCISE,
      submissionCorrectionRound: params.submissionCorrectionRound,
      submissionScoredAfter: SCORED_AT,
      conceptResults: params.conceptResults,
      licenseMode: 'licensed',
    },
    deps,
  );
}

describe('openCorrectionRoundOrAdvance', () => {
  it('opens a correction round on a failing batch and does not generate a new exercise', async () => {
    const deps = makeDeps();

    const outcome = await run({ conceptResults: FAILING, submissionCorrectionRound: 0 }, deps);

    expect(outcome).toEqual({ opened: true, round: 1, conceptTag: 'gst_classification' });
    expect(deps.advance).not.toHaveBeenCalled();
    expect(deps.saveHint).toHaveBeenCalledWith(supabase, 'learner-1', 'exercise-1', expect.anything(), 'gst_classification');
  });

  it('aims the pushed help at the concept that actually failed', async () => {
    const deps = makeDeps();

    await run({ conceptResults: FAILING, submissionCorrectionRound: 0 }, deps);

    expect(deps.makeHint).toHaveBeenCalledWith(
      'learner-1',
      expect.objectContaining({ focusConceptTag: 'gst_classification', rung: 1, packMode: false }),
    );
  });

  it('advances on a clean batch', async () => {
    const deps = makeDeps();

    const outcome = await run({ conceptResults: CLEAN, submissionCorrectionRound: 0 }, deps);

    expect(outcome).toEqual({ opened: false });
    expect(deps.advance).toHaveBeenCalledTimes(1);
    expect(deps.makeHint).not.toHaveBeenCalled();
  });

  // H2, the production incident this feature reopens the door to: keyed on
  // the submission, a correction round is newer than the batch round 0 made,
  // so the guard would see nothing after it and hand out a SECOND batch with
  // a second difficulty bump. Keyed on the exercise, that cannot happen.
  it('keys next-exercise generation on the exercise, never the submission', async () => {
    const deps = makeDeps();

    await run({ conceptResults: CLEAN, submissionCorrectionRound: 2 }, deps);

    expect(deps.advance).toHaveBeenCalledWith(
      supabase,
      expect.objectContaining({ afterIso: EXERCISE.created_at, previousDifficultyLevel: 'L2' }),
    );
  });

  it('advances once the rounds are used up, even with a concept still failing', async () => {
    const deps = makeDeps();

    const outcome = await run({ conceptResults: FAILING, submissionCorrectionRound: MAX_CORRECTION_ROUNDS }, deps);

    expect(outcome).toEqual({ opened: false });
    expect(deps.advance).toHaveBeenCalledTimes(1);
  });

  it('advances instead of opening a round on an explain batch', async () => {
    const deps = makeDeps();

    await run(
      {
        conceptResults: FAILING,
        submissionCorrectionRound: 0,
        exercise: { ...EXERCISE, requiredParts: ['daybook_xml', 'trialbalance_xml', 'explain_text'] },
      },
      deps,
    );

    expect(deps.advance).toHaveBeenCalledTimes(1);
    expect(deps.makeHint).not.toHaveBeenCalled();
  });

  // Never leave a learner permanently stuck (project-overview.md goal 5): a
  // help step that cannot be generated must not cost them the next batch too.
  it('falls back to advancing when the help step cannot be generated', async () => {
    const deps = makeDeps({
      makeHint: vi.fn<CorrectionDeps['makeHint']>().mockRejectedValue(new Error('model unavailable')),
    });

    const outcome = await run({ conceptResults: FAILING, submissionCorrectionRound: 0 }, deps);

    expect(outcome).toEqual({ opened: false });
    expect(deps.advance).toHaveBeenCalledTimes(1);
  });

  it('falls back to advancing when the answer key is missing', async () => {
    const deps = makeDeps({
      loadAnswerKey: vi.fn<CorrectionDeps['loadAnswerKey']>().mockResolvedValue(null),
    });

    const outcome = await run({ conceptResults: FAILING, submissionCorrectionRound: 0 }, deps);

    expect(outcome).toEqual({ opened: false });
    expect(deps.saveHint).not.toHaveBeenCalled();
  });

  // insertHintRequest has no conflict key and determineNextRung counts hint
  // rows, so a second run of this step body for one submission would write a
  // hint one step DEEPER than the round deserves, and the chat serves the
  // newest one. The learner would be handed the full answer early and lose
  // mastery credit they had not spent.
  it('writes nothing when this round already pushed a hint', async () => {
    const deps = makeDeps({
      existingHint: vi
        .fn<CorrectionDeps['existingHint']>()
        .mockResolvedValue({ rung: 1, hint_text: 'Watch the GST module.', concept_tag: 'gst_classification' }),
    });

    const outcome = await run({ conceptResults: FAILING, submissionCorrectionRound: 0 }, deps);

    expect(outcome).toEqual({ opened: true, round: 1, conceptTag: 'gst_classification' });
    expect(deps.makeHint).not.toHaveBeenCalled();
    expect(deps.saveHint).not.toHaveBeenCalled();
    expect(deps.advance).not.toHaveBeenCalled();
  });

  it('looks for an existing hint only after the submission being scored', async () => {
    const deps = makeDeps();

    await run({ conceptResults: FAILING, submissionCorrectionRound: 1 }, deps);

    expect(deps.existingHint).toHaveBeenCalledWith(expect.anything(), 'learner-1', 'exercise-1', SCORED_AT);
  });

  it('pushes the deeper help step the ladder is already at', async () => {
    const deps = makeDeps({ nextRung: vi.fn<CorrectionDeps['nextRung']>().mockResolvedValue(3) });

    await run({ conceptResults: FAILING, submissionCorrectionRound: 2 }, deps);

    expect(deps.makeHint).toHaveBeenCalledWith('learner-1', expect.objectContaining({ rung: 3 }));
  });
});

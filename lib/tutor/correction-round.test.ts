import { describe, expect, it } from 'vitest';
import type { SubmissionPartType } from '@/lib/schemas/exercise';
import {
  MAX_CORRECTION_ROUNDS,
  correctionInviteLine,
  decideCorrection,
  failingConcepts,
  isCorrectionOpen,
  supportsCorrectionRounds,
  type ConceptOutcome,
} from './correction-round';

const FILE_PARTS: SubmissionPartType[] = ['daybook_xml', 'trialbalance_xml'];
const EXPLAIN_PARTS: SubmissionPartType[] = ['daybook_xml', 'trialbalance_xml', 'explain_text'];
const REVIEW_PARTS: SubmissionPartType[] = ['review_text'];

const CLEAN: ConceptOutcome[] = [
  { concept_tag: 'sales_voucher_basics', result: 'pass' },
  { concept_tag: 'gst_classification', result: 'pass' },
];
const ONE_FAIL: ConceptOutcome[] = [
  { concept_tag: 'sales_voucher_basics', result: 'pass' },
  { concept_tag: 'gst_classification', result: 'fail' },
];

describe('supportsCorrectionRounds', () => {
  it('accepts the two-file batches and nothing else', () => {
    expect(supportsCorrectionRounds(FILE_PARTS)).toBe(true);
    expect(supportsCorrectionRounds(['trialbalance_xml', 'daybook_xml'])).toBe(true);
    expect(supportsCorrectionRounds(EXPLAIN_PARTS)).toBe(false);
    expect(supportsCorrectionRounds(REVIEW_PARTS)).toBe(false);
    expect(supportsCorrectionRounds([])).toBe(false);
  });
});

describe('failingConcepts', () => {
  it('returns only the failures, in curriculum order not scorer order', () => {
    const outcomes: ConceptOutcome[] = [
      { concept_tag: 'gst_classification', result: 'fail' },
      { concept_tag: 'sales_voucher_basics', result: 'fail' },
      { concept_tag: 'purchase_voucher_basics', result: 'pass' },
    ];
    expect(failingConcepts(outcomes)).toEqual(['sales_voucher_basics', 'gst_classification']);
  });

  it('is empty on a clean batch', () => {
    expect(failingConcepts(CLEAN)).toEqual([]);
  });

  it('ignores a retired concept even if an old answer key still tags one', () => {
    expect(failingConcepts([{ concept_tag: 'narration_discipline', result: 'fail' }])).toEqual([]);
  });
});

describe('decideCorrection', () => {
  it('opens round 1 on the first failing batch, focused on the first failing concept', () => {
    expect(decideCorrection({ requiredParts: FILE_PARTS, conceptResults: ONE_FAIL, currentRound: 0 })).toEqual({
      kind: 'open',
      round: 1,
      focusConceptTag: 'gst_classification',
      failingConceptTags: ['gst_classification'],
    });
  });

  it('advances immediately when nothing failed', () => {
    expect(decideCorrection({ requiredParts: FILE_PARTS, conceptResults: CLEAN, currentRound: 0 })).toEqual({
      kind: 'advance',
      reason: 'nothing-failing',
    });
  });

  it('advances when the learner fixes it mid-loop', () => {
    expect(decideCorrection({ requiredParts: FILE_PARTS, conceptResults: CLEAN, currentRound: 2 })).toEqual({
      kind: 'advance',
      reason: 'nothing-failing',
    });
  });

  it('opens each round in turn up to the cap', () => {
    for (let currentRound = 0; currentRound < MAX_CORRECTION_ROUNDS; currentRound++) {
      const decision = decideCorrection({ requiredParts: FILE_PARTS, conceptResults: ONE_FAIL, currentRound });
      expect(decision).toMatchObject({ kind: 'open', round: currentRound + 1 });
    }
  });

  // The product rule that matters: nobody is left stuck. After the third
  // round the learner has been handed the full answer, so the loop closes
  // whether or not the last upload was right.
  it('advances once the rounds are exhausted, even with a concept still failing', () => {
    expect(
      decideCorrection({ requiredParts: FILE_PARTS, conceptResults: ONE_FAIL, currentRound: MAX_CORRECTION_ROUNDS }),
    ).toEqual({ kind: 'advance', reason: 'rounds-exhausted' });
  });

  it('never opens a round on an explain or review batch', () => {
    expect(decideCorrection({ requiredParts: EXPLAIN_PARTS, conceptResults: ONE_FAIL, currentRound: 0 })).toEqual({
      kind: 'advance',
      reason: 'not-supported',
    });
    expect(decideCorrection({ requiredParts: REVIEW_PARTS, conceptResults: ONE_FAIL, currentRound: 0 })).toEqual({
      kind: 'advance',
      reason: 'not-supported',
    });
  });
});

describe('isCorrectionOpen', () => {
  it('is open while something failed and rounds remain', () => {
    expect(isCorrectionOpen({ requiredParts: FILE_PARTS, latestRound: 0, anyConceptFailed: true })).toBe(true);
    expect(
      isCorrectionOpen({ requiredParts: FILE_PARTS, latestRound: MAX_CORRECTION_ROUNDS - 1, anyConceptFailed: true }),
    ).toBe(true);
  });

  it('is closed on a clean batch, at the cap, and on an unsupported kind', () => {
    expect(isCorrectionOpen({ requiredParts: FILE_PARTS, latestRound: 0, anyConceptFailed: false })).toBe(false);
    expect(
      isCorrectionOpen({ requiredParts: FILE_PARTS, latestRound: MAX_CORRECTION_ROUNDS, anyConceptFailed: true }),
    ).toBe(false);
    expect(isCorrectionOpen({ requiredParts: EXPLAIN_PARTS, latestRound: 0, anyConceptFailed: true })).toBe(false);
  });

  // decideCorrection opens exactly the rounds isCorrectionOpen would allow.
  // If these two ever disagree, the chat offers a re-upload the job refuses,
  // or refuses one the job expects.
  it('agrees with decideCorrection at every round', () => {
    for (let round = 0; round <= MAX_CORRECTION_ROUNDS + 1; round++) {
      const opened = decideCorrection({ requiredParts: FILE_PARTS, conceptResults: ONE_FAIL, currentRound: round }).kind === 'open';
      expect(isCorrectionOpen({ requiredParts: FILE_PARTS, latestRound: round, anyConceptFailed: true })).toBe(opened);
    }
  });
});

describe('correctionInviteLine', () => {
  it('asks for corrected exports at every round, with no em dash', () => {
    for (let round = 1; round <= MAX_CORRECTION_ROUNDS; round++) {
      const line = correctionInviteLine(round);
      expect(line).toMatch(/corrected Day Book and Trial Balance/);
      expect(line).not.toContain('—');
    }
  });

  it('says the loop ends after the final round', () => {
    expect(correctionInviteLine(MAX_CORRECTION_ROUNDS)).toMatch(/move on/);
  });
});

import { describe, expect, it } from 'vitest';
import { buildAdaptivePrompt, type AdaptiveExerciseParams } from './adaptive-exercise';

function params(overrides: Partial<AdaptiveExerciseParams> = {}): AdaptiveExerciseParams {
  return {
    targetConceptTag: 'gst_classification',
    batchStrengthConcepts: [],
    batchWeaknessConcepts: ['gst_classification'],
    recentStrengthDescriptions: [],
    difficultyLevel: 'L1',
    licenseMode: 'licensed',
    escalationActive: false,
    companyLedgerRegistry: [],
    recentCompanyTransactionLog: [],
    exerciseMonthLabel: 'May 2026',
    companyName: 'Blossom Retail Pvt Ltd',
    ...overrides,
  };
}

function systemPrompt(p: AdaptiveExerciseParams): string {
  return buildAdaptivePrompt(p).messages[0].content;
}

describe('buildAdaptivePrompt company and month pinning (5-point review, 2026-09-01)', () => {
  it('pins the company by name even on the very first adaptive exercise (empty registry)', () => {
    const prompt = systemPrompt(params());
    expect(prompt).toContain('THE COMPANY IS: Blossom Retail Pvt Ltd');
    expect(prompt).toContain('home state Karnataka');
  });

  it('pins the company by name alongside a populated registry', () => {
    const prompt = systemPrompt(
      params({
        companyLedgerRegistry: [
          { ledger_name: 'Karnataka Emporium', ledger_type: 'Sales', first_used_exercise_id: 'x', created_at: '' },
        ],
      }),
    );
    expect(prompt).toContain('THE COMPANY IS: Blossom Retail Pvt Ltd');
    expect(prompt).toContain('COMPANY CONTINUITY IS MANDATORY');
  });

  it('states the assigned month as a hard rule', () => {
    const prompt = systemPrompt(params());
    expect(prompt).toContain('dated inside\nMay 2026');
  });

  it('scopes the educational-mode date rule to the assigned month only', () => {
    const prompt = systemPrompt(params({ licenseMode: 'educational' }));
    expect(prompt).toContain('WITHIN May 2026');
    expect(prompt).not.toContain('two\nconsecutive months');
  });
});

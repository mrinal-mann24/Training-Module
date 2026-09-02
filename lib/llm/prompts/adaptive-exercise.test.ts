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
    cashPosition: { cash: 19900, bank: 867186 },
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

  it('states the opening cash and bank balances as a hard constraint', () => {
    // Without these the model invented unpostable cash movements (a 45,000
    // deposit against 19,900 of cash on hand, reported live 2026-09-02).
    const prompt = systemPrompt(params());
    expect(prompt).toContain('OPENING BALANCES');
    expect(prompt).toContain('19,900');
    expect(prompt).toContain('cash can never go\nnegative');
  });

  it('scopes the educational-mode date rule to the assigned month only', () => {
    const prompt = systemPrompt(params({ licenseMode: 'educational' }));
    expect(prompt).toContain('WITHIN May 2026');
    expect(prompt).not.toContain('two\nconsecutive months');
  });
});

describe('overdrawn till instruction (2026-09-02)', () => {
  it('orders a replenishing withdrawal first when opening cash is negative', () => {
    const prompt = systemPrompt(params({ cashPosition: { cash: -70100, bank: 900000 } }));
    expect(prompt).toContain('THE TILL IS OVERDRAWN by Rs 70,100');
    expect(prompt).toContain('Transaction 1 of THIS batch MUST therefore be a Contra withdrawal');
  });

  it('omits the instruction when cash is healthy', () => {
    const prompt = systemPrompt(params());
    expect(prompt).not.toContain('TILL IS OVERDRAWN');
  });
});

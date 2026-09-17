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
    openBills: [],
    partyTaxClasses: new Map(),
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

describe('Educational Mode dates in the prompt (2026-09-16)', () => {
  it('lists the exact allowed dates of a 31-day month', () => {
    const prompt = systemPrompt(params({ licenseMode: 'educational' }));
    expect(prompt).toContain('Every transaction must be dated exactly one of: 01-May-2026, 02-May-2026, 31-May-2026.');
  });

  it('lists only the 1st and 2nd for a 30-day month, and says why', () => {
    const prompt = systemPrompt(params({ licenseMode: 'educational', exerciseMonthLabel: 'June 2024' }));
    expect(prompt).toContain(
      'Every transaction must be dated exactly one of: 01-Jun-2024, 02-Jun-2024 (June has no 31st, and Tally Educational Mode never saves the 30th).',
    );
    expect(prompt).not.toContain('30-Jun-2024');
  });

  it('names the 29th for a leap February', () => {
    const prompt = systemPrompt(params({ licenseMode: 'educational', exerciseMonthLabel: 'February 2028' }));
    expect(prompt).toContain('01-Feb-2028, 02-Feb-2028 (February has no 31st, and Tally Educational Mode never saves the 29th)');
  });

  it('drops the spread-the-dates sentence and the 05-/12- pointer examples for educational learners', () => {
    const prompt = systemPrompt(params({ licenseMode: 'educational', exerciseMonthLabel: 'June 2024' }));
    expect(prompt).not.toContain('DIFFERENT dates');
    expect(prompt).not.toMatch(/On (05|12)-May-/);
    expect(prompt).toContain('"On 01-Jun-2024, an invoice arrived from Signage');
    expect(prompt).toContain('"On 02-Jun-2024, a receipt from Delhi Bazaar');
  });

  it('leaves the licensed prompt as it was', () => {
    const prompt = systemPrompt(params());
    expect(prompt).toContain('Spread the transactions across DIFFERENT dates\nin the month');
    expect(prompt).toMatch(/"On 05-May-\d{4}, an invoice arrived/);
    expect(prompt).toMatch(/"On 12-May-\d{4}, a receipt from Delhi Bazaar/);
    expect(prompt).not.toContain('EDUCATIONAL MODE DATE RULE');
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

describe('dates, document numbers and tax rules in the prompt (2026-09-17 audit)', () => {
  it('states the canonical DD-Mon-YYYY date rule', () => {
    const prompt = systemPrompt(params({ exerciseMonthLabel: 'June 2024' }));
    expect(prompt).toContain('DATE FORMAT (hard requirement): write every date as DD-Mon-YYYY');
    expect(prompt).toContain('never put a date inside a bill, invoice or note');
  });

  it('lists the document numbers already used, and omits the block when there are none', () => {
    expect(systemPrompt(params({ usedBillNumbers: ['INV-018', 'ADV-C01', 'MS/990'] }))).toContain('DOCUMENT NUMBERS ALREADY USED');
    expect(systemPrompt(params({ usedBillNumbers: ['INV-018', 'ADV-C01', 'MS/990'] }))).toContain('INV-018, ADV-C01, MS/990');
    expect(systemPrompt(params())).not.toContain('DOCUMENT NUMBERS ALREADY USED');
  });

  it('states the TDS and GST rules of the batch financial year, and the reverse-charge cases', () => {
    const fy24 = systemPrompt(params({ exerciseMonthLabel: 'June 2024' }));
    expect(fy24).toContain('TAX RULES (hard requirement');
    expect(fy24).toContain('FY 2024-25');
    expect(fy24).toContain("the year's rent likely to exceed Rs 2,40,000");
    expect(fy24).toContain('legal services by an individual advocate or a firm of advocates');
    const fy25 = systemPrompt(params({ exerciseMonthLabel: 'June 2025' }));
    expect(fy25).toContain('FY 2025-26');
    expect(fy25).toContain('rent for a month or part of a month over Rs 50,000');
    expect(fy25).not.toContain('2,40,000 aggregate');
  });
});

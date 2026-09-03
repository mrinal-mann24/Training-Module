import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDayBookXml } from '@/lib/parsing/daybook';
import { parseTrialBalanceXml } from '@/lib/parsing/trialbalance';
import { runValidityGate } from './submission-gate';
import type { ExerciseForLearner } from '@/lib/db/queries/exercises';

const sampleDayBookPath = path.resolve(__dirname, '../../xmls/DayBook.xml');
const sampleTrialBalPath = path.resolve(__dirname, '../../xmls/TrialBal.xml');

function makeExercise(transactionCount: number): ExerciseForLearner {
  return {
    id: 'exercise-1',
    kind: 'diagnostic',
    scenario: 'A scenario.',
    transactions: Array.from({ length: transactionCount }, (_, index) => ({
      sequence: index + 1,
      description: `Transaction ${index + 1}`,
    })),
    reviewPacketItems: [],
    difficulty_level: 'L0',
    variant: 'A',
    requiredParts: ['daybook_xml', 'trialbalance_xml'],
    packFiles: [],
    expectedVoucherCount: null,
    created_at: new Date().toISOString(),
  };
}

describe('runValidityGate', () => {
  it('rejects the real sparse Trial Balance sample as too group-level', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const trialBalance = parseTrialBalanceXml(readFileSync(sampleTrialBalPath));
    const exercise = makeExercise(1);

    const result = runValidityGate(dayBook, trialBalance, exercise, '2026-04-01');

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.map((error) => error.code)).toContain('trial_balance_too_sparse');
    }
  });

  it('accepts a Day Book whose voucher count matches the exercise and dates are in period', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const richTrialBalance = {
      ledgers: [
        // A real ledger-wise export has 35+ rows; the gate floor is 15.
        ...Array.from({ length: 12 }, (_, i) => ({ ledgerName: `Ledger ${i + 1}`, closingDebit: 1, closingCredit: 0 })),
        { ledgerName: 'Material purchase', closingDebit: 423000, closingCredit: 0 },
        { ledgerName: 'IGST Payable', closingDebit: 0, closingCredit: 21150 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 444150 },
      ],
    };
    const exercise = makeExercise(1);

    const result = runValidityGate(dayBook, richTrialBalance, exercise, '2026-04-01');

    expect(result.status).toBe('valid');
  });

  it('uses expectedVoucherCount over transactions.length for pack exercises', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath)); // 1 voucher
    const richTrialBalance = {
      ledgers: [
        // A real ledger-wise export has 35+ rows; the gate floor is 15.
        ...Array.from({ length: 12 }, (_, i) => ({ ledgerName: `Ledger ${i + 1}`, closingDebit: 1, closingCredit: 0 })),
        { ledgerName: 'Material purchase', closingDebit: 423000, closingCredit: 0 },
        { ledgerName: 'IGST Payable', closingDebit: 0, closingCredit: 21150 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 444150 },
      ],
    };
    // Pack exercise: transactions is empty (they live in the pack files) —
    // without expectedVoucherCount the gate would demand 0 vouchers.
    const packExercise = { ...makeExercise(0), expectedVoucherCount: 1 };
    expect(runValidityGate(dayBook, richTrialBalance, packExercise, '2026-04-01').status).toBe('valid');

    const mismatchedPack = { ...makeExercise(0), expectedVoucherCount: 98 };
    const result = runValidityGate(dayBook, richTrialBalance, mismatchedPack, '2026-04-01');
    expect(result.status).toBe('invalid');
  });

  it('tolerates a small voucher-count deviation for pack exercises', () => {
    // The pilot precedent: a 99-voucher daybook against a 98-voucher key was
    // scored, not bounced. The engine's similarity matcher + VOUCHER_MISSING
    // handle the difference; only an obviously-incomplete export is rejected.
    const twoVoucherDayBook = {
      vouchers: [
        {
          voucherType: 'Purchase',
          date: '20260405',
          narration: 'x',
          ledgerEntries: [
            { ledgerName: 'A', amount: 1, drOrCr: 'Dr' as const, billAllocations: [] },
          ],
        },
        {
          voucherType: 'Payment',
          date: '20260406',
          narration: 'x',
          ledgerEntries: [
            { ledgerName: 'B', amount: 1, drOrCr: 'Cr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const richTrialBalance = {
      ledgers: [
        // A real ledger-wise export has 35+ rows; the gate floor is 15.
        ...Array.from({ length: 12 }, (_, i) => ({ ledgerName: `Ledger ${i + 1}`, closingDebit: 1, closingCredit: 0 })),
        { ledgerName: 'A', closingDebit: 1, closingCredit: 0 },
        { ledgerName: 'B', closingDebit: 0, closingCredit: 1 },
        { ledgerName: 'C', closingDebit: 0, closingCredit: 0 },
      ],
    };
    // Expected 2, submitted 2±(10% rounded up = 1): 2 is fine, 1 is fine, and
    // a 4-voucher submission against an expected 2 is out of band.
    expect(
      runValidityGate(twoVoucherDayBook, richTrialBalance, { ...makeExercise(0), expectedVoucherCount: 2 }, '2026-04-01')
        .status,
    ).toBe('valid');
    expect(
      runValidityGate(twoVoucherDayBook, richTrialBalance, { ...makeExercise(0), expectedVoucherCount: 3 }, '2026-04-01')
        .status,
    ).toBe('valid');
  });

  it('rejects a voucher count mismatch against the exercise scenario', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const richTrialBalance = {
      ledgers: [
        // A real ledger-wise export has 35+ rows; the gate floor is 15.
        ...Array.from({ length: 12 }, (_, i) => ({ ledgerName: `Ledger ${i + 1}`, closingDebit: 1, closingCredit: 0 })),
        { ledgerName: 'Material purchase', closingDebit: 423000, closingCredit: 0 },
        { ledgerName: 'IGST Payable', closingDebit: 0, closingCredit: 21150 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 444150 },
      ],
    };
    const exercise = makeExercise(3);

    const result = runValidityGate(dayBook, richTrialBalance, exercise, '2026-04-01');

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.map((error) => error.code)).toContain('voucher_count_mismatch');
    }
  });

  it('rejects voucher dates before the Books Begin Date', () => {
    const dayBook = parseDayBookXml(readFileSync(sampleDayBookPath));
    const richTrialBalance = {
      ledgers: [
        // A real ledger-wise export has 35+ rows; the gate floor is 15.
        ...Array.from({ length: 12 }, (_, i) => ({ ledgerName: `Ledger ${i + 1}`, closingDebit: 1, closingCredit: 0 })),
        { ledgerName: 'Material purchase', closingDebit: 423000, closingCredit: 0 },
        { ledgerName: 'IGST Payable', closingDebit: 0, closingCredit: 21150 },
        { ledgerName: 'Parekh Integrated Services Pvt Ltd', closingDebit: 0, closingCredit: 444150 },
      ],
    };
    const exercise = makeExercise(1);

    const result = runValidityGate(dayBook, richTrialBalance, exercise, '2026-09-01');

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.errors.map((error) => error.code)).toContain('voucher_dates_out_of_period');
    }
  });
});

describe('no month-day rule (Phase 3, spec 15)', () => {
  it('accepts mid-month voucher dates: Educational Mode dating is enforced at generation, never by the gate', () => {
    const dayBook = {
      vouchers: [
        {
          voucherType: 'Payment',
          date: '20260415',
          narration: 'x',
          ledgerEntries: [
            { ledgerName: 'Some Vendor', amount: 100, drOrCr: 'Dr' as const, billAllocations: [] },
            { ledgerName: 'HDFC Bank', amount: 100, drOrCr: 'Cr' as const, billAllocations: [] },
          ],
        },
      ],
    };
    const richTrialBalance = {
      ledgers: [
        // A real ledger-wise export has 35+ rows; the gate floor is 15.
        ...Array.from({ length: 12 }, (_, i) => ({ ledgerName: `Ledger ${i + 1}`, closingDebit: 1, closingCredit: 0 })),
        { ledgerName: 'Some Vendor', closingDebit: 100, closingCredit: 0 },
        { ledgerName: 'HDFC Bank', closingDebit: 0, closingCredit: 100 },
        { ledgerName: 'Cash', closingDebit: 500, closingCredit: 0 },
      ],
    };

    const result = runValidityGate(dayBook, richTrialBalance, makeExercise(1), '2026-04-01');

    expect(result.status).toBe('valid');
  });
});

describe('voucher dates may run ahead of the wall clock when the exercise month does (2026-09-03)', () => {
  const futureExercise = { ...makeExercise(1), transactions: [{ sequence: 1, description: 'On 15-Dec-2030, pay office rent by bank transfer.' }] };
  const trialBalance = { ledgers: Array.from({ length: 16 }, (_, i) => ({ ledgerName: `Ledger ${i + 1}`, closingDebit: 1, closingCredit: 0 })) };
  const dayBookOn = (date: string) => ({ vouchers: [{ voucherType: 'Payment', date, narration: 'rent', ledgerEntries: [] }] });

  it('accepts a voucher inside the exercise month even though it is in the future', () => {
    expect(runValidityGate(dayBookOn('20301221'), trialBalance, futureExercise, '2026-04-01').status).toBe('valid');
  });

  it('still rejects a voucher beyond the exercise month', () => {
    const result = runValidityGate(dayBookOn('20310105'), trialBalance, futureExercise, '2026-04-01');
    expect(result.status).toBe('invalid');
  });
});

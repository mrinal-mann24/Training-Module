import { describe, expect, it } from 'vitest';
import {
  NEXT_MONTH_DELAYED_MESSAGE,
  NEXT_MONTH_DELAY_MS,
  NEXT_MONTH_PREPARING_MESSAGE,
  PROGRAMME_COMPLETE_MESSAGE,
  decideNextMonthStatus,
  nextMonthMessage,
} from './next-month-status';

const scoredAt = '2026-09-29T10:00:00.000Z';
const at = (msAfter: number): number => Date.parse(scoredAt) + msAfter;

describe('decideNextMonthStatus (2026-09-30)', () => {
  it('is preparing right after scoring', () => {
    expect(decideNextMonthStatus({ scoredAt, now: at(60_000), programmeComplete: false })).toBe('preparing');
  });

  it('is delayed once the normal generation time is well past', () => {
    expect(decideNextMonthStatus({ scoredAt, now: at(NEXT_MONTH_DELAY_MS - 1), programmeComplete: false })).toBe('preparing');
    expect(decideNextMonthStatus({ scoredAt, now: at(NEXT_MONTH_DELAY_MS), programmeComplete: false })).toBe('delayed');
    expect(decideNextMonthStatus({ scoredAt, now: at(3 * 24 * 60 * 60 * 1000), programmeComplete: false })).toBe('delayed');
  });

  it('is completed when every topic is mastered, however recent the score', () => {
    expect(decideNextMonthStatus({ scoredAt, now: at(1_000), programmeComplete: true })).toBe('completed');
    expect(decideNextMonthStatus({ scoredAt, now: at(NEXT_MONTH_DELAY_MS * 10), programmeComplete: true })).toBe('completed');
  });

  it('never calls an unreadable date delayed', () => {
    expect(decideNextMonthStatus({ scoredAt: 'not a date', now: at(NEXT_MONTH_DELAY_MS * 10), programmeComplete: false })).toBe('preparing');
  });
});

describe('nextMonthMessage', () => {
  it('maps each status to its message', () => {
    expect(nextMonthMessage('preparing')).toBe(NEXT_MONTH_PREPARING_MESSAGE);
    expect(nextMonthMessage('delayed')).toBe(NEXT_MONTH_DELAYED_MESSAGE);
    expect(nextMonthMessage('completed')).toBe(PROGRAMME_COMPLETE_MESSAGE);
  });

  it('never promises a minute or two, and uses no em dash', () => {
    for (const message of [NEXT_MONTH_PREPARING_MESSAGE, NEXT_MONTH_DELAYED_MESSAGE, PROGRAMME_COMPLETE_MESSAGE]) {
      expect(message).not.toMatch(/minute or two/);
      expect(message).not.toMatch(/[–—]/);
    }
  });
});

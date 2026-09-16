import { describe, expect, it } from 'vitest';
import { MessageIntentSchema } from './message-intent';

describe('MessageIntentSchema', () => {
  it('accepts a question verdict', () => {
    const output = { intent: 'question', reason: 'Asks which ledger bank charges go to.' };
    expect(MessageIntentSchema.parse(output)).toEqual(output);
  });

  it('accepts an answer verdict', () => {
    const output = { intent: 'answer', reason: 'Explains why rent was posted to expenses.' };
    expect(MessageIntentSchema.parse(output)).toEqual(output);
  });

  it('rejects an intent outside question and answer', () => {
    expect(MessageIntentSchema.safeParse({ intent: 'unclear', reason: 'Could be either.' }).success).toBe(false);
  });

  it('rejects a missing or empty reason', () => {
    expect(MessageIntentSchema.safeParse({ intent: 'answer' }).success).toBe(false);
    expect(MessageIntentSchema.safeParse({ intent: 'answer', reason: '' }).success).toBe(false);
  });

  it('rejects anything that is not an object', () => {
    expect(MessageIntentSchema.safeParse('{"intent":"answer","reason":"x"}').success).toBe(false);
    expect(MessageIntentSchema.safeParse(null).success).toBe(false);
  });
});

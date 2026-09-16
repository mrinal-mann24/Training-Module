import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyMessageIntent } from './classify-message-intent';
import type { getTracedStructuredCompletion } from '@/lib/llm/tracing';
import type { MessageIntentContext } from '@/lib/llm/prompts/message-intent';

type Complete = typeof getTracedStructuredCompletion;

const context: MessageIntentContext = {
  text: 'Bank charges go under Indirect Expenses',
  expectedPart: 'explain_text',
  exerciseScenario: null,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('classifyMessageIntent', () => {
  it('returns the validated model verdict', async () => {
    const complete = vi.fn<Complete>().mockResolvedValue({ intent: 'answer', reason: 'States a posting.' });

    await expect(classifyMessageIntent('learner-1', context, { complete })).resolves.toEqual({
      intent: 'answer',
      source: 'llm',
    });
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0][0]).toMatchObject({
      traceName: 'message-intent',
      callType: 'message-intent',
      learnerId: 'learner-1',
      extraMetadata: { expectedPart: 'explain_text', textChars: context.text.length },
    });
  });

  it('retries once with the validation error when the first output is invalid', async () => {
    const complete = vi
      .fn<Complete>()
      .mockResolvedValueOnce({ intent: 'unclear' })
      .mockResolvedValueOnce({ intent: 'question', reason: 'Asks for a ledger.' });

    await expect(classifyMessageIntent('learner-1', context, { complete })).resolves.toEqual({
      intent: 'question',
      source: 'llm',
    });
    const retryMessages = complete.mock.calls[1][0].messages;
    expect(retryMessages[retryMessages.length - 1].content).toContain('failed schema validation');
  });

  it('falls back to question after two invalid outputs', async () => {
    const complete = vi.fn<Complete>().mockResolvedValue({ nope: true });

    await expect(classifyMessageIntent('learner-1', context, { complete })).resolves.toEqual({
      intent: 'question',
      source: 'fallback',
      fallback: 'invalid',
    });
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it('falls back to question when the call throws', async () => {
    const complete = vi.fn<Complete>().mockRejectedValue(new Error('OpenRouter request failed (500)'));

    await expect(classifyMessageIntent('learner-1', context, { complete })).resolves.toEqual({
      intent: 'question',
      source: 'fallback',
      fallback: 'error',
    });
  });

  it('falls back to question when the model does not reply in time', async () => {
    const complete = vi.fn<Complete>().mockReturnValue(new Promise(() => {}));

    await expect(classifyMessageIntent('learner-1', context, { complete, timeoutMs: 20 })).resolves.toEqual({
      intent: 'question',
      source: 'fallback',
      fallback: 'timeout',
    });
  });

  it('uses OPENROUTER_INTENT_MODEL when set and the default model when empty', async () => {
    const complete = vi.fn<Complete>().mockResolvedValue({ intent: 'answer', reason: 'x' });

    vi.stubEnv('OPENROUTER_INTENT_MODEL', 'anthropic/claude-haiku-4.5');
    await classifyMessageIntent('learner-1', context, { complete });
    expect(complete.mock.calls[0][0].model).toBe('anthropic/claude-haiku-4.5');

    vi.stubEnv('OPENROUTER_INTENT_MODEL', '');
    await classifyMessageIntent('learner-1', context, { complete });
    expect(complete.mock.calls[1][0].model).toBeUndefined();
  });
});

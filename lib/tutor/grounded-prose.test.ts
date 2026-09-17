import { describe, expect, it } from 'vitest';
import { CONCEPT_TAGS } from '@/lib/schemas/exercise';
import {
  LlmTimeoutError,
  RULEBOOK_SECTIONS_BY_CONCEPT,
  RULEBOOK_SOURCES,
  educationalDayViolations,
  referencesIn,
  rulebookSourcesFor,
  sanitizeLearnerText,
  withTimeout,
} from './grounded-prose';

describe('rulebook sources', () => {
  it('parses every section and subsection header into a citable, dash-free excerpt', () => {
    const ids = RULEBOOK_SOURCES.map((source) => source.id);
    for (const id of ['R1', 'R6.4', 'R9A', 'R9B', 'R9C', 'R12.4', 'R13', 'R15.2', 'R16']) {
      expect(ids).toContain(id);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(RULEBOOK_SOURCES.map((source) => source.text).join(' ')).not.toMatch(/[—–]/);
  });

  it('resolves every concept to at least one excerpt', () => {
    for (const concept of CONCEPT_TAGS) {
      for (const id of RULEBOOK_SECTIONS_BY_CONCEPT[concept]) {
        expect(rulebookSourcesFor([id]).length, `${concept} -> ${id}`).toBeGreaterThan(0);
      }
    }
    expect(rulebookSourcesFor(['R9']).map((source) => source.id)).toEqual(['R9', 'R9A', 'R9B', 'R9C']);
  });

  it('carries the 2024 re-dated example references', () => {
    const text = RULEBOOK_SOURCES.map((source) => source.text).join('\n');
    expect(text).toContain('OS/24/450');
    expect(text).not.toMatch(/N26\d|\/26\/|Jul-26/);
  });
});

describe('educationalDayViolations', () => {
  it.each([
    'Post it on the 15th.',
    'Date it 15-06-2024.',
    'Use 30 June as the date.',
    'Use June 28 for the voucher.',
    'Post it on the fifth of June.',
    'Enter it on day 20.',
  ])('flags "%s"', (text) => {
    expect(educationalDayViolations(text)).not.toEqual([]);
  });

  it.each([
    'Post it on the 1st, the 2nd or the 31st.',
    'Date it 31-05-2024 or 02-06-2024.',
    'Deposit TDS by the 7th of next month.',
    'Use 12 decimals and 10 marks.',
    'Record 2 GST rates on one invoice.',
  ])('allows "%s"', (text) => {
    expect(educationalDayViolations(text)).toEqual([]);
  });
});

describe('small helpers', () => {
  it('finds references in any case and ignores digit-free hyphenations', () => {
    expect(referencesIn('Check inv-099, OS/24/450 and bill-by-bill.')).toEqual(['inv-099', 'OS/24/450']);
  });

  it('sanitizes learner-typed text', () => {
    expect(sanitizeLearnerText('Cash\u0007 "A/c" <b>— main</b>')).toBe('Cash A/c b- main/b');
    expect(sanitizeLearnerText('x'.repeat(100))).toHaveLength(60);
  });

  it('rejects with LlmTimeoutError when the wait runs out', async () => {
    await expect(withTimeout(new Promise(() => {}), 10)).rejects.toBeInstanceOf(LlmTimeoutError);
    await expect(withTimeout(Promise.resolve('ok'), 1000)).resolves.toBe('ok');
  });
});

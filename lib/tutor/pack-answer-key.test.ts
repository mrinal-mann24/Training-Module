import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { GeneratedExerciseSchema } from '@/lib/schemas/exercise';

// Unit 14R: the authored Blossom Variant A answer key (derived by
// scripts/derive-blossom-answer-key.py) must satisfy the exact same schema
// the scoring engine consumes — a seed-time drift here would silently
// mis-score every learner on Day 1. AnswerKeySchema isn't exported on its
// own, so validate through GeneratedExerciseSchema's answer_key shape by
// picking it out of a minimal wrapper.
const AnswerKeyOnlySchema = GeneratedExerciseSchema.shape.answer_key as z.ZodTypeAny;

const KEY_PATH = path.resolve(__dirname, '../../seed/blossom-variant-a/answer_key.json');

describe('Blossom Variant A authored answer key', () => {
  it.skipIf(!existsSync(KEY_PATH))('validates against the scoring AnswerKey schema', () => {
    const raw = JSON.parse(readFileSync(KEY_PATH, 'utf-8'));
    const parsed = AnswerKeyOnlySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(parsed.error.message);
    }

    const entries = raw.entries as { sequence: number; amount: number }[];
    // Voucher count sanity: sequences are contiguous starting at 1, so the
    // gate's expected_voucher_count (seeded from this file) is trustworthy.
    const sequences = [...new Set(entries.map((entry) => entry.sequence))].sort((a, b) => a - b);
    expect(sequences[0]).toBe(1);
    expect(sequences[sequences.length - 1]).toBe(sequences.length);
    // No negative or zero leg amounts — the derivation normalizes returns to
    // absolute amounts on the correct Dr/Cr side.
    expect(entries.every((entry) => entry.amount > 0)).toBe(true);
  });
});

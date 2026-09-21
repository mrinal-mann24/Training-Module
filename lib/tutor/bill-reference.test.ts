import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AnswerKey } from '@/lib/schemas/exercise';
import {
  allocationsFromReference,
  canonicalRef,
  documentNumberOf,
  formatBillReference,
  normalizeBillReference,
  normalizeDocumentNumber,
  parseBillReferences,
  type Allocation,
} from './bill-reference';

// Stage 0 of the rebuild (2026-09-22): one module reads and writes every
// bill reference. The round-trip below is the contract that keeps the scorer
// working unchanged: whatever the builder formats, the parser reads back as
// the same kinds in the same order, and the document's own number is the
// one documentNumberOf returns.

const shapes: { name: string; allocations: Allocation[]; expected: string; kinds: string[]; documentNumber: string | null }[] = [
  { name: 'a sale on credit', allocations: [{ ref: 'INV-3001', kind: 'new', amount: 70800 }], expected: 'INV-3001', kinds: ['bill'], documentNumber: 'INV-3001' },
  { name: 'an advance receipt', allocations: [{ ref: 'ADV-C01', kind: 'advance', amount: 45000 }], expected: 'ADV-C01 (Advance)', kinds: ['advance'], documentNumber: null },
  {
    name: 'a full settlement',
    allocations: [{ ref: 'INV-2231', kind: 'against', amount: 11600 }],
    expected: 'INV-2231 (Against Ref)',
    kinds: ['against'],
    documentNumber: null,
  },
  {
    name: 'a part payment',
    allocations: [{ ref: 'INV-2231', kind: 'against', amount: 50000, partPayment: true }],
    expected: 'INV-2231 (Against Ref, part payment)',
    kinds: ['against'],
    documentNumber: null,
  },
  { name: 'on account', allocations: [{ ref: 'On Account', kind: 'on_account', amount: 5000 }], expected: 'On Account', kinds: ['on_account'], documentNumber: null },
  {
    name: 'an invoice adjusting an advance, whatever order the builder listed them',
    allocations: [
      { ref: 'BM/2025-06', kind: 'new', amount: 50300 },
      { ref: 'ADV-02', kind: 'advance', amount: 50000 },
    ],
    expected: 'ADV-02 (Advance), BM/2025-06',
    kinds: ['advance', 'bill'],
    documentNumber: 'BM/2025-06',
  },
  {
    name: 'a payment clearing two bills',
    allocations: [
      { ref: 'DT/2027-01', kind: 'against', amount: 29500 },
      { ref: 'DT/2027-02', kind: 'against', amount: 53100 },
    ],
    expected: 'DT/2027-01 (Against Ref), DT/2027-02 (Against Ref)',
    kinds: ['against', 'against'],
    documentNumber: null,
  },
  {
    name: 'a receipt settling a bill with the excess as a new advance',
    allocations: [
      { ref: 'INV-3001', kind: 'against', amount: 25800 },
      { ref: 'ADV-C03', kind: 'advance', amount: 10000 },
    ],
    expected: 'ADV-C03 (Advance), INV-3001 (Against Ref)',
    kinds: ['advance', 'against'],
    documentNumber: null,
  },
];

describe('formatBillReference round-trips through parseBillReferences', () => {
  it.each(shapes)('$name', ({ allocations, expected, kinds, documentNumber }) => {
    const formatted = formatBillReference(allocations);
    expect(formatted).toBe(expected);
    expect(parseBillReferences(formatted).map((parsed) => parsed.kind)).toEqual(kinds);
    expect(documentNumberOf(formatted)).toBe(documentNumber);
    // Recovered allocations name the same refs and kinds (amounts unknown).
    const recovered = allocationsFromReference(formatted);
    expect(recovered.map((allocation) => allocation.kind)).toEqual(
      kinds.map((kind) => (kind === 'bill' ? 'new' : kind)),
    );
    expect(formatBillReference(recovered)).toBe(expected);
  });

  it('formats nothing for no allocations', () => {
    expect(formatBillReference([])).toBeNull();
    expect(allocationsFromReference(null)).toEqual([]);
  });

  it('reads the shapes older keys and the prompt wrote', () => {
    expect(parseBillReferences('INV-005 (Full settlement)')).toEqual([{ ref: 'INV-005', kind: 'bill' }]);
    expect(parseBillReferences('MS/920, MS/945 (Against Ref, full settlement)')).toEqual([
      { ref: 'MS/920', kind: 'bill' },
      { ref: 'MS/945', kind: 'against' },
    ]);
    expect(parseBillReferences('Against Ref ADV-S01, New Ref MS/990')).toEqual([
      { ref: 'ADV-S01', kind: 'against' },
      { ref: 'MS/990', kind: 'bill' },
    ]);
  });
});

describe('canonicalRef', () => {
  it('equates spellings of one number and rejects placeholders', () => {
    expect(canonicalRef('INV-005')).toBe('INV-5');
    expect(canonicalRef('inv 5')).toBe('INV-5');
    expect(canonicalRef('Ref: INV-05')).toBe('INV-5');
    expect(canonicalRef('INV-025 dt 04-May')).toBe('INV-25');
    expect(canonicalRef('New Ref')).toBeNull();
    expect(canonicalRef('On Account')).toBeNull();
  });
});

// Corpus parity: over every reference the interns' stored keys carry, the
// three normalizers must agree on which references are the same number.
// The fixtures are local only (owner decision 2026-09-22); the test skips
// without them.
const FIXTURES = path.resolve(__dirname, '__fixtures__', 'keys');
const fixturesPresent = existsSync(FIXTURES) && readdirSync(FIXTURES).some((file) => file.endsWith('.json'));

describe.skipIf(!fixturesPresent)('the three normalizers agree on the stored keys', () => {
  it('partition every reference the same way', () => {
    const refs = new Set<string>();
    for (const file of readdirSync(FIXTURES).filter((name) => name.endsWith('.json'))) {
      const rows = JSON.parse(readFileSync(path.join(FIXTURES, file), 'utf8')) as { answer_key: AnswerKey | null }[];
      for (const row of rows) {
        for (const entry of row.answer_key?.entries ?? []) {
          for (const parsed of parseBillReferences(entry.bill_reference)) refs.add(parsed.ref);
        }
      }
    }
    expect(refs.size).toBeGreaterThan(50);

    const disagreements: string[] = [];
    const byReplay = new Map<string, Set<string | null>>();
    const byGeneration = new Map<string, Set<string | null>>();
    for (const ref of refs) {
      const canonical = canonicalRef(ref);
      const replay = normalizeBillReference(ref);
      const generation = normalizeDocumentNumber(ref);
      byReplay.set(replay, (byReplay.get(replay) ?? new Set()).add(canonical));
      byGeneration.set(generation, (byGeneration.get(generation) ?? new Set()).add(canonical));
    }
    for (const [replay, canonicals] of byReplay) {
      if (canonicals.size > 1) disagreements.push(`replay "${replay}" spans ${[...canonicals].join(' / ')}`);
    }
    for (const [generation, canonicals] of byGeneration) {
      if (canonicals.size > 1) disagreements.push(`generation "${generation}" spans ${[...canonicals].join(' / ')}`);
    }
    const byCanonical = new Map<string | null, Set<string>>();
    for (const ref of refs) {
      const canonical = canonicalRef(ref);
      byCanonical.set(canonical, (byCanonical.get(canonical) ?? new Set()).add(normalizeBillReference(ref)));
    }
    for (const [canonical, replays] of byCanonical) {
      if (canonical !== null && replays.size > 1) disagreements.push(`canonical "${canonical}" is ${[...replays].join(' / ')} to replay`);
    }
    expect(disagreements).toEqual([]);
  });
});

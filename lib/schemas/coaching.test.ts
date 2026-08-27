import { describe, expect, it } from 'vitest';
import { normalizeStoredCoaching } from './coaching';

describe('normalizeStoredCoaching (Phase 1 compat mapper)', () => {
  it('passes the current shape through unchanged', () => {
    const current = {
      opening_line: 'Your submission came in at 89 percent.',
      went_well: ['TDS on the base every time.'],
      needs_work: ['Look again at the GST on INV-012.'],
      next_note: 'Batch 2 is on the way.',
    };
    expect(normalizeStoredCoaching(current)).toEqual(current);
  });

  it('maps a pre-Phase-1 legacy row into the new shape', () => {
    const legacy = {
      result_line: 'A partial result.',
      praise: 'Voucher types were right across the board.',
      flagged_areas: ['the GST treatment on INV-012'],
      next_step_note: 'Focus on the flagged areas.',
    };
    expect(normalizeStoredCoaching(legacy)).toEqual({
      opening_line: 'A partial result.',
      went_well: ['Voucher types were right across the board.'],
      needs_work: ['the GST treatment on INV-012'],
      next_note: 'Focus on the flagged areas.',
    });
  });

  it('maps an empty legacy praise to an empty went_well list', () => {
    const legacy = { result_line: 'r', praise: '  ', flagged_areas: [], next_step_note: 'n' };
    expect(normalizeStoredCoaching(legacy).went_well).toEqual([]);
  });

  it('renders an honest placeholder for an unrecognizable row instead of crashing', () => {
    const mapped = normalizeStoredCoaching({ junk: true });
    expect(mapped.opening_line.length).toBeGreaterThan(0);
    expect(mapped.needs_work).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { abbreviationMatches } from './ledger-findings';

describe('abbreviationMatches (Garima\'s short party ledgers, 2026-09-10)', () => {
  it('recognises the real abbreviations', () => {
    expect(abbreviationMatches('KAREMP', 'Karnataka Emporium')).toBe(true);
    expect(abbreviationMatches('DBAZAAR', 'Delhi Bazaar')).toBe(true);
    expect(abbreviationMatches('MUMBAISUP', 'Mumbai Suppliers')).toBe(true);
    expect(abbreviationMatches('KHANDICRAFT', 'Kerala Handicrafts')).toBe(true);
    expect(abbreviationMatches('AHMDIMPT', 'Ahmedabad Import')).toBe(true);
  });

  it('does not pair a short name with a different party', () => {
    expect(abbreviationMatches('KOLKATRD', 'Kolkata Emporium')).toBe(false);
    expect(abbreviationMatches('AHMDIMPT', 'Ahmedabad Elite')).toBe(false);
    expect(abbreviationMatches('VIZAGFURN', 'Vizag Vendors')).toBe(false);
    expect(abbreviationMatches('Deccan', 'Delhi Bazaar')).toBe(false);
  });

  it('needs enough letters and never matches a name against itself or a longer one', () => {
    expect(abbreviationMatches('KE', 'Karnataka Emporium')).toBe(false);
    expect(abbreviationMatches('Karnataka Emporium', 'Karnataka Emporium')).toBe(false);
    expect(abbreviationMatches('Karnataka Emporium S', 'Karnataka Emporium')).toBe(false);
  });
});

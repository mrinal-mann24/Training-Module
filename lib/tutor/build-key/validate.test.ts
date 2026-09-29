import { describe, expect, it } from 'vitest';
import { buildPartyMaster } from '@/lib/tutor/party-master';
import { isNearSpelling, loosePartyKey, partyNameViolation } from './validate';

const master = buildPartyMaster(['Bharat Machinery', 'Deccan Traders', 'Mumbai Suppliers', 'Mehta & Associates (firm)', 'Kolkata Traders']);
const check = (name: string, newParty: boolean, raisedInBatch: string[] = []): string | null =>
  partyNameViolation({ name, newParty, master, raisedInBatch: new Set(raisedInBatch.map(loosePartyKey)) });

describe('isNearSpelling', () => {
  it('reads one or two letters apart as the same name', () => {
    expect(isNearSpelling('bharathmachinery', 'bharatmachinery')).toBe(true);
    expect(isNearSpelling('deccantradars', 'deccantraders')).toBe(true);
    expect(isNearSpelling('mumbaisupliers', 'mumbaisuppliers')).toBe(true);
  });

  it('allows a short name only one letter', () => {
    expect(isNearSpelling('kochimart', 'kochimarts')).toBe(true);
    expect(isNearSpelling('kochimart', 'kochimaars')).toBe(false);
  });

  it('keeps really different names apart', () => {
    expect(isNearSpelling('bangalorecleaning', 'bangalorecleaners')).toBe(false);
    expect(isNearSpelling('kolkatatraders', 'kolkataemporium')).toBe(false);
    expect(isNearSpelling('vizagvendors', 'vizagfurnishings')).toBe(false);
    expect(isNearSpelling('rathi', 'rathe')).toBe(false);
    expect(isNearSpelling('deccantraders', 'deccantraders')).toBe(false);
  });
});

describe('partyNameViolation: one party, one spelling (2026-09-29)', () => {
  it('accepts a party of the books exactly as the books spell it', () => {
    expect(check('Bharat Machinery', false)).toBeNull();
    expect(check('Deccan Traders Pvt Ltd', false)).toBeNull();
  });

  it('refuses a near spelling of an existing party, even as a new party', () => {
    expect(check('Bharath Machinery', true)).toContain('looks like the existing party "Bharat Machinery"');
    expect(check('Deccan Tradars', true)).toContain('looks like the existing party "Deccan Traders"');
    expect(check('Kolkata Trader', false)).toContain('looks like the existing party "Kolkata Traders"');
  });

  it('refuses a second spelling of a party raised earlier in the same plan', () => {
    expect(check('Rathi Fabrics', true, ['Rathi Fabrics'])).toBeNull();
    expect(check('Rathee Fabrics', true, ['Rathi Fabrics'])).toContain('spelled almost like another new party');
  });

  it('accepts a clearly different new party', () => {
    expect(check('Rathi Fabrics', true)).toBeNull();
    expect(check('Surat Silk House', true)).toBeNull();
  });
});

describe('partyNameViolation: a new party is named after a place the books can place (2026-09-29)', () => {
  it('refuses a new party named after any other town or state, and lists the cities to use', () => {
    const violation = check('Pune Textiles', true);
    expect(violation).toContain('names Pune');
    expect(violation).toContain('Bengaluru');
    expect(violation).toContain('Mumbai');
    expect(check('Lucknow Chikan House', true)).toContain('names Lucknow');
  });

  it('accepts a name that only looks like a place inside a longer word', () => {
    expect(check('Agrawal Traders', true)).toBeNull();
  });

  it('still asks for new_party before anything else when the name is unknown', () => {
    expect(check('Pune Textiles', false)).toContain('is not a party in the books');
  });
});

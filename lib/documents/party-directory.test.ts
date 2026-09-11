import { describe, expect, it } from 'vitest';
import { gstinCheckDigit, normalizePartyName, partyDetailsFor } from './party-directory';

describe('gstinCheckDigit', () => {
  it('computes the Luhn mod-36 check character of a real GSTIN and stamps it on every generated one', () => {
    expect(gstinCheckDigit('27AAPFU0939F1Z')).toBe('V');
    for (const name of ['Deccan Traders', 'Mumbai Suppliers', 'Sharma Legal (individual)']) {
      const gstin = partyDetailsFor(name, true).gstin;
      expect(gstin).toHaveLength(15);
      expect(gstin[14]).toBe(gstinCheckDigit(gstin.slice(0, 14)));
    }
  });
});

const GSTIN = /^[0-9]{2}[A-Z]{3}[CFP][A-Z][0-9]{4}[A-Z]1Z[0-9A-Z]$/;

describe('partyDetailsFor', () => {
  it('gives a known party a fixed city, a matching GSTIN state code, and the same details every time', () => {
    const first = partyDetailsFor('Mumbai Suppliers', true);
    const again = partyDetailsFor('Mumbai Suppliers', true);
    expect(first).toEqual(again);
    expect(first.city).toBe('Mumbai');
    expect(first.state).toBe('Maharashtra');
    expect(first.gstin).toMatch(GSTIN);
    expect(first.gstin.slice(0, 2)).toBe('27');
    expect(first.address).toMatch(/^#\d+, .+, Mumbai 400\d{3}, Maharashtra$/);
  });

  it('keeps home-state parties in Karnataka with the 29 state code', () => {
    const deccan = partyDetailsFor('Deccan Traders', false);
    expect(deccan.state).toBe('Karnataka');
    expect(deccan.gstin.slice(0, 2)).toBe('29');
    expect(partyDetailsFor('Mysore Decor', false).city).toBe('Mysuru');
  });

  it('ignores ledger suffixes so "Sharma Legal (individual)" is the same party as "Sharma Legal"', () => {
    expect(normalizePartyName('Sharma Legal (individual)')).toBe('sharmalegal');
    expect(partyDetailsFor('Sharma Legal (individual)', null).address).toBe(partyDetailsFor('Sharma Legal', null).address);
  });

  it('never prints an address that contradicts the GST charged', () => {
    // Directory says Bengaluru, invoice charges IGST → moved out of state.
    const moved = partyDetailsFor('Deccan Traders', true);
    expect(moved.state).not.toBe('Karnataka');
    expect(moved.gstin.slice(0, 2)).toBe(moved.stateCode);
    // Directory says Mumbai, invoice charges CGST+SGST → brought home.
    expect(partyDetailsFor('Mumbai Suppliers', false).state).toBe('Karnataka');
    // No GST on the bill → the directory's own state stands.
    expect(partyDetailsFor('Mumbai Suppliers', null).state).toBe('Maharashtra');
  });

  it('reads the city out of an unknown name and otherwise falls back by regime', () => {
    expect(partyDetailsFor('Kolkata Fabrics', true).state).toBe('West Bengal');
    expect(partyDetailsFor('Pune Textiles', true).state).toBe('Maharashtra');
    expect(partyDetailsFor('Pune Textiles', false).state).toBe('Karnataka');
    expect(partyDetailsFor('Pune Textiles', true).gstin).toMatch(GSTIN);
  });

  it('marks firms and individuals in the PAN entity letter', () => {
    expect(partyDetailsFor('Mehta & Associates', false).gstin[5]).toBe('F');
    expect(partyDetailsFor('Hero Rentals', false).gstin[5]).toBe('P');
    expect(partyDetailsFor('Deccan Traders', false).gstin[5]).toBe('C');
  });
});

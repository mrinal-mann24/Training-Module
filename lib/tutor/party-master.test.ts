import { describe, expect, it } from 'vitest';
import { buildPartyMaster, gstTreatmentFor, panAvailableFor, payeeTypeFor } from './party-master';

describe('buildPartyMaster', () => {
  const master = buildPartyMaster(['Deccan Traders', 'Sharma Legal (individual)', 'Mumbai Suppliers']);

  it('maps a spelling of a known party onto the ledger the books already use', () => {
    const party = master.resolve('Deccan Traders Pvt Ltd');
    expect(party.ledgerName).toBe('Deccan Traders');
    expect(party.known).toBe(true);
    expect(party.gstin).toBe(master.resolve('Deccan Traders').gstin);
  });

  it('gives a new party a fresh identity that collides with no registry party', () => {
    const fresh = master.resolve('Rathi Fabrics');
    expect(fresh.known).toBe(false);
    expect(fresh.ledgerName).toBe('Rathi Fabrics');
    const gstins = new Set(master.registry.map((name) => master.resolve(name).gstin));
    expect(gstins.has(fresh.gstin)).toBe(false);
    expect(fresh.gstin.slice(0, 2)).toBe(fresh.stateCode);
  });

  it('is stable: the same name resolves to the same identity every time', () => {
    expect(master.resolve('Mumbai Suppliers')).toEqual(master.resolve('mumbai suppliers'));
  });
});

describe('tax treatment from the master', () => {
  const master = buildPartyMaster([]);

  it('taxes by the party state, not by history', () => {
    expect(gstTreatmentFor(master.resolve('Mumbai Suppliers'))).toBe('inter');
    expect(gstTreatmentFor(master.resolve('Deccan Traders'))).toBe('intra');
  });

  it('reads the payee type off the entity type and always has a PAN', () => {
    const individual = master.resolve('Hero Rentals (individual)');
    expect(individual.entityType).toBe('P');
    expect(payeeTypeFor(individual)).toBe('individual_huf');
    expect(payeeTypeFor(master.resolve('Mehta & Associates'))).toBe('other');
    expect(panAvailableFor(individual)).toBe(true);
  });
});

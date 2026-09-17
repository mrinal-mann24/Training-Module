import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  gstinCheckDigit,
  isValidGstin,
  normalizePartyName,
  partyDetailsFor,
  partyIdentityFor,
  partyTaxClassFor,
  resolvePartyIdentities,
  stateCodeOf,
} from './party-directory';
import { COMPANY_DETAILS } from './company-details';

describe('gstinCheckDigit', () => {
  it('computes the Luhn mod-36 check character of a real GSTIN and stamps it on every generated one', () => {
    expect(gstinCheckDigit('27AAPFU0939F1Z')).toBe('V');
    for (const name of ['Deccan Traders', 'Mumbai Suppliers', 'Sharma Legal (individual)']) {
      const gstin = partyIdentityFor(name).gstin;
      expect(gstin).toHaveLength(15);
      expect(gstin[14]).toBe(gstinCheckDigit(gstin.slice(0, 14)));
    }
  });

  // The company's own GSTIN matches the pack's Company Master sheet, which
  // learners type into Tally, so it keeps the pack's mock check character
  // (2026-09-17 user decision: mock is fine, consistency is what matters).
  it("keeps the company's own GSTIN identical to the pack's Company Master", () => {
    expect(COMPANY_DETAILS.gstin).toBe('29AABCB1234H1Z5');
  });
});

// Every GSTIN literal written in code or a test fixture must pass the check
// digit (2026-09-17: four fixtures and the company constant did not). Learner
// Tally exports under xmls/ are data, not code, and are not scanned.
describe('every GSTIN literal in the code base is structurally valid', () => {
  const root = path.resolve(__dirname, '..', '..');
  const GSTIN_LITERAL = /\b\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]\b/g;
  const SKIP = new Set(['node_modules', '.next', '.git', 'xmls', 'public', 'coverage']);

  function sourceFiles(directory: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(directory)) {
      if (SKIP.has(entry)) continue;
      const full = path.join(directory, entry);
      if (statSync(full).isDirectory()) files.push(...sourceFiles(full));
      else if (/\.(ts|tsx|mjs|js|py|sql)$/.test(entry)) files.push(full);
    }
    return files;
  }

  it('finds no GSTIN with a wrong check character', () => {
    const invalid: string[] = [];
    let seen = 0;
    for (const directory of ['lib', 'app', 'components', 'scripts', 'supabase']) {
      let files: string[] = [];
      try {
        files = sourceFiles(path.join(root, directory));
      } catch {
        continue;
      }
      for (const file of files) {
        for (const match of readFileSync(file, 'utf8').matchAll(GSTIN_LITERAL)) {
          seen += 1;
          if (match[0] === COMPANY_DETAILS.gstin) continue;
          if (!isValidGstin(match[0])) invalid.push(`${path.relative(root, file)}: ${match[0]}`);
        }
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(invalid).toEqual([]);
  });
});

const GSTIN = /^[0-9]{2}[A-Z]{3}[CFP][A-Z][0-9]{4}[A-Z]1Z[0-9A-Z]$/;

describe('partyIdentityFor: one party, one GSTIN, one address (2026-09-17)', () => {
  it('gives a known party a fixed city, a matching GSTIN state code, and the same details every time', () => {
    const first = partyIdentityFor('Mumbai Suppliers');
    expect(first).toEqual(partyIdentityFor('Mumbai Suppliers'));
    expect(first.city).toBe('Mumbai');
    expect(first.state).toBe('Maharashtra');
    expect(first.gstin).toMatch(GSTIN);
    expect(first.gstin.slice(0, 2)).toBe('27');
    expect(first.gstin.slice(2, 12)).toBe(first.pan);
    expect(first.address).toMatch(/^#\d+, .+, Mumbai 400\d{3}, Maharashtra$/);
  });

  it('keeps home-state parties in Karnataka with the 29 state code', () => {
    const deccan = partyIdentityFor('Deccan Traders');
    expect(deccan.state).toBe('Karnataka');
    expect(deccan.gstin.slice(0, 2)).toBe('29');
    expect(partyIdentityFor('Mysore Decor').city).toBe('Mysuru');
  });

  it('is keyed by the canonical ledger name, so name variants are the same party', () => {
    expect(normalizePartyName('Sharma Legal (individual)')).toBe('sharmalegal');
    expect(normalizePartyName('Deccan Traders Pvt. Ltd.')).toBe('deccantraders');
    expect(normalizePartyName('Deccan Traders Private Limited')).toBe('deccantraders');
    const canonical = partyIdentityFor('Deccan Traders');
    for (const variant of ['Deccan Traders Pvt Ltd', 'DECCAN TRADERS', 'Deccan Traders (vendor)', 'Deccan  Traders Ltd']) {
      const identity = partyIdentityFor(variant);
      expect(identity.gstin).toBe(canonical.gstin);
      expect(identity.address).toBe(canonical.address);
      expect(identity.name).toBe(variant);
    }
  });

  it('never moves a party to fit a tax head: the old regime argument is ignored', () => {
    const deccan = partyIdentityFor('Deccan Traders');
    expect(partyDetailsFor('Deccan Traders', true)).toEqual(deccan);
    expect(partyDetailsFor('Deccan Traders', false)).toEqual(deccan);
    expect(partyDetailsFor('Mumbai Suppliers', false).state).toBe('Maharashtra');
    expect(partyTaxClassFor('Deccan Traders')).toBe('intra');
    expect(partyTaxClassFor('Mumbai Suppliers')).toBe('inter');
  });

  it('reads the city out of an unknown name and otherwise places the party at home', () => {
    expect(partyIdentityFor('Kolkata Fabrics').state).toBe('West Bengal');
    expect(partyIdentityFor('Pune Textiles').state).toBe('Karnataka');
    expect(partyTaxClassFor('Pune Textiles')).toBe('intra');
    expect(partyIdentityFor('Pune Textiles').gstin).toMatch(GSTIN);
  });

  it('marks firms and individuals in the PAN entity letter', () => {
    expect(partyIdentityFor('Mehta & Associates').entityType).toBe('F');
    expect(partyIdentityFor('Mehta & Associates').gstin[5]).toBe('F');
    expect(partyIdentityFor('CA Ramesh & Co').gstin[5]).toBe('F');
    expect(partyIdentityFor('Hero Rentals').gstin[5]).toBe('P');
    expect(partyIdentityFor('Deccan Traders').gstin[5]).toBe('C');
  });

  it("keeps a directory party's GSTIN as printed before 2026-09-17 when its city matched its regime", () => {
    // Values printed by the pre-rewrite directory for these parties.
    expect(partyIdentityFor('Deccan Traders').gstin).toBe('29AUMCD4595H1ZW');
    expect(partyIdentityFor('Deccan Traders').address).toBe('#60, Main Bazaar, Bengaluru 560099, Karnataka');
    expect(partyIdentityFor('Mumbai Suppliers').gstin).toBe('27ACSCM7291M1ZC');
    expect(partyIdentityFor('Mehta & Associates').gstin).toBe('29ASOFM1303D1ZJ');
    expect(stateCodeOf('Tamil Nadu')).toBe('33');
    expect(partyIdentityFor('Chennai Home Store').stateCode).toBe('33');
  });
});

// Uniqueness proof: 60,000 distinct party names (all sharing one initial,
// the worst case for the PAN space) resolve to 60,000 distinct GSTINs and
// PANs, every one structurally valid with the right state code, and the
// resolution is first-seen stable.
describe('resolvePartyIdentities: GSTINs are unique across all parties', () => {
  const WORDS = ['Traders', 'Suppliers', 'Emporium', 'Textiles', 'Decor', 'Stores', 'Agencies', 'Mart', 'Exports', 'Crafts'];
  const CITIES = ['', ' Chennai', ' Mumbai', ' Kolkata', ' Delhi', ' Hyderabad'];
  // Every name starts with V and is a company, so all share one PAN space.
  const names = Array.from({ length: 60000 }, (_, index) => `Vendor ${index} ${WORDS[index % WORDS.length]}${CITIES[index % CITIES.length]}`);

  const resolved = resolvePartyIdentities(names);
  const identities = [...resolved.values()];

  it('resolves every distinct party to its own GSTIN and PAN', () => {
    expect(resolved.size).toBe(new Set(names.map(normalizePartyName)).size);
    expect(new Set(identities.map((identity) => identity.gstin)).size).toBe(identities.length);
    expect(new Set(identities.map((identity) => identity.pan)).size).toBe(identities.length);
  });

  it('actually had seed-0 collisions to resolve (the probe is exercised)', () => {
    const seedZero = names.map((name) => resolvePartyIdentities([name]).get(normalizePartyName(name))!.pan);
    expect(new Set(seedZero).size).toBeLessThan(seedZero.length);
  });

  it('prints only valid GSTINs whose state code matches the address state', () => {
    for (const identity of identities) {
      expect(isValidGstin(identity.gstin)).toBe(true);
      expect(identity.gstin.slice(0, 2)).toBe(identity.stateCode);
      expect(stateCodeOf(identity.state)).toBe(identity.stateCode);
      expect(identity.address.endsWith(identity.state)).toBe(true);
    }
  });

  it('is first-seen stable: adding parties never changes an earlier party', () => {
    const prefix = resolvePartyIdentities(names.slice(0, 30000));
    for (const [key, identity] of prefix) {
      expect(resolved.get(key)).toEqual(identity);
    }
  });

  it('partyIdentityFor with the company registry never collides with an earlier registry party', () => {
    const registry = names.slice(0, 300);
    const gstins = new Set(registry.map((name) => partyIdentityFor(name, registry).gstin));
    expect(gstins.size).toBe(new Set(registry.map(normalizePartyName)).size);
  });
});

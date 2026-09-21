import { HOME_STATE_CODE, normalizePartyName, partyIdentityFor, type PartyIdentity } from '@/lib/documents/party-directory';
import { inferPayeeType, type PayeeType } from '@/lib/tutor/tax-rules';

// Party master (2026-09-22, rebuild Stage 2). Every customer and vendor has
// ONE identity: state, GSTIN, PAN, entity type, address. The key builder
// takes the GST head from the party's state and the TDS rate from its
// entity type, never from what the model wrote or from how the party was
// taxed in an earlier key (partyTaxClassesFromKeys let a party drift with
// the model's mistakes: ten of the 43 audited key errors were a CGST/SGST
// key against an out-of-state party).
//
// v1 resolves in memory from the company's ledger registry (first-seen
// order), through partyIdentityFor, which is deterministic per canonical
// name and never collides with an earlier party's GSTIN or PAN. A stored
// company_parties table can replace the registry later without changing
// this module's callers.

export type PartyRecord = PartyIdentity & {
  // The ledger name the books already use for this party, when they do:
  // a plan naming "Deccan Traders Pvt Ltd" posts to the existing "Deccan
  // Traders" ledger rather than opening a second one.
  ledgerName: string;
  known: boolean;
};

export type PartyMaster = {
  registry: readonly string[];
  resolve: (name: string) => PartyRecord;
};

export function buildPartyMaster(registryNames: readonly string[]): PartyMaster {
  const registry = [...registryNames];
  const byKey = new Map<string, string>();
  for (const name of registry) {
    const key = normalizePartyName(name);
    if (key.length > 0 && !byKey.has(key)) byKey.set(key, name);
  }
  return {
    registry,
    resolve(name: string): PartyRecord {
      const key = normalizePartyName(name);
      const ledgerName = byKey.get(key) ?? name.trim();
      const identity = partyIdentityFor(ledgerName, registry);
      return { ...identity, ledgerName, known: byKey.has(key) };
    },
  };
}

export function gstTreatmentFor(party: Pick<PartyRecord, 'stateCode'>): 'intra' | 'inter' {
  return party.stateCode === HOME_STATE_CODE ? 'intra' : 'inter';
}

// 194C's rate turns on the payee's constitution: PAN 4th character P is an
// individual (or HUF), everything else a company or firm.
export function payeeTypeFor(party: Pick<PartyRecord, 'entityType' | 'name'>): PayeeType {
  return party.entityType === 'P' ? 'individual_huf' : inferPayeeType(party.name, party.entityType === 'F' ? 'firm' : 'company');
}

// Every directory identity carries a PAN; the no-PAN 20% rate (s. 206AA)
// is not exercised by v1.
export function panAvailableFor(party: Pick<PartyRecord, 'pan'>): boolean {
  return party.pan.length === 10;
}

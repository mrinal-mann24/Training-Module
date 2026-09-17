import { createHash } from 'node:crypto';
import { normalizeAccountName } from '@/lib/tutor/account-names';

// Party directory (2026-09-09). Every vendor and customer that appears on a
// generated document gets a fixed address and GSTIN, decided by code, so the
// same party prints the same details on every invoice in every batch. Before
// this the model invented a "valid-looking" GSTIN per invoice, which gave AI
// Accountant a different GSTIN for the same vendor each month and left
// invoices with no address at all.
//
// One party, one identity (2026-09-17). The identity used to be derived
// from whatever name string the model printed ("Deccan Traders" and "Deccan
// Traders Pvt Ltd" got two GSTINs) and partyDetailsFor MOVED a party to
// another state when the invoice's GST head disagreed with its city, so one
// vendor could show two states and two addresses in two months. The user's
// rule: GSTINs may be mock, but one vendor = one address = one GSTIN, as in
// the real world. Now:
//   - the identity is keyed by the party's canonical ledger name from the
//     answer key (normalizePartyName), never by the printed name;
//   - GSTIN, PAN (GSTIN chars 3-12), state, state code, address and entity
//     type are a pure function of that key and never depend on the tax head;
//   - GSTINs and PANs are unique: hash collisions are resolved by probing the
//     next seed, first-seen party keeps its identity (resolvePartyIdentities).
// Whether a party's invoice may carry IGST or CGST+SGST is decided by the
// party's fixed state (partyTaxClassFor) and enforced by the generation
// checks, never by relocating the party.

export type PartyEntityType = 'C' | 'F' | 'P';

export type PartyIdentity = {
  // Canonical key (normalizePartyName) the identity is derived from.
  key: string;
  // The name the caller passed (the key's ledger name), for printing.
  name: string;
  city: string;
  state: string;
  stateCode: string;
  address: string;
  // 10-character PAN, identical to gstin.slice(2, 12).
  pan: string;
  gstin: string;
  // PAN 4th character: C company, F firm (partnership/LLP), P individual.
  entityType: PartyEntityType;
};

// Kept for existing imports (scripts/restamp-open-vendor-identities.ts).
export type PartyDetails = PartyIdentity;

type CityInfo = { city: string; state: string; stateCode: string; pinPrefix: string };

export const HOME_STATE = 'Karnataka';
export const HOME_STATE_CODE = '29';

const CITIES = {
  bengaluru: { city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pinPrefix: '560' },
  mysuru: { city: 'Mysuru', state: 'Karnataka', stateCode: '29', pinPrefix: '570' },
  mumbai: { city: 'Mumbai', state: 'Maharashtra', stateCode: '27', pinPrefix: '400' },
  nagpur: { city: 'Nagpur', state: 'Maharashtra', stateCode: '27', pinPrefix: '440' },
  chennai: { city: 'Chennai', state: 'Tamil Nadu', stateCode: '33', pinPrefix: '600' },
  coimbatore: { city: 'Coimbatore', state: 'Tamil Nadu', stateCode: '33', pinPrefix: '641' },
  trichy: { city: 'Tiruchirappalli', state: 'Tamil Nadu', stateCode: '33', pinPrefix: '620' },
  ahmedabad: { city: 'Ahmedabad', state: 'Gujarat', stateCode: '24', pinPrefix: '380' },
  surat: { city: 'Surat', state: 'Gujarat', stateCode: '24', pinPrefix: '395' },
  kochi: { city: 'Kochi', state: 'Kerala', stateCode: '32', pinPrefix: '682' },
  ludhiana: { city: 'Ludhiana', state: 'Punjab', stateCode: '03', pinPrefix: '141' },
  kolkata: { city: 'Kolkata', state: 'West Bengal', stateCode: '19', pinPrefix: '700' },
  delhi: { city: 'New Delhi', state: 'Delhi', stateCode: '07', pinPrefix: '110' },
  jaipur: { city: 'Jaipur', state: 'Rajasthan', stateCode: '08', pinPrefix: '302' },
  visakhapatnam: { city: 'Visakhapatnam', state: 'Andhra Pradesh', stateCode: '37', pinPrefix: '530' },
  hyderabad: { city: 'Hyderabad', state: 'Telangana', stateCode: '36', pinPrefix: '500' },
} satisfies Record<string, CityInfo>;

type CityKey = keyof typeof CITIES;

// State name -> GST state code, for printing "Place of supply: Tamil Nadu (33)".
export function stateCodeOf(state: string): string | null {
  const match = Object.values(CITIES).find((info) => info.state.toLowerCase() === state.trim().toLowerCase());
  return match?.stateCode ?? null;
}

// The parties of the official pack and of every batch generated so far,
// keyed by canonical key. Home-state parties sit in Bengaluru unless the
// name says otherwise; out-of-state parties take the city in their name.
// `entity` pins the PAN entity letter where the key alone cannot tell it
// ("CA Ramesh & Co" normalises to carameshco). APPEND ONLY: the order is the
// first-seen order that settles GSTIN collisions inside the directory.
const KNOWN_PARTIES: Record<string, { city: CityKey; entity?: PartyEntityType }> = {
  ahmedabadelite: { city: 'ahmedabad' },
  ahmedabadimport: { city: 'ahmedabad' },
  balajiinteriors: { city: 'bengaluru' },
  bangalorecleaning: { city: 'bengaluru' },
  bangalorecleaners: { city: 'bengaluru' },
  bengaluruboutique: { city: 'bengaluru' },
  bengalurulocalstore: { city: 'bengaluru' },
  bharatmachinery: { city: 'bengaluru' },
  bharatmac: { city: 'bengaluru' },
  carameshco: { city: 'bengaluru', entity: 'F' },
  chennaihomestore: { city: 'chennai' },
  chennaisuppliers: { city: 'chennai' },
  coimbatoreinteriors: { city: 'coimbatore' },
  coimbatorewholesale: { city: 'coimbatore' },
  deccantraders: { city: 'bengaluru' },
  deliverydirect: { city: 'bengaluru' },
  delhibazaar: { city: 'delhi' },
  gujaratretail: { city: 'surat' },
  herorentals: { city: 'bengaluru', entity: 'P' },
  hyderabadinteriors: { city: 'hyderabad' },
  karnatakaemporium: { city: 'bengaluru' },
  keralahandicrafts: { city: 'kochi' },
  kochimodern: { city: 'kochi' },
  kolkataemporium: { city: 'kolkata' },
  kolkatatraders: { city: 'kolkata' },
  ludhianawoodworks: { city: 'ludhiana' },
  mehtaassociates: { city: 'bengaluru', entity: 'F' },
  mumbaisuppliers: { city: 'mumbai' },
  mysoredecor: { city: 'mysuru' },
  nagpurretail: { city: 'nagpur' },
  rajasthanhomedecor: { city: 'jaipur' },
  sharmalegal: { city: 'bengaluru', entity: 'F' },
  signageadvertising: { city: 'bengaluru' },
  softwarecloudllc: { city: 'bengaluru' },
  trichytextiles: { city: 'trichy' },
  vizagfurnishings: { city: 'visakhapatnam' },
  vizagvendors: { city: 'visakhapatnam' },
};

// A city named inside an unknown party key ("Pune Textiles" would need a
// new row here; these cover the names the generator has actually used).
// Matched against the canonical key, so the state is a function of the key.
const CITY_HINTS: [RegExp, CityKey][] = [
  [/bengaluru|bangalore|karnataka/, 'bengaluru'],
  [/mysore|mysuru/, 'mysuru'],
  [/mumbai|bombay|maharashtra/, 'mumbai'],
  [/nagpur/, 'nagpur'],
  [/chennai|madras|tamil/, 'chennai'],
  [/coimbatore/, 'coimbatore'],
  [/trichy|tiruchirappalli/, 'trichy'],
  [/ahmedabad/, 'ahmedabad'],
  [/gujarat|surat/, 'surat'],
  [/kochi|cochin|kerala/, 'kochi'],
  [/ludhiana|punjab/, 'ludhiana'],
  [/kolkata|calcutta|bengal/, 'kolkata'],
  [/delhi/, 'delhi'],
  [/jaipur|rajasthan/, 'jaipur'],
  [/vizag|visakhapatnam|andhra/, 'visakhapatnam'],
  [/hyderabad|telangana/, 'hyderabad'],
];

const STREETS = [
  'MG Road',
  'Station Road',
  'Industrial Estate',
  'Market Street',
  'Gandhi Nagar',
  'Nehru Place',
  'Commercial Street',
  'Ring Road',
  'Main Bazaar',
  'Trade Centre',
];

// Canonical party key (2026-09-17): the ledger name with Tally-style party
// tags "(individual)", "(firm)"... and a trailing legal form ("Pvt Ltd",
// "Private Limited", "Ltd", "Limited") removed, then the repo's
// normalizeAccountName (lowercase alphanumerics), so "Deccan Traders Pvt
// Ltd" and "Deccan Traders (vendor)" are the same party as "Deccan Traders".
export function normalizePartyName(name: string): string {
  const stripped = name
    .toLowerCase()
    .replace(/\((individual|firm|company|debtor|creditor|customer|vendor|supplier)\)/g, ' ')
    .replace(/\b(?:private|pvt\.?)\s*(?:limited|ltd\.?)\s*$/, ' ')
    .replace(/\b(?:limited|ltd\.?)\s*$/, ' ');
  return normalizeAccountName(stripped);
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

function digest(key: string, seed: number): Buffer {
  // Seed 0 keeps the pre-2026-09-17 digest so a directory party whose old
  // regime matched its city keeps the GSTIN it already printed.
  return createHash('sha256').update(seed === 0 ? `party:${key}` : `party:${key}#${seed}`).digest();
}

function cityForKey(key: string): CityInfo {
  const known = KNOWN_PARTIES[key];
  if (known) return CITIES[known.city];
  for (const [pattern, city] of CITY_HINTS) {
    if (pattern.test(key)) return CITIES[city];
  }
  // A name that says nowhere else is a home-state party: its invoices carry
  // CGST+SGST. To bill IGST the generator must use an out-of-state party.
  return CITIES.bengaluru;
}

function entityTypeForKey(key: string): PartyEntityType {
  const pinned = KNOWN_PARTIES[key]?.entity;
  if (pinned) return pinned;
  if (/associates|legal|llp|partners/.test(key)) return 'F';
  if (/rentals|individual|proprietor/.test(key)) return 'P';
  return 'C';
}

// GSTIN shape: 2-digit state code, 10-char PAN (3 letters, entity type,
// initial, 4 digits, letter), entity number 1, Z, check character.
function identityForKey(key: string, name: string, seed: number): PartyIdentity {
  const city = cityForKey(key);
  const entityType = entityTypeForKey(key);
  const initial = (key.replace(/[^a-z]/g, '')[0] ?? 'a').toUpperCase();
  const h = digest(key, seed);
  const pan =
    'A' +
    LETTERS[h[0] % 26] +
    LETTERS[h[1] % 26] +
    entityType +
    initial +
    String(1000 + (((h[2] << 8) | h[3]) % 9000)) +
    LETTERS[h[4] % 26];
  const first14 = `${city.stateCode}${pan}1Z`;
  return {
    key,
    name,
    city: city.city,
    state: city.state,
    stateCode: city.stateCode,
    // The address never probes: it is the party's one address.
    address: addressFor(digest(key, 0), city),
    pan,
    gstin: `${first14}${gstinCheckDigit(first14)}`,
    entityType,
  };
}

// The GSTIN's 15th character is a Luhn mod-36 check digit over the first
// 14 (factor 1, 2, 1, 2… from the first character; each product's quotient
// and remainder by 36 are summed). Tally's party master and the GST portal
// both validate it, so a printed GSTIN must carry the right one.
// Exported for tests: 27AAPFU0939F1Z → V.
export function gstinCheckDigit(first14: string): string {
  let total = 0;
  for (let index = 0; index < first14.length; index += 1) {
    const value = ALNUM.indexOf(first14[index].toUpperCase());
    const product = value * (index % 2 === 0 ? 1 : 2);
    total += Math.floor(product / 36) + (product % 36);
  }
  return ALNUM[(36 - (total % 36)) % 36];
}

const GSTIN_SHAPE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

// Structurally valid mock GSTIN: shape plus the check character.
export function isValidGstin(gstin: string): boolean {
  return GSTIN_SHAPE.test(gstin) && gstin[14] === gstinCheckDigit(gstin.slice(0, 14));
}

function addressFor(h: Buffer, city: CityInfo): string {
  const number = 12 + (h[6] % 88);
  const street = STREETS[h[7] % STREETS.length];
  const pin = `${city.pinPrefix}${String(h[8] % 100).padStart(2, '0')}${h[9] % 10}`;
  return `#${number}, ${street}, ${city.city} ${pin}, ${city.state}`;
}

// Resolves a set of parties to identities with no two sharing a GSTIN or a
// PAN. Order is first-seen: a party keeps its seed-0 identity unless an
// EARLIER party already holds that GSTIN/PAN, in which case it probes seeds
// 1, 2, … So appending parties never changes an existing party's identity.
// Names with the same canonical key are one party (first name kept).
export function resolvePartyIdentities(names: readonly string[]): Map<string, PartyIdentity> {
  return resolveInto(new Map(), new Set(), new Set(), names);
}

function resolveInto(
  resolved: Map<string, PartyIdentity>,
  takenGstins: Set<string>,
  takenPans: Set<string>,
  names: readonly string[],
): Map<string, PartyIdentity> {
  for (const name of names) {
    const key = normalizePartyName(name);
    if (key.length === 0 || resolved.has(key)) continue;
    let seed = 0;
    let identity = identityForKey(key, name, seed);
    while (takenGstins.has(identity.gstin) || takenPans.has(identity.pan)) {
      seed += 1;
      identity = identityForKey(key, name, seed);
    }
    takenGstins.add(identity.gstin);
    takenPans.add(identity.pan);
    resolved.set(key, identity);
  }
  return resolved;
}

// The directory's own parties, resolved once in directory order.
const DIRECTORY_IDENTITIES = resolvePartyIdentities(Object.keys(KNOWN_PARTIES));

// THE party identity (2026-09-17). Pass the party's canonical ledger name
// from the answer key (the Dr customer / Cr vendor leg), never a name the
// model printed. Deterministic and stable across months; never collides
// with a directory party. `registry` (optional): the company's party names
// in first-seen order (e.g. company_ledger_registry by created_at) — then
// the party is also resolved against every earlier registry party, which
// makes GSTINs unique across the learner's whole company.
export function partyIdentityFor(canonicalName: string, registry: readonly string[] = []): PartyIdentity {
  const key = normalizePartyName(canonicalName);
  const known = DIRECTORY_IDENTITIES.get(key);
  if (known) return { ...known, name: canonicalName };
  const resolved = new Map(DIRECTORY_IDENTITIES);
  const takenGstins = new Set([...DIRECTORY_IDENTITIES.values()].map((identity) => identity.gstin));
  const takenPans = new Set([...DIRECTORY_IDENTITIES.values()].map((identity) => identity.pan));
  resolveInto(resolved, takenGstins, takenPans, [...registry, canonicalName]);
  const identity = resolved.get(key) ?? identityForKey(key, canonicalName, 0);
  return { ...identity, name: canonicalName };
}

// IGST vs CGST+SGST for a party, by its fixed state: a party outside
// Karnataka is inter-state. For the generation checks.
export function partyTaxClassFor(canonicalName: string): 'intra' | 'inter' {
  return partyIdentityFor(canonicalName).stateCode === HOME_STATE_CODE ? 'intra' : 'inter';
}

// Deprecated (2026-09-17): the second argument used to relocate the party to
// fit the invoice's GST head. It is ignored now — a party never moves.
export function partyDetailsFor(name: string, interState?: boolean | null): PartyDetails {
  void interState;
  return partyIdentityFor(name);
}

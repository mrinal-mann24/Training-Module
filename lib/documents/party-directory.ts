import { createHash } from 'node:crypto';

// Party directory (2026-09-09). Every vendor and customer that appears on a
// generated document gets a fixed address and GSTIN, decided by code from
// the party name, so the same party prints the same details on every
// invoice in every batch. Before this the model invented a "valid-looking"
// GSTIN per invoice, which gave AI Accountant a different GSTIN for the
// same vendor each month and left invoices with no address at all.
//
// The state must agree with the GST charged: an IGST invoice cannot come
// from a Karnataka address. So the lookup takes the invoice's regime and,
// where the directory (or the city in the name) would contradict it, falls
// back to a regime-consistent default rather than printing a contradiction.

export type PartyDetails = {
  name: string;
  city: string;
  state: string;
  stateCode: string;
  address: string;
  gstin: string;
};

type CityInfo = { city: string; state: string; stateCode: string; pinPrefix: string };

const HOME_STATE = 'Karnataka';

const CITIES: Record<string, CityInfo> = {
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
};

// The parties of the official pack and of every batch generated so far,
// keyed by normalised name. Home-state parties sit in Bengaluru unless the
// name says otherwise; out-of-state parties take the city in their name.
const KNOWN_PARTIES: Record<string, keyof typeof CITIES> = {
  ahmedabadelite: 'ahmedabad',
  ahmedabadimport: 'ahmedabad',
  balajiinteriors: 'bengaluru',
  bangalorecleaning: 'bengaluru',
  bangalorecleaners: 'bengaluru',
  bengaluruboutique: 'bengaluru',
  bengalurulocalstore: 'bengaluru',
  bharatmachinery: 'bengaluru',
  bharatmac: 'bengaluru',
  carameshco: 'bengaluru',
  chennaihomestore: 'chennai',
  chennaisuppliers: 'chennai',
  coimbatoreinteriors: 'coimbatore',
  coimbatorewholesale: 'coimbatore',
  deccantraders: 'bengaluru',
  deliverydirect: 'bengaluru',
  delhibazaar: 'delhi',
  gujaratretail: 'surat',
  herorentals: 'bengaluru',
  hyderabadinteriors: 'hyderabad',
  karnatakaemporium: 'bengaluru',
  keralahandicrafts: 'kochi',
  kochimodern: 'kochi',
  kolkataemporium: 'kolkata',
  kolkatatraders: 'kolkata',
  ludhianawoodworks: 'ludhiana',
  mehtaassociates: 'bengaluru',
  mumbaisuppliers: 'mumbai',
  mysoredecor: 'mysuru',
  nagpurretail: 'nagpur',
  rajasthanhomedecor: 'jaipur',
  sharmalegal: 'bengaluru',
  signageadvertising: 'bengaluru',
  softwarecloudllc: 'bengaluru',
  trichytextiles: 'trichy',
  vizagfurnishings: 'visakhapatnam',
  vizagvendors: 'visakhapatnam',
};

// A city named inside an unknown party name ("Pune Textiles" would need a
// new row here; these cover the names the generator has actually used).
const CITY_HINTS: [RegExp, keyof typeof CITIES][] = [
  [/bengaluru|bangalore|karnataka/i, 'bengaluru'],
  [/mysore|mysuru/i, 'mysuru'],
  [/mumbai|bombay|maharashtra/i, 'mumbai'],
  [/nagpur/i, 'nagpur'],
  [/chennai|madras|tamil/i, 'chennai'],
  [/coimbatore/i, 'coimbatore'],
  [/trichy|tiruchirappalli/i, 'trichy'],
  [/ahmedabad/i, 'ahmedabad'],
  [/gujarat|surat/i, 'surat'],
  [/kochi|cochin|kerala/i, 'kochi'],
  [/ludhiana|punjab/i, 'ludhiana'],
  [/kolkata|calcutta|bengal/i, 'kolkata'],
  [/delhi/i, 'delhi'],
  [/jaipur|rajasthan/i, 'jaipur'],
  [/vizag|visakhapatnam|andhra/i, 'visakhapatnam'],
  [/hyderabad|telangana/i, 'hyderabad'],
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

export function normalizePartyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\((individual|firm|company|debtor|creditor|customer|vendor|supplier)\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function digest(name: string): Buffer {
  return createHash('sha256').update(`party:${normalizePartyName(name)}`).digest();
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const ALNUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

// GSTIN shape: 2-digit state code, 10-char PAN (3 letters, entity type,
// initial, 4 digits, letter), entity number 1, Z, check character. Every
// part except the state code is fixed by the name alone, so a party keeps
// its PAN even when the regime moves it to another state.
function gstinFor(name: string, stateCode: string): string {
  const h = digest(name);
  const entityType = /associates|&\s*co\b|legal|llp/i.test(name) ? 'F' : /individual|rentals/i.test(name) ? 'P' : 'C';
  const initial = (name.replace(/[^A-Za-z]/g, '')[0] ?? 'A').toUpperCase();
  const pan =
    'A' +
    LETTERS[h[0] % 26] +
    LETTERS[h[1] % 26] +
    entityType +
    initial +
    String(1000 + (((h[2] << 8) | h[3]) % 9000)) +
    LETTERS[h[4] % 26];
  return `${stateCode}${pan}1Z${ALNUM[h[5] % 36]}`;
}

function addressFor(name: string, city: CityInfo): string {
  const h = digest(name);
  const number = 12 + (h[6] % 88);
  const street = STREETS[h[7] % STREETS.length];
  const pin = `${city.pinPrefix}${String(h[8] % 100).padStart(2, '0')}${h[9] % 10}`;
  return `#${number}, ${street}, ${city.city} ${pin}, ${city.state}`;
}

function cityFor(name: string): CityInfo | null {
  const known = KNOWN_PARTIES[normalizePartyName(name)];
  if (known) return CITIES[known];
  for (const [pattern, key] of CITY_HINTS) {
    if (pattern.test(name)) return CITIES[key];
  }
  return null;
}

// interState: true when the invoice charges IGST, false for CGST+SGST,
// null when it carries no GST (a TDS-only service bill, say) — then the
// directory's own state stands.
export function partyDetailsFor(name: string, interState: boolean | null): PartyDetails {
  let city = cityFor(name);
  const consistent = (info: CityInfo) => interState === null || (info.state !== HOME_STATE) === interState;
  if (!city || !consistent(city)) {
    city = interState ? CITIES.mumbai : CITIES.bengaluru;
  }
  return {
    name,
    city: city.city,
    state: city.state,
    stateCode: city.stateCode,
    address: addressFor(name, city),
    gstin: gstinFor(name, city.stateCode),
  };
}

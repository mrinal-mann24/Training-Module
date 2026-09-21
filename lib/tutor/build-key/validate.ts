import { isBankLedger } from '@/lib/db/queries/company';
import { extractTransactionDate } from '@/lib/documents/invoice-figures';
import { parseBillReferences } from '@/lib/tutor/bill-reference';
import { billTokensIn } from '@/lib/tutor/generation-checks';
import type { PartyMaster } from '@/lib/tutor/party-master';
import { inferTdsSectionFromLedger, type TdsSection } from '@/lib/tutor/tax-rules';

// What the model may NOT decide by writing free text (2026-09-22, the
// pre-launch review). The plan's strings reach the key and the learner:
// a party called "HDFC Ergo" is read as a bank by every consumer, a
// document number "INV-1 (Against Ref)" parses as a settlement, a ledger
// "Office Expenses" on an audit fee hides the TDS section. Each rule
// returns the violation sent back to the model, or null. Nothing is
// repaired silently.

const RUPEE_IN_TEXT = /(?:₹|\bRs\.?|\bINR)\s*[\d,]+/i;

// A party that any consumer would read as cash, a bank, a tax control
// ledger or an income/expense ledger (company.ts NON_PARTY_ACCOUNT_PATTERN,
// isBankLedger, documents-mode's cash memo test).
const RESERVED_PARTY_NAME =
  /^(sales|purchases?|sales returns?|purchase returns?|suspense|capital|depreciation|round\s*off|service income|petty cash)\b|^cash\b|\bbank\b|hdfc|(?<![a-z])(?:[csi]|ut)?gst(?![a-z])|(?<![a-z])tds(?![a-z])|\bpayable\b|\breceivable\b/i;

// One spelling of a party: legal forms, "M/s", "&"/"and" and punctuation
// do not make a second party.
export function loosePartyKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/\bm\/s\.?\s*/g, ' ')
    .replace(/\((?:p|pvt|private)\)/g, ' ')
    .replace(/\b(?:pvt|private|ltd|limited|llp|and|co|company)\b\.?/g, ' ')
    .replace(/[^a-z0-9]/g, '');
}

export function partyNameViolation(params: { name: string; newParty: boolean; master: PartyMaster; raisedInBatch: ReadonlySet<string> }): string | null {
  const name = params.name.trim();
  if (name.length < 3 || name.length > 60) return `party name "${name}" must be 3 to 60 characters`;
  if (RESERVED_PARTY_NAME.test(name)) return `"${name}" cannot be a party: the name reads as a cash, bank, tax or income/expense ledger`;
  if (params.master.resolve(name).known) return null;
  const key = loosePartyKey(name);
  if (params.raisedInBatch.has(key)) return null;
  const near = params.master.registry.find((existing) => {
    const other = loosePartyKey(existing);
    return other === key || (Math.min(other.length, key.length) >= 6 && (other.includes(key) || key.includes(other)));
  });
  if (near) return `"${name}" looks like the existing party "${near}": use that name exactly, or a clearly different party`;
  if (!params.newParty) return `"${name}" is not a party in the books: use a name from PARTIES exactly, or set new_party true for a genuinely new one`;
  return null;
}

// GST and TDS control ledgers are posted by the system only; "GST Late Fee
// and Interest" is an expense.
const TAX_CONTROL_LEDGER = /\b(?:[csi]|ut)gst\b|\btds\b|gst payable|\binput\b|\boutput\b|\brcm\b/i;
const TAX_EXPENSE_LEDGER = /late fee|interest|penalt/i;

export function ledgerViolation(params: { ledger: string; master: PartyMaster; bankAccount: string; role: 'expense' | 'asset' }): string | null {
  const ledger = params.ledger.trim();
  if (ledger.length < 3 || ledger.length > 60) return `ledger "${ledger}" must be 3 to 60 characters`;
  if (params.master.resolve(ledger).known) return `"${ledger}" is a party, not an ${params.role} ledger: pay a party through "party" with a settlement`;
  if (/^cash\b|petty cash/i.test(ledger) || isBankLedger(ledger) || ledger === params.bankAccount) return `"${ledger}" is a cash or bank ledger, not an ${params.role} ledger`;
  if (TAX_CONTROL_LEDGER.test(ledger) && !TAX_EXPENSE_LEDGER.test(ledger)) return `"${ledger}" is a GST or TDS ledger: the system posts those itself`;
  if (/^(sales|purchases?|sales returns?|purchase returns?)$/i.test(ledger)) return `"${ledger}" is a trading ledger: goods use nature "goods"`;
  if (RUPEE_IN_TEXT.test(ledger) || billTokensIn(ledger).length > 0) return `ledger "${ledger}" must be a plain ledger name`;
  return null;
}

const ASSET_LEDGER = /equipment|furniture|fixture|computer|laptop|printer|machinery|vehicle|plant/i;

export function assetLedgerViolation(ledger: string): string | null {
  return ASSET_LEDGER.test(ledger) ? null : `"${ledger}" is not a fixed asset ledger (equipment, furniture, computers, machinery, vehicles)`;
}

// A document number is exactly one plain bill-shaped token ("INV-3001",
// "MS/990"): the shape the text check finds in the learner's line and the
// reference parser reads back as the document's own number. Anything the
// parser would read as an advance, a settlement or two numbers is refused
// before it is stamped into a key (it used to crash the sales invoice
// builder after the last retry).
const DOCUMENT_NUMBER = /^[A-Z][A-Z0-9]*(?:[-/][A-Z0-9]+)+$/;

export function documentNumberViolation(number: string): string | null {
  const trimmed = number.trim();
  const parsed = parseBillReferences(trimmed);
  const plain = DOCUMENT_NUMBER.test(trimmed) && /\d/.test(trimmed) && trimmed.length <= 24;
  const own = parsed.length === 1 && parsed[0].kind === 'bill' && !parsed[0].newRef && parsed[0].ref === trimmed;
  if (plain && own && billTokensIn(trimmed).join() === trimmed) return null;
  return `document number "${number}" must be one plain number in capitals with a serial, like INV-3012 or MS/1001 (no spaces, brackets or commas, never starting with ADV)`;
}

export function lineDescriptionViolation(description: string): string | null {
  const text = description.trim();
  if (text.length < 3 || text.length > 80) return `line description "${text.slice(0, 40)}" must be 3 to 80 characters`;
  if (RUPEE_IN_TEXT.test(text) || /%/.test(text)) return `line description "${text}" must not state an amount or a rate: quantity and rate carry the figures`;
  if (billTokensIn(text).length > 0) return `line description "${text}" contains a code shaped like a bill number (${billTokensIn(text).join(', ')}); describe the item in words`;
  if (extractTransactionDate(text) !== null) return `line description "${text}" must not contain a date`;
  return null;
}

// Words that make a line a service whatever the purchase is called.
const SERVICE_WORDS = /\b(fees?|retainer(?:ship)?|consultanc\w*|consulting|audit|legal|rent|rental|commission|brokerage|labour charges?|amc|service charges?)\b/i;

// The TDS section must be readable from the ledger, because every consumer
// (the key builder, the threshold check, the scorer's expectations) reads
// it there. A ledger that hides what the lines plainly are ("Office
// Expenses" for a statutory audit fee) would build a key with no TDS.
export function purchaseNatureViolation(params: { nature: 'goods' | 'service' | 'expense' | 'asset'; ledger: string; descriptions: readonly string[] }): string | null {
  const text = params.descriptions.join('; ');
  if (params.nature === 'goods' || params.nature === 'asset') {
    const word = SERVICE_WORDS.exec(text)?.[0];
    return word ? `the lines describe a service ("${word}"), not ${params.nature}: use nature "service" or "expense" with its expense ledger` : null;
  }
  const fromLedger: TdsSection | null = inferTdsSectionFromLedger(params.ledger);
  const fromLines: TdsSection | null = inferTdsSectionFromLedger(text);
  if (fromLines && !fromLedger) {
    return `the lines describe a ${fromLines} supply but the ledger "${params.ledger}" does not say so: name the expense ledger for what was bought (e.g. "Legal & Professional Charges", "Audit Fees", "Rent", "Repairs & Maintenance", "Advertisement & Marketing", "Freight & Delivery Charges", "Commission")`;
  }
  if (fromLines && fromLedger && fromLines !== fromLedger) {
    return `the lines describe a ${fromLines} supply but the ledger "${params.ledger}" is a ${fromLedger} ledger: make the lines and the ledger agree`;
  }
  return null;
}

// The scenario is the one free paragraph the learner may read (outside
// documents mode). It carries no figure, rate, bill number or dash, so it
// can neither contradict the built entries nor hint at a treatment.
export function scenarioViolation(scenario: string, year: number): string | null {
  const text = scenario.trim();
  if (text.length < 20 || text.length > 600) return 'the scenario must be two or three sentences (20 to 600 characters)';
  if (RUPEE_IN_TEXT.test(text) || /%/.test(text)) return 'the scenario must not state any amount or rate';
  if (/[—–]/.test(text)) return 'the scenario must not use a dash character';
  if (billTokensIn(text).length > 0) return `the scenario must not name a bill or invoice number (${billTokensIn(text).join(', ')})`;
  const digits = (text.match(/\d{3,}/g) ?? []).filter((run) => run !== String(year));
  if (digits.length > 0) return `the scenario must not contain figures (${digits.join(', ')})`;
  if (/\b(tds|cgst|sgst|igst|reverse charge|rcm)\b/i.test(text)) return 'the scenario must not name a tax treatment (TDS, CGST, SGST, IGST, reverse charge): that is what the learner works out';
  return null;
}

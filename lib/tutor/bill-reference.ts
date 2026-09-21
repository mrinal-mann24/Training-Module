// The one place a bill reference is read or written (2026-09-22, rebuild
// Stage 0). An answer key names every allocation of a party leg in one
// string, and three modules used to parse and normalize it each their own
// way: replay (company.ts), generation checks and the scorer. INV-18 and
// INV-018 were the same number to one and different to another, so a bill
// could be settled in the scorer's eyes and still open in the replay that
// feeds the next batch. Everything now goes through this module, and a
// reference string is only ever PRODUCED by formatBillReference.
//
//   bill        a document's own number (unannotated or "New Ref")
//   against     settles an existing bill ("Against", "(Against Ref ...)")
//   advance     an advance reference ("(Advance)", ADV-...)
//   on_account  "On Account"

export type BillReferenceKind = 'bill' | 'against' | 'advance' | 'on_account';
// partPayment is set when the annotation says so ("(Against Ref, part
// payment)"), so a recovered allocation formats back to the same string.
export type ParsedBillReference = { ref: string; kind: BillReferenceKind; partPayment?: boolean };

// A typed allocation, the shape the key builder works in. `amount` is what
// the allocation carries; it is 0 when recovered from a string.
export type AllocationKind = 'new' | 'against' | 'advance' | 'on_account';
export type Allocation = { ref: string; kind: AllocationKind; amount: number; partPayment?: boolean };

// "Against INV-003", "Against Ref INV-005", "Agst Ref X", "New Ref INV-062",
// "Advance ADV-01": allocation words written in front of the number.
const REFERENCE_PREFIX = /^(?:(against|agst)(?:\s+ref(?:erence)?)?|new\s+ref(?:erence)?|(advance)(?:\s+ref(?:erence)?)?)\s*[:-]?\s+/i;

// Commas inside an annotation ("(Against Ref, part payment)") do not
// separate references.
export function splitOutsideParentheses(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '(') depth += 1;
    if (character === ')') depth = Math.max(0, depth - 1);
    if ((character === ',' || character === ';') && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  parts.push(current);
  return parts;
}

export function parseBillReferences(reference: string | null | undefined): ParsedBillReference[] {
  if (!reference) return [];
  const parsed: ParsedBillReference[] = [];
  for (const part of splitOutsideParentheses(reference)) {
    const annotation = [...part.matchAll(/\(([^)]*)\)/g)].map((match) => match[1]).join(' ');
    let bare = part.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
    let kind: BillReferenceKind = 'bill';
    const prefix = REFERENCE_PREFIX.exec(bare);
    if (prefix) {
      bare = bare.slice(prefix[0].length).trim();
      if (prefix[1]) kind = 'against';
      else if (prefix[2]) kind = 'advance';
    }
    if (bare.length === 0) continue;
    if (/^on\s+account$/i.test(bare)) kind = 'on_account';
    else if (/\b(against|agst)\b/i.test(annotation)) kind = 'against';
    else if (/\badvance\b/i.test(annotation)) kind = 'advance';
    else if (/\bon\s+account\b/i.test(annotation)) kind = 'on_account';
    // The advance numbering the generator uses (ADV-C01, ADV-S01) is an
    // advance even when the "(Advance)" tag is left off, so "ADV-C01,
    // INV-3001 (New Ref)" is still numbered INV-3001 (review, 2026-09-15).
    if (kind === 'bill' && /^ADV[-/]/i.test(bare)) kind = 'advance';
    parsed.push(/\bpart\b/i.test(annotation) ? { ref: bare, kind, partPayment: true } : { ref: bare, kind });
  }
  return parsed;
}

// The number a sale or purchase document carries: its own reference, never
// the advance or bill it adjusts. Null when the voucher names none.
export function documentNumberOf(reference: string | null | undefined): string | null {
  return parseBillReferences(reference).find((parsed) => parsed.kind === 'bill')?.ref ?? null;
}

export function splitBillReferences(ref: string): string[] {
  return parseBillReferences(ref).map((parsed) => parsed.ref);
}

// ------------------------------------------------------------- normalizers
//
// Three normalizers still exist, moved here unchanged in Stage 0 so every
// consumer imports them from one place. canonicalRef is the target; the
// other two are retired once the parity test over the stored keys proves
// nothing the interns' books rely on tells them apart.

// Replay's normalizer (bill ids in openBillsFromKeys): punctuation and case
// dropped, leading zeros and letter/number boundaries kept.
export function normalizeBillReference(ref: string): string {
  const bare = ref.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  const prefix = REFERENCE_PREFIX.exec(bare);
  return (prefix ? bare.slice(prefix[0].length) : bare).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Generation's normalizer (bill-number uniqueness): as above, leading zeros
// dropped ("INV-18" and "INV-018" are one number, 2026-09-17).
export function normalizeDocumentNumber(ref: string): string {
  return normalizeBillReference(ref).replace(/(^|[^0-9])0+(?=[0-9])/g, '$1');
}

// A learner's allocation name or a key's reference, reduced to what the
// number IS: letter and number groups upper-cased and joined with "-", leading
// zeros dropped, allocation words and Tally's own placeholders removed.
// "INV-005", "Inv 5", "Ref: INV-05" are all INV-5. Tally's automatic bill
// names are "New Ref"/"Agst Ref" + whatever type the learner chose (so an
// advance may be New Ref or Advance), and an "On Account" allocation is not
// a reference.
const PLACEHOLDER_REFERENCE = /^(NEWREF|NEWREFERENCE|AGSTREF|AGAINSTREF|ADVANCE|ONACCOUNT|REF|NA|NIL)$/;

export function canonicalBillReference(reference: string): string | null {
  const bare = reference
    .replace(/\([^)]*\)/g, ' ')
    .trim()
    // "Ref INV-012", "Ref: 45", "Reference No. 7" (never "REF-001" itself)
    .replace(/^ref(?:erence)?(?:[.:]|\s)+/i, '')
    // "INV-025 dt 04-May", "INV-7 dated 4/5": a date after the number
    .replace(/(?<=\S)\s+(?:dt\.?|dated)\s*[:-]?\s*\d.*$/i, '')
    .replace(/(?<![a-z])(?:no|number|num)\b\.?/gi, ' ')
    .replace(/#/g, ' ');
  const groups = bare.toUpperCase().match(/[A-Z]+|\d+/g);
  if (!groups) return null;
  const canonical = groups.map((group) => (/^\d+$/.test(group) ? group.replace(/^0+(?=\d)/, '') : group)).join('-');
  return PLACEHOLDER_REFERENCE.test(canonical.replace(/-/g, '')) ? null : canonical;
}

// The canonical identity of a reference: what the rebuild compares by.
export const canonicalRef = canonicalBillReference;

// The tokens a key's bill_reference (or a learner's allocation name) names.
export function billReferenceTokens(reference: string | null | undefined): Set<string> {
  const tokens = new Set<string>();
  for (const parsed of parseBillReferences(reference)) {
    if (parsed.kind === 'on_account') continue;
    const canonical = canonicalBillReference(parsed.ref);
    if (canonical) tokens.add(canonical);
  }
  return tokens;
}

// A reference shaped like a date ("INV-12-06-2024", "MS/12/06/24",
// "KE/15-Jun-2024"). Educational redating and the documents read dates out
// of text, so a date-shaped number would be rewritten in one place and not
// the other; such numbers are rejected at generation.
const MONTH_WORD = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
const DATE_SHAPE = new RegExp(
  `\\d{1,2}[-/.\\s](?:\\d{1,2}|${MONTH_WORD})[-/.\\s]\\d{2,4}|\\d{4}[-/.]\\d{1,2}[-/.]\\d{1,2}|${MONTH_WORD}[-/.\\s]\\d{1,2}[-/.,\\s]+\\d{4}`,
  'i',
);
export function looksLikeDate(ref: string): boolean {
  return DATE_SHAPE.test(ref);
}

// ------------------------------------------------------------- formatting

// The only producer of a bill_reference string. Emits exactly the shapes
// parseBillReferences reads back: a document's own number bare, an advance
// as "ADV-C01 (Advance)", a settlement as "INV-2231 (Against Ref)" or
// "(Against Ref, part payment)", "On Account" as itself; several joined by
// ", " with advances first and the document's own number last, which is
// the order documentNumberOf and the advance replay expect.
export function formatBillReference(allocations: readonly Allocation[]): string | null {
  const ordered = [
    ...allocations.filter((allocation) => allocation.kind === 'advance'),
    ...allocations.filter((allocation) => allocation.kind === 'against'),
    ...allocations.filter((allocation) => allocation.kind === 'on_account'),
    ...allocations.filter((allocation) => allocation.kind === 'new'),
  ];
  const parts = ordered.map((allocation) => {
    switch (allocation.kind) {
      case 'new':
        return allocation.ref;
      case 'advance':
        return `${allocation.ref} (Advance)`;
      case 'against':
        return allocation.partPayment ? `${allocation.ref} (Against Ref, part payment)` : `${allocation.ref} (Against Ref)`;
      case 'on_account':
        return 'On Account';
      default: {
        const never: never = allocation.kind;
        throw new Error(`Unknown allocation kind ${String(never)}`);
      }
    }
  });
  return parts.length === 0 ? null : parts.join(', ');
}

// The typed allocations a stored reference names; amounts are unknown (0).
export function allocationsFromReference(reference: string | null | undefined): Allocation[] {
  return parseBillReferences(reference).map((parsed) => ({
    ref: parsed.kind === 'on_account' ? 'On Account' : parsed.ref,
    kind: parsed.kind === 'bill' ? 'new' : parsed.kind,
    amount: 0,
    ...(parsed.partPayment ? { partPayment: true } : {}),
  }));
}

import { RULEBOOK_TEXT } from '@/lib/llm/grounding/rulebook';
import { MODULE_DOCS } from '@/lib/llm/grounding/module-docs';
import { VIDEO_MODULES } from '@/lib/llm/grounding/video-modules';
import type { ConceptTag } from '@/lib/schemas/exercise';
import type { LicenseMode } from '@/lib/schemas/onboarding';

// Shared building blocks for grounded learner-facing prose (2026-09-17,
// code-standards rule 35). Coaching already had its own; hints, Q&A and
// qualitative scoring were schema-only, so a model could state a wrong rate,
// invent a video title or hand over figures at a step that promised none.
// Everything here is pure except withTimeout, and every validator built on
// it returns violations phrased so they can be fed straight back to the
// model.

export const EM_DASH = '\u2014';
export const EN_DASH = '\u2013';

// ui-context.md bans the em dash in learner-facing text; the en dash is its
// look-alike and was the probe that slipped through coaching (2026-09-17).
export function dashViolation(text: string): string | null {
  if (text.includes(EM_DASH)) return 'an em dash';
  if (text.includes(EN_DASH)) return 'an en dash';
  return null;
}

// Grounding text (the rulebook, the module docs) is written with em dashes.
// Facts built from it are dash-free, so a model copying a fact verbatim is
// never rejected for the fact's own punctuation.
export function replaceDashes(text: string): string {
  return text.replace(/\s*[\u2014\u2013]\s*/g, ', ');
}

// Text the learner typed (ledger names in their Tally export, a free-text
// answer) reaches prompts and fallbacks. It is data: control characters and
// bracket/quote characters that could fake a prompt boundary are removed,
// dashes are flattened and the length is capped.
export function sanitizeLearnerText(text: string, maxLength = 60): string {
  const cleaned = text
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/[\u2014\u2013]/g, '-')
    .replace(/[<>{}[\]`"\\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength).trim() : cleaned;
}

// Figures, compared after removing grouping commas and leading zeros so
// "Rs 15,000", "15000" and "1,50,000" agree with their fact.
const NUMBER_TOKEN = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): string[] {
  return (text.match(NUMBER_TOKEN) ?? [])
    .map((token) => token.replace(/,/g, ''))
    .filter((token) => token.length > 0 && !Number.isNaN(Number(token)))
    .map((token) => String(Number(token)));
}

// Bill/voucher references in either case, with at least one digit:
// INV-012, inv-099, OS/24/450, CA26-101. "bill-by-bill" and "u/s" have no
// digit and are ordinary words.
const REFERENCE_TOKEN = /\b[A-Za-z][A-Za-z0-9]*(?:[-/][A-Za-z0-9]+)+\b/g;

export function referencesIn(text: string): string[] {
  return (text.match(REFERENCE_TOKEN) ?? []).filter((token) => /\d/.test(token));
}

export const GST_HEAD_PATTERN = /\b(?:IGST|CGST|SGST|UTGST)\b/gi;
export const TDS_SECTION_PATTERN = /\b19[2-6][A-Z]{1,2}\b/g;

export function gstHeadsIn(text: string): string[] {
  return (text.match(GST_HEAD_PATTERN) ?? []).map((head) => head.toUpperCase());
}

export function tdsSectionsIn(text: string): string[] {
  return text.match(TDS_SECTION_PATTERN) ?? [];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Whole-phrase match that works for names ending or starting in "&", "." or
// a digit ("Advertisement & Marketing", "Output IGST @18%").
export function containsPhrase(text: string, phrase: string, caseSensitive = false): boolean {
  if (phrase.trim().length === 0) return false;
  return new RegExp(`(^|[^A-Za-z0-9])${escapeRegExp(phrase)}(?=$|[^A-Za-z0-9])`, caseSensitive ? '' : 'i').test(text);
}

// Positions of a phrase, for attribution checks.
export function phrasePositions(text: string, phrase: string): { start: number; end: number }[] {
  const pattern = new RegExp(`(^|[^A-Za-z0-9])(${escapeRegExp(phrase)})(?=$|[^A-Za-z0-9])`, 'gi');
  const positions: { start: number; end: number }[] = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index + match[1].length;
    positions.push({ start, end: start + match[2].length });
    if (pattern.lastIndex === match.index) pattern.lastIndex++;
  }
  return positions;
}

// ---------------------------------------------------------------------------
// Rulebook, module-doc and video-registry sources with ids a model can cite.
// ---------------------------------------------------------------------------

export type GroundingSource = {
  id: string;
  kind: 'rulebook' | 'module-doc' | 'video' | 'rule';
  title: string;
  text: string;
};

const SECTION_HEADER = /^(\d{1,2})([A-C])?\. (.+)$/;
const SUBSECTION_HEADER = /^(\d{1,2})\.(\d{1,2}) (.+)$/;

// The rulebook is one extracted string; its headers ("12. TDS treatment",
// "12.4 TDS threshold check", "9B. Advance for services") are the only lines
// of that shape, and section numbers only ever stay or step up by one, which
// keeps a stray numbered list line from being read as a header.
function parseRulebook(): GroundingSource[] {
  const sources: { id: string; title: string; lines: string[] }[] = [];
  let lastSection = 0;
  for (const rawLine of RULEBOOK_TEXT.split(/\r?\n/)) {
    const line = rawLine.trim();
    const sub = SUBSECTION_HEADER.exec(line);
    if (sub && Number(sub[1]) === lastSection) {
      sources.push({ id: `R${sub[1]}.${sub[2]}`, title: replaceDashes(sub[3]), lines: [replaceDashes(line)] });
      continue;
    }
    const section = SECTION_HEADER.exec(line);
    if (section && (Number(section[1]) === lastSection || Number(section[1]) === lastSection + 1)) {
      lastSection = Number(section[1]);
      sources.push({ id: `R${section[1]}${section[2] ?? ''}`, title: replaceDashes(section[3]), lines: [replaceDashes(line)] });
      continue;
    }
    const current = sources[sources.length - 1];
    if (current && line.length > 0) {
      current.lines.push(replaceDashes(line));
    }
  }
  return sources.map((source) => ({ id: source.id, kind: 'rulebook', title: source.title, text: source.lines.join('\n') }));
}

export const RULEBOOK_SOURCES: readonly GroundingSource[] = parseRulebook();

// "R6" expands to R6 and every R6.n; "R9" to R9, R9A, R9B and R9C.
export function rulebookSourcesFor(ids: readonly string[]): GroundingSource[] {
  const selected: GroundingSource[] = [];
  for (const id of ids) {
    for (const source of RULEBOOK_SOURCES) {
      const matches =
        source.id === id || source.id.startsWith(`${id}.`) || (/^R\d+$/.test(id) && new RegExp(`^${id}[A-C]$`).test(source.id));
      if (matches && !selected.includes(source)) {
        selected.push(source);
      }
    }
  }
  return selected;
}

// Which rulebook sections govern each scored concept.
export const RULEBOOK_SECTIONS_BY_CONCEPT: Record<ConceptTag, string[]> = {
  sales_voucher_basics: ['R5', 'R2'],
  purchase_voucher_basics: ['R5', 'R11'],
  payment_voucher_basics: ['R6', 'R5'],
  receipt_voucher_basics: ['R7', 'R5'],
  contra_voucher_basics: ['R5'],
  journal_voucher_basics: ['R5', 'R15.2'],
  gst_classification: ['R13', 'R2'],
  tds_classification: ['R12.1', 'R12.4'],
  bill_by_bill_referencing: ['R4'],
  narration_discipline: ['R3'],
  trial_balance_tie_out: ['R14', 'R1'],
  customer_advance: ['R9A', 'R9B', 'R9C'],
  supplier_advance: ['R10'],
  on_account_reference: ['R4', 'R8.3'],
  multi_bill_settlement: ['R6.4', 'R7.4'],
  tds_on_receipt: ['R7.2', 'R12.6'],
  gst_set_off: ['R13', 'R9C'],
  gst_payment: ['R9C', 'R13'],
  rcm_and_late_fee: ['R13'],
  fixed_assets_depreciation: ['R1'],
};

export function rulebookSourcesForConcept(concept: ConceptTag): GroundingSource[] {
  return rulebookSourcesFor(RULEBOOK_SECTIONS_BY_CONCEPT[concept] ?? []);
}

// "Rulebook section 12.4, "TDS threshold check, MANDATORY before deducting""
export function rulebookPointer(source: GroundingSource): string {
  return `Rulebook section ${source.id.slice(1)}, "${source.title}"`;
}

export const MODULE_DOC_SOURCES: readonly GroundingSource[] = Object.entries(MODULE_DOCS).map(([name, text], index) => ({
  id: `D${index + 1}`,
  kind: 'module-doc',
  title: name,
  text: replaceDashes(text),
}));

export const VIDEO_SOURCES: readonly GroundingSource[] = VIDEO_MODULES.map((module, index) => ({
  id: `V${index + 1}`,
  kind: 'video',
  title: module.title,
  text: `Video module "${module.title}"`,
}));

export const VIDEO_TITLES: ReadonlySet<string> = new Set(VIDEO_MODULES.map((module) => module.title));

// ---------------------------------------------------------------------------
// Tally Educational Mode posting days.
// ---------------------------------------------------------------------------

export const EDUCATIONAL_DATE_RULE =
  'In Tally Educational Mode a voucher can only be dated the 1st, 2nd or 31st of a month, and in a month without a 31st only the 1st or 2nd. Never suggest any other posting day.';

// The same rule in the learner's register, for code-composed text.
export const EDUCATIONAL_DATE_TIP =
  'In Educational Mode, date every voucher the 1st, 2nd or 31st of the month, and only the 1st or 2nd when the month has no 31st.';

export function isEducational(licenseMode: LicenseMode | null | undefined): boolean {
  return licenseMode === 'educational';
}

const ALLOWED_EDUCATIONAL_DAYS: ReadonlySet<number> = new Set([1, 2, 31]);
const MONTHS =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WORD_ORDINALS: Record<string, number> = {
  first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10,
  eleventh: 11, twelfth: 12, thirteenth: 13, fourteenth: 14, fifteenth: 15, sixteenth: 16, seventeenth: 17,
  eighteenth: 18, nineteenth: 19, twentieth: 20, 'twenty-first': 21, 'twenty-second': 22, 'twenty-third': 23,
  'twenty-fourth': 24, 'twenty-fifth': 25, 'twenty-sixth': 26, 'twenty-seventh': 27, 'twenty-eighth': 28,
  'twenty-ninth': 29, thirtieth: 30, 'thirty-first': 31,
};

// A statutory deadline ("deposit TDS by the 7th of next month") is not a
// posting day, so an ordinal right after by/before/due/until is left alone.
const DEADLINE_LEAD = /\b(?:by|before|due(?: on| by)?|until|till|latest|cut-?off:?|deadline:?)\s+(?:the\s+)?$/i;

// Every day-of-month mention outside 1, 2 and 31. Returns the offending
// snippets; empty means the text suggests no day an Educational Mode learner
// cannot post on.
export function educationalDayViolations(text: string): string[] {
  const found = new Map<number, string>();
  const note = (index: number, day: number, snippet: string) => {
    if (!ALLOWED_EDUCATIONAL_DAYS.has(day) && !found.has(index)) {
      found.set(index, snippet.trim());
    }
  };
  const scan = (pattern: RegExp, dayOf: (match: RegExpExecArray) => number | null, skipDeadlines: boolean) => {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(text)) !== null) {
      const day = dayOf(match);
      if (day !== null && !(skipDeadlines && DEADLINE_LEAD.test(text.slice(Math.max(0, match.index - 20), match.index)))) {
        note(match.index, day, match[0]);
      }
    }
  };

  scan(new RegExp(String.raw`\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/.]*(?:of\s+)?${MONTHS}\b`, 'gi'), (m) => Number(m[1]), true);
  scan(new RegExp(String.raw`\b${MONTHS}\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b`, 'gi'), (m) => Number(m[1]), true);
  scan(/\b(\d{1,2})(?:st|nd|rd|th)\b/gi, (m) => Number(m[1]), true);
  scan(/\b(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})\b/g, (m) => Number(m[1]), false);
  scan(/\bday\s+(\d{1,2})\b/gi, (m) => Number(m[1]), false);
  scan(
    new RegExp(String.raw`\b(${Object.keys(WORD_ORDINALS).join('|')})\s+(?:day\s+)?of\s+(?:the\s+)?(?:month|${MONTHS})\b`, 'gi'),
    (m) => WORD_ORDINALS[m[1].toLowerCase()] ?? null,
    true,
  );
  return [...found.values()];
}

// ---------------------------------------------------------------------------
// Bounded LLM attempts for learner-blocking server actions.
// ---------------------------------------------------------------------------

export class LlmTimeoutError extends Error {
  constructor(ms: number) {
    super(`The model did not answer within ${ms} ms.`);
    this.name = 'LlmTimeoutError';
  }
}

// A learner clicking for help must not wait out the client's generous
// per-request timeout and its transient retries (minutes). The race bounds
// the WAIT; the abandoned request settles in the background.
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new LlmTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Malformed JSON and a timeout are failed attempts that end in the code
// fallback. Anything else (auth, 4xx) still throws to the caller.
export function isFailedAttemptError(error: unknown): error is Error {
  return error instanceof SyntaxError || error instanceof LlmTimeoutError;
}

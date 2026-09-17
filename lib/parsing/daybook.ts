import { XMLParser } from 'fast-xml-parser';
import { ParsedDayBookSchema, type LedgerEntry, type ParsedDayBook } from '@/lib/schemas/voucher';

export class DayBookParseError extends Error {}

// Tally's Detailed Day Book export is UTF-16LE with a BOM, not UTF-8 — decoding
// as UTF-8 silently mangles it into garbage rather than throwing, so this must
// be detected explicitly rather than assumed.
function decodeTallyXml(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le', 2);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new DayBookParseError('Unsupported file encoding (UTF-16 big-endian).');
  }
  return buffer.toString('utf8');
}

const parserOptions = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Every tag value stays the text Tally wrote (2026-09-17). With value
  // parsing on, a bill reference "001" arrived as the number 1 and a ledger
  // named "0123" as 123, so the scorer compared mangled names. Amounts are
  // converted explicitly in parseTallyAmount instead.
  parseTagValue: false,
  isArray: (tagName: string) =>
    tagName === 'TALLYMESSAGE' ||
    tagName === 'VOUCHER' ||
    tagName === 'LEDGERENTRIES.LIST' ||
    tagName === 'ALLLEDGERENTRIES.LIST' ||
    tagName === 'ALLINVENTORYENTRIES.LIST' ||
    tagName === 'INVENTORYENTRIES.LIST' ||
    tagName === 'ACCOUNTINGALLOCATIONS.LIST' ||
    tagName === 'BILLALLOCATIONS.LIST',
};

// ASSUMPTION: the confirmed real DayBook.xml sample has REPORTNAME "All Masters",
// not a Day Book report name, so this parser keys off structural content
// (VOUCHER + LEDGERENTRIES.LIST elements) rather than a REPORTNAME string match,
// per the spec's explicit instruction. Treat as provisional until verified
// against a real learner-path Day Book export.
export function parseDayBookXml(buffer: Buffer): ParsedDayBook {
  let xmlText: string;
  try {
    xmlText = decodeTallyXml(buffer);
  } catch (error) {
    if (error instanceof DayBookParseError) {
      throw error;
    }
    throw new DayBookParseError('The Day Book file could not be read.');
  }

  let root: unknown;
  try {
    root = new XMLParser(parserOptions).parse(xmlText);
  } catch {
    throw new DayBookParseError('The Day Book file could not be read — it is not valid XML.');
  }

  const messages = extractTallyMessages(root);
  if (messages.length === 0) {
    throw new DayBookParseError(
      'The Day Book file does not contain any recognizable voucher data.',
    );
  }

  // Optional (memorandum-style, ISOPTIONAL Yes) and cancelled (ISCANCELLED
  // Yes) vouchers are not postings: Tally keeps them out of the books, so
  // they are dropped here, before scoring AND before the submission gate
  // counts vouchers, keeping both on the same set (2026-09-17).
  const vouchers = messages
    .map((message) => message['VOUCHER'])
    .filter((voucher): voucher is Record<string, unknown>[] => Array.isArray(voucher))
    .flat()
    .filter((voucher) => !isYes(voucher['ISOPTIONAL']) && !isYes(voucher['ISCANCELLED']))
    .map(normalizeVoucher);

  const result = { vouchers };
  const parsed = ParsedDayBookSchema.safeParse(result);
  if (!parsed.success) {
    throw new DayBookParseError('The Day Book file could not be read — unexpected structure.');
  }

  return parsed.data;
}

function isYes(value: unknown): boolean {
  return typeof value === 'string' && value.trim().toLowerCase() === 'yes';
}

// Tally writes amounts as plain signed decimals ("-5000.00"). A value that
// is not a number used to surface as the opaque "unexpected structure"
// (NaN failed the schema); it now names the ledger (2026-09-17). Thousands
// separators and spaces are tolerated.
function parseTallyAmount(raw: unknown, context: string): number {
  if (raw === undefined || raw === null) return 0;
  const text = String(raw).replace(/[,\s]/g, '');
  if (text.length === 0) return 0;
  const amount = Number(text);
  if (!Number.isFinite(amount)) {
    throw new DayBookParseError(
      `The Day Book file could not be read — the amount "${String(raw).trim()}" on ${context} is not a number. Re-export the Day Book from Tally and upload it again.`,
    );
  }
  return amount;
}

function textOf(value: unknown): string {
  return value === undefined || value === null ? '' : String(value);
}

function extractTallyMessages(root: unknown): Record<string, unknown>[] {
  if (typeof root !== 'object' || root === null) {
    return [];
  }
  const envelope = (root as Record<string, unknown>)['ENVELOPE'];
  if (typeof envelope !== 'object' || envelope === null) {
    return [];
  }
  const body = (envelope as Record<string, unknown>)['BODY'];
  if (typeof body !== 'object' || body === null) {
    return [];
  }
  const importData = (body as Record<string, unknown>)['IMPORTDATA'];
  if (typeof importData !== 'object' || importData === null) {
    return [];
  }
  const requestData = (importData as Record<string, unknown>)['REQUESTDATA'];
  if (typeof requestData !== 'object' || requestData === null) {
    return [];
  }
  const tallyMessage = (requestData as Record<string, unknown>)['TALLYMESSAGE'];
  if (!Array.isArray(tallyMessage)) {
    return [];
  }
  return tallyMessage as Record<string, unknown>[];
}

function normalizeVoucher(voucher: Record<string, unknown>): {
  voucherType: string;
  date: string;
  narration: string;
  ledgerEntries: LedgerEntry[];
} {
  const voucherType = textOf(voucher['VOUCHERTYPENAME'] ?? voucher['@_VCHTYPE']);
  const date = textOf(voucher['DATE']);
  const narration = textOf(voucher['NARRATION']);

  // Tally exports invoice-mode vouchers (Sales/Purchase in Invoice view)
  // with legs under LEDGERENTRIES.LIST, but accounting-mode vouchers
  // (Payment, Receipt, Journal, Contra, and voucher-mode Sales/Purchase)
  // under ALLLEDGERENTRIES.LIST. Reading only the former silently dropped
  // every leg of every accounting-mode voucher — discovered calibrating
  // against the pilot trainee's real export (2026-08-20), where all ~50 bank
  // vouchers parsed half-empty. A voucher only ever uses one of the two.
  const rawInvoiceEntries = voucher['LEDGERENTRIES.LIST'];
  const rawAccountingEntries = voucher['ALLLEDGERENTRIES.LIST'];
  // Item-invoice vouchers (stock items in use) carry the Sales/Purchases
  // ledger leg INSIDE each inventory line, under ALLINVENTORYENTRIES.LIST →
  // ACCOUNTINGALLOCATIONS.LIST, not at voucher level. Reading only the
  // voucher-level lists dropped the Purchases leg of every item-mode
  // purchase (Garima's Level 3, 2026-09-03: 4 false ACCOUNT_WRONGs) — and
  // learners are told stock items are optional, so both modes must parse.
  const rawInventoryEntries = [
    ...(Array.isArray(voucher['ALLINVENTORYENTRIES.LIST']) ? (voucher['ALLINVENTORYENTRIES.LIST'] as unknown[]) : []),
    ...(Array.isArray(voucher['INVENTORYENTRIES.LIST']) ? (voucher['INVENTORYENTRIES.LIST'] as unknown[]) : []),
  ];
  const inventoryAllocations = rawInventoryEntries.flatMap((item) => {
    const allocations = (item as Record<string, unknown>)['ACCOUNTINGALLOCATIONS.LIST'];
    return Array.isArray(allocations) ? allocations : [];
  });
  const entries = [
    ...(Array.isArray(rawInvoiceEntries) ? rawInvoiceEntries : []),
    ...(Array.isArray(rawAccountingEntries) ? rawAccountingEntries : []),
    ...inventoryAllocations,
  ];

  const ledgerEntries = entries.map((entry) => normalizeLedgerEntry(entry as Record<string, unknown>));

  return { voucherType, date, narration, ledgerEntries };
}

// Sign convention confirmed against the real DayBook.xml sample:
// ISDEEMEDPOSITIVE=Yes + negative AMOUNT => Debit
// ISDEEMEDPOSITIVE=No  + positive AMOUNT => Credit
//
// The AMOUNT sign is the effective side; ISDEEMEDPOSITIVE is only the side
// the leg was keyed on. Tally lets a learner key a leg on the Dr side with a
// negative figure (a "negative debit"), which it then posts as a credit —
// Garima's March 2025 TDS legs (2026-09-09) arrived as
// ISDEEMEDPOSITIVE=Yes + AMOUNT=+5000 inside otherwise balanced purchase
// vouchers, and reading the flag alone scored them DR_CR_REVERSED. So the
// sign decides whenever the amount is non-zero; the flag is the fallback
// for a zero leg.
function normalizeLedgerEntry(entry: Record<string, unknown>): LedgerEntry {
  const ledgerName = textOf(entry['LEDGERNAME']);
  const amount = parseTallyAmount(entry['AMOUNT'], `ledger "${ledgerName}"`);
  const isDeemedPositive = String(entry['ISDEEMEDPOSITIVE'] ?? '') === 'Yes';
  const drOrCr = amount < 0 ? 'Dr' : amount > 0 ? 'Cr' : isDeemedPositive ? 'Dr' : 'Cr';

  const rawBillAllocations = entry['BILLALLOCATIONS.LIST'];
  const billAllocations = extractBillAllocations(rawBillAllocations);

  return {
    ledgerName,
    amount: Math.abs(amount),
    drOrCr,
    billAllocations,
  };
}

// Real Tally exports repeat <BILLALLOCATIONS.LIST> once PER allocation, with
// NAME/BILLTYPE/AMOUNT as direct children — there is no inner wrapper
// element. (An earlier version expected a nested BILLALLOCATIONS child,
// which only ever existed in this repo's hand-built fixtures — every real
// export's references parsed as empty until the 2026-08-20 pilot
// calibration exposed it.) An empty <BILLALLOCATIONS.LIST> </...> parses as
// a whitespace string and is skipped.
// BILLTYPE is read into billType when present (2026-09-17, additive).
type ParsedAllocation = { name: string; amount: number; billType?: string };

function allocationOf(record: Record<string, unknown>): ParsedAllocation {
  const allocation: ParsedAllocation = {
    name: textOf(record['NAME']),
    amount: parseTallyAmount(record['AMOUNT'], `bill "${textOf(record['NAME'])}"`),
  };
  const billType = textOf(record['BILLTYPE']).trim();
  if (billType.length > 0) allocation.billType = billType;
  return allocation;
}

function extractBillAllocations(raw: unknown): ParsedAllocation[] {
  const lists = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const allocations: ParsedAllocation[] = [];

  for (const item of lists) {
    if (typeof item !== 'object' || item === null) {
      continue; // empty list element parsed as a string
    }
    const record = item as Record<string, unknown>;
    if (record['NAME'] !== undefined) {
      allocations.push(allocationOf(record));
      continue;
    }
    // Legacy fixture shape: an inner BILLALLOCATIONS element (kept so the
    // synthetic test fixtures remain valid).
    const inner = record['BILLALLOCATIONS'];
    const innerEntries = Array.isArray(inner) ? inner : inner ? [inner] : [];
    for (const entry of innerEntries) {
      if (typeof entry !== 'object' || entry === null) continue;
      allocations.push(allocationOf(entry as Record<string, unknown>));
    }
  }

  return allocations;
}

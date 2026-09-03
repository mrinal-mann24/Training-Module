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

  const vouchers = messages
    .map((message) => message['VOUCHER'])
    .filter((voucher): voucher is Record<string, unknown>[] => Array.isArray(voucher))
    .flat()
    .map(normalizeVoucher);

  const result = { vouchers };
  const parsed = ParsedDayBookSchema.safeParse(result);
  if (!parsed.success) {
    throw new DayBookParseError('The Day Book file could not be read — unexpected structure.');
  }

  return parsed.data;
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
  const voucherType = String(voucher['VOUCHERTYPENAME'] ?? voucher['@_VCHTYPE'] ?? '');
  const date = String(voucher['DATE'] ?? '');
  const narration = String(voucher['NARRATION'] ?? '');

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
function normalizeLedgerEntry(entry: Record<string, unknown>): LedgerEntry {
  const ledgerName = String(entry['LEDGERNAME'] ?? '');
  const amount = Number(entry['AMOUNT'] ?? 0);
  const isDeemedPositive = String(entry['ISDEEMEDPOSITIVE'] ?? '') === 'Yes';
  const drOrCr = isDeemedPositive ? 'Dr' : 'Cr';

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
function extractBillAllocations(raw: unknown): { name: string; amount: number }[] {
  const lists = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const allocations: { name: string; amount: number }[] = [];

  for (const item of lists) {
    if (typeof item !== 'object' || item === null) {
      continue; // empty list element parsed as a string
    }
    const record = item as Record<string, unknown>;
    if (record['NAME'] !== undefined) {
      allocations.push({
        name: String(record['NAME'] ?? ''),
        amount: Number(record['AMOUNT'] ?? 0),
      });
      continue;
    }
    // Legacy fixture shape: an inner BILLALLOCATIONS element (kept so the
    // synthetic test fixtures remain valid).
    const inner = record['BILLALLOCATIONS'];
    const innerEntries = Array.isArray(inner) ? inner : inner ? [inner] : [];
    for (const entry of innerEntries) {
      const innerRecord = entry as Record<string, unknown>;
      allocations.push({
        name: String(innerRecord['NAME'] ?? ''),
        amount: Number(innerRecord['AMOUNT'] ?? 0),
      });
    }
  }

  return allocations;
}

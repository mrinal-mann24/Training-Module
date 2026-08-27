import { XMLParser } from 'fast-xml-parser';
import { ParsedTrialBalanceSchema, type ParsedTrialBalance } from '@/lib/schemas/voucher';

export class TrialBalanceParseError extends Error {}

// Same UTF-16LE-with-BOM encoding as the Day Book export — see daybook.ts.
function decodeTallyXml(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return buffer.toString('utf16le', 2);
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    throw new TrialBalanceParseError('Unsupported file encoding (UTF-16 big-endian).');
  }
  return buffer.toString('utf8');
}

const parserOptions = {
  ignoreAttributes: false,
  isArray: (tagName: string) => tagName === 'DSPACCNAME' || tagName === 'DSPACCINFO',
};

// Tally's Trial Balance export pairs each DSPACCNAME (the row label — could be
// an account group or a ledger, the export format doesn't distinguish the two
// structurally) with a following DSPACCINFO (closing Dr/Cr amounts). Confirmed
// against the real TrialBal.xml sample, which is the sparse 2-group case this
// parser must still parse cleanly — sparseness is rejected by the validity
// gate, not by the parser.
export function parseTrialBalanceXml(buffer: Buffer): ParsedTrialBalance {
  let xmlText: string;
  try {
    xmlText = decodeTallyXml(buffer);
  } catch (error) {
    if (error instanceof TrialBalanceParseError) {
      throw error;
    }
    throw new TrialBalanceParseError('The Trial Balance file could not be read.');
  }

  let root: unknown;
  try {
    root = new XMLParser(parserOptions).parse(xmlText);
  } catch {
    throw new TrialBalanceParseError(
      'The Trial Balance file could not be read — it is not valid XML.',
    );
  }

  if (typeof root !== 'object' || root === null || !('ENVELOPE' in root)) {
    throw new TrialBalanceParseError(
      'The Trial Balance file does not contain any recognizable ledger data.',
    );
  }

  const envelope = (root as Record<string, unknown>)['ENVELOPE'] as Record<string, unknown>;
  const names = envelope['DSPACCNAME'];
  const infos = envelope['DSPACCINFO'];

  const nameList = Array.isArray(names) ? names : [];
  const infoList = Array.isArray(infos) ? infos : [];

  if (nameList.length === 0 || nameList.length !== infoList.length) {
    throw new TrialBalanceParseError(
      'The Trial Balance file does not contain any recognizable ledger data.',
    );
  }

  const ledgers = nameList.map((name, index) => {
    const nameRecord = name as Record<string, unknown>;
    const infoRecord = infoList[index] as Record<string, unknown>;

    const ledgerName = String(nameRecord['DSPDISPNAME'] ?? '');

    // Tally exports Trial Balances in (at least) two shapes: separate
    // Dr/Cr closing tags (DSPCLDRAMT/DSPCLCRAMT), or a single SIGNED
    // closing amount (DSPCLAMT/DSPCLAMTA) where negative = Debit and
    // positive = Credit, matching the Day Book's sign convention. The
    // signed shape came from the pilot trainee's real export (2026-08-20),
    // which parsed as all-zero balances until supported.
    const signedClosing = extractSignedAmount(infoRecord, 'DSPCLAMT', 'DSPCLAMTA');
    if (signedClosing !== null) {
      return {
        ledgerName,
        closingDebit: signedClosing < 0 ? -signedClosing : 0,
        closingCredit: signedClosing > 0 ? signedClosing : 0,
      };
    }

    const closingDebit = extractAmount(infoRecord, 'DSPCLDRAMT', 'DSPCLDRAMTA');
    const closingCredit = extractAmount(infoRecord, 'DSPCLCRAMT', 'DSPCLCRAMTA');

    return { ledgerName, closingDebit, closingCredit };
  });

  const result = { ledgers };
  const parsed = ParsedTrialBalanceSchema.safeParse(result);
  if (!parsed.success) {
    throw new TrialBalanceParseError(
      'The Trial Balance file could not be read — unexpected structure.',
    );
  }

  return parsed.data;
}

function extractSignedAmount(
  infoRecord: Record<string, unknown>,
  wrapperTag: string,
  amountTag: string,
): number | null {
  const wrapper = infoRecord[wrapperTag];
  if (typeof wrapper !== 'object' || wrapper === null) {
    return null;
  }
  const raw = (wrapper as Record<string, unknown>)[amountTag];
  const value = Number(raw);
  return Number.isFinite(value) && String(raw ?? '').trim() !== '' ? value : null;
}

function extractAmount(
  infoRecord: Record<string, unknown>,
  wrapperTag: string,
  amountTag: string,
): number {
  const wrapper = infoRecord[wrapperTag];
  if (typeof wrapper !== 'object' || wrapper === null) {
    return 0;
  }
  const raw = (wrapper as Record<string, unknown>)[amountTag];
  const value = Number(raw);
  return Number.isFinite(value) ? Math.abs(value) : 0;
}

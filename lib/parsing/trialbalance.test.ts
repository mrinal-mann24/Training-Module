import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTrialBalanceXml, TrialBalanceParseError } from './trialbalance';

const sampleTrialBalPath = path.resolve(__dirname, '../../xmls/TrialBal.xml');

describe('parseTrialBalanceXml', () => {
  it('parses the real UTF-16LE sample end-to-end (sparse, group-level-only)', () => {
    const buffer = readFileSync(sampleTrialBalPath);
    const result = parseTrialBalanceXml(buffer);

    expect(result.ledgers).toHaveLength(2);
    expect(result.ledgers[0].ledgerName).toBe('Current Liabilities');
    expect(result.ledgers[1].ledgerName).toBe('Purchase Accounts');
  });

  it('normalizes closing amounts to positive numbers, zero for a blank amount tag', () => {
    const buffer = readFileSync(sampleTrialBalPath);
    const result = parseTrialBalanceXml(buffer);

    expect(result.ledgers[0].closingDebit).toBe(21150);
    expect(result.ledgers[0].closingCredit).toBe(444150);
    expect(result.ledgers[1].closingDebit).toBe(423000);
    expect(result.ledgers[1].closingCredit).toBe(0);
  });

  it('rejects malformed XML with a specific, readable message', () => {
    const malformed = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<ENVELOPE><UNCLOSED>', 'utf16le'),
    ]);
    expect(() => parseTrialBalanceXml(malformed)).toThrow(TrialBalanceParseError);
  });
});

describe('signed single-amount format (pilot calibration, 2026-08-20)', () => {
  it('maps negative DSPCLAMTA to Debit and positive to Credit', () => {
    const xml = `<ENVELOPE><DSPACCNAME><DSPDISPNAME>Debtor A</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLAMT><DSPCLAMTA>-500.00</DSPCLAMTA></DSPCLAMT></DSPACCINFO><DSPACCNAME><DSPDISPNAME>Creditor B</DSPDISPNAME></DSPACCNAME><DSPACCINFO><DSPCLAMT><DSPCLAMTA>300.00</DSPCLAMTA></DSPCLAMT></DSPACCINFO></ENVELOPE>`;
    const buffer = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
    const result = parseTrialBalanceXml(buffer);
    expect(result.ledgers[0]).toEqual({ ledgerName: 'Debtor A', closingDebit: 500, closingCredit: 0 });
    expect(result.ledgers[1]).toEqual({ ledgerName: 'Creditor B', closingDebit: 0, closingCredit: 300 });
  });
});

describe('opening column (2026-09-11: the month\'s movement read from the file itself)', () => {
  it('reads the signed opening amount next to the signed closing amount', () => {
    const xml =
      '<ENVELOPE>' +
      '<DSPACCNAME><DSPDISPNAME>Signage Advertising (firm)</DSPDISPNAME></DSPACCNAME>' +
      '<DSPACCINFO><DSPOPAMT><DSPOPAMTA>25960.00</DSPOPAMTA></DSPOPAMT><DSPDRAMT><DSPDRAMTA>-25960.00</DSPDRAMTA></DSPDRAMT><DSPCRAMT><DSPCRAMTA></DSPCRAMTA></DSPCRAMT><DSPCLAMT><DSPCLAMTA></DSPCLAMTA></DSPCLAMT></DSPACCINFO>' +
      '<DSPACCNAME><DSPDISPNAME>Rent</DSPDISPNAME></DSPACCNAME>' +
      '<DSPACCINFO><DSPOPAMT><DSPOPAMTA>-40000.00</DSPOPAMTA></DSPOPAMT><DSPDRAMT><DSPDRAMTA>-40000.00</DSPDRAMTA></DSPDRAMT><DSPCRAMT><DSPCRAMTA></DSPCRAMTA></DSPCRAMT><DSPCLAMT><DSPCLAMTA>-80000.00</DSPCLAMTA></DSPCLAMT></DSPACCINFO>' +
      '</ENVELOPE>';
    const result = parseTrialBalanceXml(Buffer.from(xml, 'utf8'));
    // Closing tag blank means a nil closing; the opening is still read.
    expect(result.ledgers[0]).toEqual({ ledgerName: 'Signage Advertising (firm)', closingDebit: 0, closingCredit: 0 });
    expect(result.ledgers[1]).toEqual({ ledgerName: 'Rent', closingDebit: 80000, closingCredit: 0, openingDebit: 40000, openingCredit: 0 });
  });

  it('reads the separate opening Dr/Cr tags and treats a blank tag as zero', () => {
    const xml =
      '<ENVELOPE>' +
      '<DSPACCNAME><DSPDISPNAME>Karnataka Emporium</DSPDISPNAME></DSPACCNAME>' +
      '<DSPACCINFO><DSPOPDRAMT><DSPOPDRAMTA>-100000.00</DSPOPDRAMTA></DSPOPDRAMT><DSPOPCRAMT><DSPOPCRAMTA></DSPOPCRAMTA></DSPOPCRAMT><DSPCLDRAMT><DSPCLDRAMTA>-123600.00</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA></DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>' +
      '</ENVELOPE>';
    const result = parseTrialBalanceXml(Buffer.from(xml, 'utf8'));
    expect(result.ledgers[0]).toEqual({ ledgerName: 'Karnataka Emporium', closingDebit: 123600, closingCredit: 0, openingDebit: 100000, openingCredit: 0 });
  });

  it('leaves the opening fields undefined when the file has no opening column', () => {
    const buffer = readFileSync(sampleTrialBalPath);
    const result = parseTrialBalanceXml(buffer);
    expect(result.ledgers[0].openingDebit).toBeUndefined();
    expect(result.ledgers[0].openingCredit).toBeUndefined();
  });
});

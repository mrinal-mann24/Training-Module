import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDayBookXml, DayBookParseError } from './daybook';

const sampleDayBookPath = path.resolve(__dirname, '../../xmls/DayBook.xml');

describe('parseDayBookXml', () => {
  it('parses the real UTF-16LE sample end-to-end', () => {
    const buffer = readFileSync(sampleDayBookPath);
    const result = parseDayBookXml(buffer);

    expect(result.vouchers).toHaveLength(1);
    expect(result.vouchers[0].voucherType).toBe('Purchase');
    expect(result.vouchers[0].date).toBe('20260801');
    expect(result.vouchers[0].ledgerEntries).toHaveLength(3);
  });

  it('normalizes Dr/Cr per the confirmed sign convention', () => {
    const buffer = readFileSync(sampleDayBookPath);
    const result = parseDayBookXml(buffer);
    const entries = result.vouchers[0].ledgerEntries;

    const materialPurchase = entries.find((entry) => entry.ledgerName === 'Material purchase');
    expect(materialPurchase?.drOrCr).toBe('Dr');
    expect(materialPurchase?.amount).toBe(423000);

    const parekh = entries.find(
      (entry) => entry.ledgerName === 'Parekh Integrated Services Pvt Ltd',
    );
    expect(parekh?.drOrCr).toBe('Cr');
    expect(parekh?.amount).toBe(444150);
  });

  it('treats an empty BILLALLOCATIONS.LIST as an empty array, not an error', () => {
    const buffer = readFileSync(sampleDayBookPath);
    const result = parseDayBookXml(buffer);

    for (const entry of result.vouchers[0].ledgerEntries) {
      expect(entry.billAllocations).toEqual([]);
    }
  });

  it('rejects malformed XML with a specific, readable message', () => {
    const malformed = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<ENVELOPE><UNCLOSED>', 'utf16le'),
    ]);
    expect(() => parseDayBookXml(malformed)).toThrow(DayBookParseError);
  });

  it('rejects a file with no VOUCHER data', () => {
    const noVouchers = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<ENVELOPE><BODY><IMPORTDATA></IMPORTDATA></BODY></ENVELOPE>', 'utf16le'),
    ]);
    expect(() => parseDayBookXml(noVouchers)).toThrow(DayBookParseError);
  });
});

describe('real-Tally structures (pilot calibration, 2026-08-20)', () => {
  function utf16(xml: string): Buffer {
    return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(xml, 'utf16le')]);
  }

  it('reads ALLLEDGERENTRIES.LIST legs (accounting-mode vouchers)', () => {
    const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE><VOUCHER VCHTYPE="Payment"><DATE>20260405</DATE><NARRATION>x</NARRATION><VOUCHERTYPENAME>Payment</VOUCHERTYPENAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Vendor</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-100.00</AMOUNT></ALLLEDGERENTRIES.LIST><ALLLEDGERENTRIES.LIST><LEDGERNAME>Bank</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>100.00</AMOUNT></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const result = parseDayBookXml(utf16(xml));
    expect(result.vouchers[0].ledgerEntries).toHaveLength(2);
    expect(result.vouchers[0].ledgerEntries[0].ledgerName).toBe('Vendor');
  });

  it('reads repeating BILLALLOCATIONS.LIST elements with direct NAME/AMOUNT children', () => {
    const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE><VOUCHER VCHTYPE="Receipt"><DATE>20260405</DATE><NARRATION>x</NARRATION><VOUCHERTYPENAME>Receipt</VOUCHERTYPENAME><ALLLEDGERENTRIES.LIST><LEDGERNAME>Customer</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>200.00</AMOUNT><BILLALLOCATIONS.LIST><NAME>INV-001</NAME><BILLTYPE>Against Ref</BILLTYPE><AMOUNT>150.00</AMOUNT></BILLALLOCATIONS.LIST><BILLALLOCATIONS.LIST><NAME>INV-002</NAME><AMOUNT>50.00</AMOUNT></BILLALLOCATIONS.LIST></ALLLEDGERENTRIES.LIST></VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const result = parseDayBookXml(utf16(xml));
    expect(result.vouchers[0].ledgerEntries[0].billAllocations).toEqual([
      { name: 'INV-001', amount: 150 },
      { name: 'INV-002', amount: 50 },
    ]);
  });
});

describe('item-invoice vouchers (stock items in use, Garima Level 3, 2026-09-03)', () => {
  it('reads the Purchases leg from ACCOUNTINGALLOCATIONS inside each inventory line', () => {
    const xml = `<ENVELOPE><BODY><IMPORTDATA><REQUESTDATA><TALLYMESSAGE>
<VOUCHER VCHTYPE="Purchase"><DATE>20260603</DATE><VOUCHERTYPENAME>Purchase</VOUCHERTYPENAME><NARRATION>Purchase from Mumbai Suppliers</NARRATION>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Cotton Fabric</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-20000.00</AMOUNT>
  <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Purchase</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-20000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
</ALLINVENTORYENTRIES.LIST>
<ALLINVENTORYENTRIES.LIST><STOCKITEMNAME>Polyester Cloth</STOCKITEMNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-20000.00</AMOUNT>
  <ACCOUNTINGALLOCATIONS.LIST><LEDGERNAME>Purchase</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-20000.00</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
</ALLINVENTORYENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>Mumbai Suppliers</LEDGERNAME><ISDEEMEDPOSITIVE>No</ISDEEMEDPOSITIVE><AMOUNT>47200.00</AMOUNT>
  <BILLALLOCATIONS.LIST><NAME>MS-2201</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>47200.00</AMOUNT></BILLALLOCATIONS.LIST>
</LEDGERENTRIES.LIST>
<LEDGERENTRIES.LIST><LEDGERNAME>IGST</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-7200.00</AMOUNT></LEDGERENTRIES.LIST>
</VOUCHER></TALLYMESSAGE></REQUESTDATA></IMPORTDATA></BODY></ENVELOPE>`;
    const parsed = parseDayBookXml(Buffer.from(xml, 'utf8'));
    const legs = parsed.vouchers[0].ledgerEntries.map((e) => `${e.drOrCr} ${e.ledgerName} ${e.amount}`);
    expect(legs).toEqual(['Cr Mumbai Suppliers 47200', 'Dr IGST 7200', 'Dr Purchase 20000', 'Dr Purchase 20000']);
    expect(parsed.vouchers[0].ledgerEntries[0].billAllocations).toEqual([{ name: 'MS-2201', amount: 47200 }]);
  });
});

import { describe, expect, it } from 'vitest';
import { accountNamesMatch, partyAccountsOf, tdsSectionOf } from './account-names';

describe('partyAccountsOf', () => {
  const entry = (voucher_type: string, correct_account: string, dr_cr: 'Dr' | 'Cr', bill_reference: string | null) => ({ voucher_type, correct_account, dr_cr, bill_reference });

  it('takes the party side of a voucher only, even when the key stamps the reference on every leg', () => {
    const parties = partyAccountsOf([
      entry('Purchase', 'Purchases', 'Dr', 'MS-900'),
      entry('Purchase', 'Input CGST', 'Dr', 'MS-900'),
      entry('Purchase', 'Mumbai Suppliers', 'Cr', 'MS-900'),
      entry('Sales', 'Karnataka Emporium', 'Dr', 'INV-070'),
      entry('Sales', 'Sales', 'Cr', 'INV-070'),
      entry('Purchase', 'Legal & Professional Charges', 'Dr', 'SL/2027-04'),
      entry('Purchase', 'Sharma Legal (individual)', 'Cr', 'SL/2027-04'),
      entry('Payment', 'Hero Rentals (individual)', 'Dr', 'HR/2027-04'),
      entry('Payment', 'HDFC Bank — 1234', 'Cr', null),
    ]);
    expect([...parties].sort()).toEqual(['herorentalsindividual', 'karnatakaemporium', 'mumbaisuppliers', 'sharmalegalindividual']);
  });

  it('never treats a core profit-and-loss ledger as a party', () => {
    expect([...partyAccountsOf([entry('Payment', 'Rent', 'Dr', 'HR/2027-05'), entry('Journal', 'Sales Returns', 'Dr', 'INV-009')])]).toEqual([]);
  });
});

describe('accountNamesMatch on the advertising family', () => {
  it('reads "Advertising and Marketing" as "Advertisement & Marketing" (Praveen, April 2025)', () => {
    expect(accountNamesMatch('Advertising and Marketing', 'Advertisement & Marketing')).toBe(true);
    expect(accountNamesMatch('Signage Advertising (firm)', 'Advertisement & Marketing')).toBe(false);
  });
});

describe('tdsSectionOf', () => {
  it('reads a known section from the ledger name in any of the learners\' spellings', () => {
    expect(tdsSectionOf('TDS Payable — u/s 194J')).toBe('194j');
    expect(tdsSectionOf('TDS U/S 194 I')).toBe('194i');
    expect(tdsSectionOf('TDS Payable - 194c')).toBe('194c');
    expect(tdsSectionOf('TDS Receivable — u/s 194J')).toBe('194j');
  });

  it('ignores names without a section and unrecognised section letters', () => {
    expect(tdsSectionOf('TDS Payable')).toBeNull();
    expect(tdsSectionOf('TDS Payable - 194Ci')).toBeNull();
    expect(tdsSectionOf('Rent')).toBeNull();
  });
});

describe('accountNamesMatch with TDS sections', () => {
  it('rejects a deduction booked under a different section (rulebook 12, E06)', () => {
    expect(accountNamesMatch('TDS Payable — u/s 194C', 'TDS Payable — u/s 194J')).toBe(false);
    expect(accountNamesMatch('TDS Payable u/s 194I', 'TDS Payable — u/s 194C')).toBe(false);
  });

  it('still accepts the same section in another spelling', () => {
    expect(accountNamesMatch('TDS Payable - 194c', 'TDS Payable — u/s 194C')).toBe(true);
    expect(accountNamesMatch('TDS Payable u/s 194J', 'TDS Payable — u/s 194J')).toBe(true);
  });

  it('lets a typo that is not a known section fall through to the ordinary rules', () => {
    // Praveen's rent-TDS ledger.
    expect(accountNamesMatch('TDS Payable - 194Ci', 'TDS Payable — u/s 194I')).toBe(true);
  });

  it('keeps TDS Receivable distinct from TDS Payable of the same section', () => {
    expect(accountNamesMatch('TDS Payable — u/s 194J', 'TDS Receivable — u/s 194J')).toBe(false);
  });
});

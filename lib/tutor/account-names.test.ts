import { describe, expect, it } from 'vitest';
import {
  accountNamesMatch,
  aliasAcceptsLedger,
  aliasFitsAccount,
  classifyLedger,
  headWisePayableHead,
  isGenericGstPayable,
  isTaxLedgerName,
  keyAccountSet,
  partyAccountsOf,
  tdsSectionOf,
} from './account-names';

describe('GST payable ledgers (2026-09-17)', () => {
  it('tells the single GST Payable from head-wise payables, and never takes an Output or Input ledger for a payable', () => {
    expect(isGenericGstPayable('GST Payable')).toBe(true);
    expect(isGenericGstPayable('IGST Payable')).toBe(false);
    expect(isGenericGstPayable('Kingston Payables')).toBe(false);
    expect(headWisePayableHead('IGST Payable')).toBe('IGST');
    expect(headWisePayableHead('CGST Payable A/c')).toBe('CGST');
    expect(headWisePayableHead('Output IGST')).toBeNull();
    expect(headWisePayableHead('Output IGST Payable')).toBeNull();
    expect(headWisePayableHead('GST Payable')).toBeNull();
  });
});

describe('aliasFitsAccount (returns require their own ledger, 2026-09-16)', () => {
  it('refuses a base ledger as an alias of a returns ledger, and a returns ledger as an alias of its base', () => {
    expect(aliasFitsAccount('Sales', 'Sales Returns')).toBe(false);
    expect(aliasFitsAccount('Credit Sales A/c', 'Sales Returns')).toBe(false);
    expect(aliasFitsAccount('Trading goods', 'Purchase Returns')).toBe(false);
    expect(aliasFitsAccount('Purchase Return', 'Sales')).toBe(false);
  });

  it('accepts aliases on the same side of the returns line', () => {
    expect(aliasFitsAccount('Sales Return', 'Sales Returns')).toBe(true);
    expect(aliasFitsAccount('Trading goods', 'Purchases')).toBe(true);
    expect(aliasFitsAccount('Marketing collaterals', 'Advertisement & Marketing')).toBe(true);
  });
});

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

describe('audit fixes: lenient matching must not equate different accounts (2026-09-17)', () => {
  it('never equates a balance-sheet ledger with the expense or income head it accrues', () => {
    expect(accountNamesMatch('Salary Payable', 'Salaries')).toBe(false);
    expect(accountNamesMatch('Rent Payable', 'Rent')).toBe(false);
    expect(accountNamesMatch('Prepaid Rent', 'Rent')).toBe(false);
    expect(accountNamesMatch('Salary Advance', 'Salaries')).toBe(false);
    expect(accountNamesMatch('Outstanding Salary', 'Outstanding Rent')).toBe(false);
  });

  it('keeps income and expense apart', () => {
    expect(accountNamesMatch('Interest Paid', 'Interest')).toBe(true); // no direction on the bare name
    expect(accountNamesMatch('Interest Paid', 'Interest Income')).toBe(false);
    expect(accountNamesMatch('Discount Allowed', 'Discount Received')).toBe(false);
    expect(aliasAcceptsLedger('Interest Paid', 'Interest', 'Interest Income')).toBe(false);
    expect(aliasAcceptsLedger('Interest Received', 'Interest', 'Interest Income')).toBe(true);
  });

  it('does not read Bank Charges as the bank, nor IGST Payable as GST Payable', () => {
    expect(accountNamesMatch('Bank Charges', 'Bank')).toBe(false);
    expect(aliasAcceptsLedger('Bank Charges', 'Bank', 'HDFC Bank — 1234')).toBe(false);
    expect(accountNamesMatch('IGST Payable', 'GST Payable')).toBe(false);
  });

  it('typo tolerance never equates two distinct accounts of the same key', () => {
    expect(accountNamesMatch('Mehta Traders', 'Mehra Traders')).toBe(true);
    const keyAccounts = keyAccountSet(['Mehra Traders', 'Mehta Traders', 'Purchases']);
    expect(accountNamesMatch('Mehta Traders', 'Mehra Traders', { keyAccounts })).toBe(false);
    expect(accountNamesMatch('Mehra Traders', 'Mehra Traders', { keyAccounts })).toBe(true);
    expect(accountNamesMatch('Purchsaes', 'Purchases', { keyAccounts })).toBe(true);
  });

  it('keeps the accepted variations', () => {
    expect(accountNamesMatch('Credit Sales A/c', 'Sales')).toBe(true);
    expect(accountNamesMatch('Cash Sales A/c', 'Sales')).toBe(true);
    expect(accountNamesMatch('SUSPENSE AC', 'Suspense')).toBe(true);
    expect(accountNamesMatch('Deccan Traders Debtor', 'Deccan Traders')).toBe(true);
    expect(accountNamesMatch('Accounts Payable', 'Outstanding Expenses')).toBe(true);
    expect(accountNamesMatch('Expenses Payable', 'Outstanding Expenses')).toBe(true);
    expect(accountNamesMatch('TDS Payable', 'TDS')).toBe(true);
    expect(accountNamesMatch('Marketing collaterals', 'Marketing collaterals')).toBe(true);
    expect(accountNamesMatch('Output CGST', 'CGST')).toBe(true);
    expect(accountNamesMatch('Kolkata Emporium', 'Kolkata Traders')).toBe(false);
    expect(accountNamesMatch('Sales Returns', 'Sales')).toBe(false);
    expect(accountNamesMatch('TDS Receivable', 'TDS Payable')).toBe(false);
  });

  it('recognises tax ledgers by word, not by substring', () => {
    expect(isTaxLedgerName('Kingston Traders')).toBe(false);
    expect(isTaxLedgerName('Input CGST 9%')).toBe(true);
    expect(isTaxLedgerName('GST@18%')).toBe(true);
    expect(isTaxLedgerName('TDS194C Payable')).toBe(true);
    expect(isTaxLedgerName('Outstanding TDS')).toBe(true);
    expect(classifyLedger('Kingston Traders', new Set(['kingstontraders']))).toBe('balance_sheet');
  });
});

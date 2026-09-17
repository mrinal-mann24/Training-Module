import { describe, expect, it } from 'vitest';
import { amountInWords, formatHsnSac, hsnSacFor, reverseChargeFromLegs, taxRatePercentOf } from './gst-invoice-fields';

describe('amountInWords (Indian numbering, 2026-09-17)', () => {
  it('writes lakh and crore, rupees and paise', () => {
    expect(amountInWords(0)).toBe('Rupees Zero Only');
    expect(amountInWords(70800)).toBe('Rupees Seventy Thousand Eight Hundred Only');
    expect(amountInWords(106200.5)).toBe('Rupees One Lakh Six Thousand Two Hundred and Fifty Paise Only');
    expect(amountInWords(12345678.09)).toBe('Rupees One Crore Twenty Three Lakh Forty Five Thousand Six Hundred Seventy Eight and Nine Paise Only');
    expect(amountInWords(1000000000)).toBe('Rupees One Hundred Crore Only');
    expect(amountInWords(19.999)).toBe('Rupees Twenty Only');
  });
});

describe('hsnSacFor (ledger nature to HSN/SAC)', () => {
  it('maps services by type and goods to the trading default', () => {
    expect(formatHsnSac(hsnSacFor('Rent'))).toBe('SAC 997212');
    expect(formatHsnSac(hsnSacFor('Legal & Professional Charges'))).toBe('SAC 998211');
    expect(formatHsnSac(hsnSacFor('Advertisement Expenses'))).toBe('SAC 998361');
    expect(formatHsnSac(hsnSacFor('Freight & Delivery Charges'))).toBe('SAC 996511');
    expect(formatHsnSac(hsnSacFor('Software Subscription'))).toBe('SAC 997331');
    expect(formatHsnSac(hsnSacFor('Repairs & Maintenance'))).toBe('SAC 998719');
    expect(formatHsnSac(hsnSacFor('Cleaning Charges'))).toBe('SAC 998533');
    expect(formatHsnSac(hsnSacFor('Purchases'))).toBe('HSN 6304');
    expect(formatHsnSac(hsnSacFor('Sales'))).toBe('HSN 6304');
  });

  it('prints no code rather than a wrong one', () => {
    expect(hsnSacFor('Electricity Charges')).toBeNull();
    expect(formatHsnSac(null)).toBeUndefined();
    expect(hsnSacFor('Sales', { serviceSupply: true })).toBeNull();
  });
});

describe('reverse charge and tax rate', () => {
  it('reads reverse charge off RCM ledgers and the combined rate off the figures', () => {
    expect(reverseChargeFromLegs([{ correct_account: 'Legal Fees' }, { correct_account: 'Output CGST (RCM)' }])).toBe(true);
    expect(reverseChargeFromLegs([{ correct_account: 'Input CGST' }])).toBe(false);
    expect(taxRatePercentOf(60000, { cgst: 5400, sgst: 5400, igst: null })).toBe(18);
    expect(taxRatePercentOf(90000, { cgst: null, sgst: null, igst: 10800 })).toBe(12);
    expect(taxRatePercentOf(30000, { cgst: null, sgst: null, igst: null })).toBeNull();
  });
});

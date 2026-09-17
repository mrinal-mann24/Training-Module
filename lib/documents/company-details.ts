// The learner's company as stated in the diagnostic pack's Company Master
// sheet (Blossom Retail Pvt Ltd) — printed as the seller block on our own
// sales invoices and cash memos, and as the buyer block on vendor invoices.
// The bank account lives in bank-account-details.ts.
//
// GSTIN (2026-09-17): kept EXACTLY as the pack's Company Master sheet prints it
// (29AABCB1234H1Z5), because learners type that value into their own Tally
// company and every invoice we print must agree with it. It is a mock number
// and its check character does not satisfy the GSTIN check digit (which would
// be '0'); the user decided mock values are fine as long as each party has
// exactly one GSTIN and one address. Party GSTINs from party-directory.ts are
// valid mocks; this constant is the one listed exception in the literal scan
// (party-directory.test.ts).
export const COMPANY_DETAILS = {
  name: 'Blossom Retail Pvt Ltd',
  gstin: '29AABCB1234H1Z5',
  address: '#123, 5th Cross, Indiranagar, Bengaluru 560038, Karnataka',
  state: 'Karnataka',
  stateCode: '29',
} as const;

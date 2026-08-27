import type { ConceptTag } from '@/lib/schemas/exercise';

// Phase 3 (spec 15): the video-module registry, so the tutor can point
// learners at modules BY NAME before any video is recorded. Titles are
// verbatim from the build spec's Appendix H ("None exist yet; produce
// against this list"). Until the videos exist, the extracted VA Training
// Module docs (module-docs.ts) back the same concepts — this registry is
// the naming layer help step 1 and Q&A reference.
//
// conceptTags map each module to the scored concept vocabulary; setup and
// workflow modules that no scored concept covers (company creation, ledger
// groups, exports walkthrough, AIA intro) carry an empty list — they are
// still nameable in Q&A answers, just never the step-1 pointer for a scored
// concept.
export type VideoModule = {
  id: string;
  title: string;
  conceptTags: ConceptTag[];
};

export const VIDEO_MODULES: VideoModule[] = [
  { id: 'create-company', title: 'Create a company and set Books Begin Date', conceptTags: [] },
  { id: 'parent-groups-ledger-creation', title: 'Parent groups and ledger creation', conceptTags: [] },
  {
    id: 'choosing-voucher-type',
    title: 'Choosing the right voucher type',
    conceptTags: [
      'sales_voucher_basics',
      'purchase_voucher_basics',
      'payment_voucher_basics',
      'receipt_voucher_basics',
      'contra_voucher_basics',
      'journal_voucher_basics',
    ],
  },
  {
    id: 'sales-invoice-gst',
    title: 'Book a sales invoice (intra and inter-state GST)',
    conceptTags: ['sales_voucher_basics', 'gst_classification'],
  },
  {
    id: 'purchase-itc',
    title: 'Book a purchase and claim ITC',
    conceptTags: ['purchase_voucher_basics', 'gst_classification'],
  },
  {
    id: 'receipts-payments-bill-by-bill',
    title: 'Receipts and payments with bill-by-bill',
    conceptTags: ['receipt_voucher_basics', 'payment_voucher_basics', 'bill_by_bill_referencing'],
  },
  { id: 'narration-standards', title: 'Narration standards', conceptTags: ['narration_discipline'] },
  {
    id: 'tds-at-booking',
    title: 'TDS at booking (section, rate, threshold, base not gross)',
    conceptTags: ['tds_classification'],
  },
  {
    id: 'customer-advance-goods',
    title: 'Customer advance for goods',
    conceptTags: ['receipt_voucher_basics', 'bill_by_bill_referencing'],
  },
  {
    id: 'customer-advance-services',
    title: 'Customer advance for services (the three-voucher chain)',
    conceptTags: ['receipt_voucher_basics', 'bill_by_bill_referencing'],
  },
  {
    id: 'supplier-advance',
    title: 'Supplier advance',
    conceptTags: ['payment_voucher_basics', 'bill_by_bill_referencing'],
  },
  {
    id: 'journal-adjustments-gst-utilisation',
    title: 'Journal adjustments and GST utilisation',
    conceptTags: ['journal_voucher_basics', 'gst_classification'],
  },
  {
    id: 'bank-reconciliation',
    title: 'Reconciling to a bank statement',
    conceptTags: ['contra_voucher_basics', 'payment_voucher_basics', 'receipt_voucher_basics'],
  },
  {
    id: 'reading-vendor-invoice',
    title: 'Reading a vendor invoice and catching a wrong figure',
    conceptTags: ['purchase_voucher_basics'],
  },
  {
    id: 'exporting-daybook-tb',
    title: 'Exporting the Detailed Day Book and Trial Balance',
    conceptTags: ['trial_balance_tie_out'],
  },
  { id: 'intro-aia', title: 'Introduction to AIA and the AIA workflow', conceptTags: [] },
];

export function videoModulesForConcept(conceptTag: ConceptTag): VideoModule[] {
  return VIDEO_MODULES.filter((module) => module.conceptTags.includes(conceptTag));
}

// Prompt-ready registry listing: title plus the concepts it covers, one per
// line, so an LLM can pick the right module by name without inventing one.
export const VIDEO_MODULE_LIST_BLOCK = VIDEO_MODULES.map(
  (module, index) =>
    `${index + 1}. "${module.title}"${module.conceptTags.length > 0 ? ` (covers: ${module.conceptTags.join(', ')})` : ''}`,
).join('\n');

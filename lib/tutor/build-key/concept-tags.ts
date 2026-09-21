import type { ConceptTag } from '@/lib/schemas/exercise';
import { parseBillReferences } from '@/lib/tutor/bill-reference';
import type { BuiltLeg } from './tax';

// Concept tags derived from the built voucher (2026-09-22, rebuild Stage
// 3), so a tag can never name a concept the voucher does not exercise
// (checkConceptTagsMatchContent's CONCEPT_EVIDENCE is the mirror image of
// this table).

export function conceptTagsFor(legs: readonly BuiltLeg[], options: { assetPurchase?: boolean } = {}): ConceptTag[] {
  const type = legs[0]?.voucher_type.trim().toLowerCase() ?? '';
  const tags = new Set<ConceptTag>();
  const reference = legs.find((leg) => leg.bill_reference)?.bill_reference ?? null;
  const parsed = parseBillReferences(reference);
  const hasGst = legs.some((leg) => leg.gst_head !== null);
  const hasTds = legs.some((leg) => leg.tds_section !== null || /\btds\b/i.test(leg.correct_account));

  switch (type) {
    case 'sales':
      tags.add('sales_voucher_basics');
      break;
    case 'purchase':
      tags.add('purchase_voucher_basics');
      break;
    case 'receipt':
      tags.add('receipt_voucher_basics');
      break;
    case 'payment':
      tags.add('payment_voucher_basics');
      break;
    case 'contra':
      tags.add('contra_voucher_basics');
      break;
    case 'journal':
      tags.add('journal_voucher_basics');
      break;
    // A credit note is the sales-side return, a debit note the purchase-side
    // one (CONCEPT_EVIDENCE reads them the same way).
    case 'credit note':
      tags.add('sales_voucher_basics');
      break;
    case 'debit note':
      tags.add('purchase_voucher_basics');
      break;
    default:
      break;
  }
  if (hasGst) tags.add('gst_classification');
  if (hasTds) tags.add('tds_classification');
  if (type === 'receipt' && legs.some((leg) => /\btds\b/i.test(leg.correct_account) && /receivable/i.test(leg.correct_account))) tags.add('tds_on_receipt');
  if (legs.some((leg) => /\brcm\b|reverse\s*charge/i.test(leg.correct_account) || /late fee|interest on (?:delayed )?gst|gst interest/i.test(leg.correct_account))) {
    tags.add('rcm_and_late_fee');
  }
  if (reference !== null) tags.add('bill_by_bill_referencing');
  if (parsed.some((item) => item.kind === 'advance')) {
    tags.add(type === 'sales' || type === 'receipt' ? 'customer_advance' : 'supplier_advance');
  }
  if (parsed.some((item) => item.kind === 'on_account')) tags.add('on_account_reference');
  if (parsed.filter((item) => item.kind === 'against').length >= 2) tags.add('multi_bill_settlement');
  if (options.assetPurchase || legs.some((leg) => /depreciation/i.test(leg.correct_account))) tags.add('fixed_assets_depreciation');
  return [...tags];
}

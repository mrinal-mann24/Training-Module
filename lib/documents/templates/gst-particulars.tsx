import { View, Text, StyleSheet } from '@react-pdf/renderer';
import type { SalesInvoiceContent, VendorInvoiceContent } from '@/lib/schemas/source-document';
import { formatStatementAmount } from '@/lib/documents/bank-account-details';

// Rule 46 particulars block (2026-09-17), shared by every invoice layout so
// the six vendor formats and the sales invoice print the same fields: the
// recipient block (vendor invoices), place of supply with state code,
// reverse charge, an HSN/SAC summary with the tax rate, round-off, and the
// total in words. Every field is optional in the stored content; a document
// stored before 2026-09-17 carries none of them and renders exactly as it
// did (this block renders nothing).
const styles = StyleSheet.create({
  block: { marginTop: 14, paddingTop: 8, borderTop: '0.5pt solid #DEDEE2', fontSize: 9 },
  row: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 },
  column: { width: '48%' },
  label: { fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#F7F7F8', paddingVertical: 3, paddingHorizontal: 4, fontFamily: 'Helvetica-Bold' },
  tableRow: { flexDirection: 'row', paddingVertical: 3, paddingHorizontal: 4, borderBottom: '0.5pt solid #ECECEE' },
  colCode: { width: '40%' },
  colTaxable: { width: '35%', textAlign: 'right' },
  colRate: { width: '25%', textAlign: 'right' },
  words: { marginTop: 6 },
});

type Recipient = { name?: string; address?: string; gstin?: string | null };

type Props = {
  lineItems: VendorInvoiceContent['lineItems'];
  recipient?: Recipient;
  // Printed here only when the layout does not already print it.
  placeOfSupply?: string;
  placeOfSupplyCode?: string;
  reverseCharge?: boolean;
  taxRatePercent?: number | null;
  roundOff?: number | null;
  amountInWords?: string;
};

function hasParticulars(props: Props): boolean {
  return Boolean(
    props.recipient?.name ||
      props.placeOfSupplyCode ||
      props.reverseCharge !== undefined ||
      props.amountInWords ||
      props.lineItems.some((item) => item.hsnSac),
  );
}

function hsnSummary(lineItems: Props['lineItems']): { code: string; taxable: number }[] {
  const byCode = new Map<string, number>();
  for (const item of lineItems) {
    if (!item.hsnSac) continue;
    byCode.set(item.hsnSac, (byCode.get(item.hsnSac) ?? 0) + item.amount);
  }
  return [...byCode.entries()].map(([code, taxable]) => ({ code, taxable: Math.round(taxable * 100) / 100 }));
}

export function GstParticulars(props: Props) {
  if (!hasParticulars(props)) return null;
  const summary = hsnSummary(props.lineItems);
  const rate = props.taxRatePercent ?? null;
  return (
    <View style={styles.block}>
      <View style={styles.row}>
        {props.recipient?.name ? (
          <View style={styles.column}>
            <Text style={styles.label}>Bill to (recipient)</Text>
            <Text>{props.recipient.name}</Text>
            {props.recipient.address ? <Text>{props.recipient.address}</Text> : null}
            {props.recipient.gstin ? <Text>GSTIN: {props.recipient.gstin}</Text> : null}
          </View>
        ) : null}
        <View style={styles.column}>
          {props.placeOfSupply ? (
            <Text>
              Place of supply: {props.placeOfSupply}
              {props.placeOfSupplyCode ? ` (${props.placeOfSupplyCode})` : ''}
            </Text>
          ) : null}
          {props.reverseCharge !== undefined ? <Text>Tax payable on reverse charge: {props.reverseCharge ? 'Yes' : 'No'}</Text> : null}
          {props.roundOff !== undefined && props.roundOff !== null ? <Text>Round off: {formatStatementAmount(props.roundOff)}</Text> : null}
        </View>
      </View>

      {summary.length > 0 ? (
        <View>
          <View style={styles.tableHeader}>
            <Text style={styles.colCode}>HSN/SAC</Text>
            <Text style={styles.colTaxable}>Taxable value</Text>
            <Text style={styles.colRate}>GST rate</Text>
          </View>
          {summary.map((row) => (
            <View key={row.code} style={styles.tableRow}>
              <Text style={styles.colCode}>{row.code}</Text>
              <Text style={styles.colTaxable}>{formatStatementAmount(row.taxable)}</Text>
              <Text style={styles.colRate}>{rate === null ? 'Nil' : `${rate}%`}</Text>
            </View>
          ))}
        </View>
      ) : null}

      {props.amountInWords ? <Text style={styles.words}>Amount in words: {props.amountInWords}</Text> : null}
    </View>
  );
}

export function VendorInvoiceParticulars({ content }: { content: VendorInvoiceContent }) {
  return (
    <GstParticulars
      lineItems={content.lineItems}
      recipient={{ name: content.buyerName, address: content.buyerAddress, gstin: content.buyerGSTIN }}
      placeOfSupply={content.placeOfSupply}
      placeOfSupplyCode={content.placeOfSupplyCode}
      reverseCharge={content.reverseCharge}
      taxRatePercent={content.taxRatePercent}
      roundOff={content.roundOff}
      amountInWords={content.amountInWords}
    />
  );
}

// The sales layout already prints the buyer and the place of supply.
export function SalesInvoiceParticulars({ content }: { content: SalesInvoiceContent }) {
  return (
    <GstParticulars
      lineItems={content.lineItems}
      placeOfSupplyCode={content.placeOfSupplyCode}
      reverseCharge={content.reverseCharge}
      taxRatePercent={content.taxRatePercent}
      amountInWords={content.amountInWords}
    />
  );
}

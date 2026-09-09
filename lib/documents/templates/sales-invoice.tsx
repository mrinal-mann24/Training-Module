import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { SalesInvoiceContent } from '@/lib/schemas/source-document';
import { formatStatementAmount } from '@/lib/documents/bank-account-details';

// Our own outgoing tax invoice / cash memo (documents mode). Deterministic
// layout from SalesInvoiceContent, which is itself built by code from the
// answer key — no model involvement anywhere in this document.
const styles = StyleSheet.create({
  page: { padding: 32, fontSize: 10, fontFamily: 'Helvetica', color: '#232326' },
  title: { fontSize: 16, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  subtitle: { fontSize: 9, color: '#5c5c64', marginBottom: 10 },
  partyBlock: { flexDirection: 'row', justifyContent: 'space-between', borderBottom: '1pt solid #DEDEE2', paddingBottom: 10, marginBottom: 12 },
  partyColumn: { width: '48%' },
  label: { fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 2 },
  tableHeader: { flexDirection: 'row', backgroundColor: '#F7F7F8', paddingVertical: 6, paddingHorizontal: 4, borderBottom: '1pt solid #DEDEE2' },
  tableRow: { flexDirection: 'row', paddingVertical: 6, paddingHorizontal: 4, borderBottom: '0.5pt solid #ECECEE' },
  colDescription: { width: '46%' },
  colQuantity: { width: '12%', textAlign: 'right' },
  colRate: { width: '20%', textAlign: 'right' },
  colAmount: { width: '22%', textAlign: 'right' },
  taxSection: { marginTop: 12, alignItems: 'flex-end' },
  taxRow: { flexDirection: 'row', width: 230, justifyContent: 'space-between', marginBottom: 3 },
  totalRow: { flexDirection: 'row', width: 230, justifyContent: 'space-between', marginTop: 6, paddingTop: 6, borderTop: '1pt solid #DEDEE2', fontFamily: 'Helvetica-Bold' },
  footer: { marginTop: 24, fontSize: 8, color: '#5c5c64' },
});

type Props = { content: SalesInvoiceContent };

export function SalesInvoiceDocument({ content }: Props) {
  const subtotal = content.lineItems.reduce((sum, item) => sum + item.amount, 0);
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.title}>{content.isCashMemo ? 'Cash Memo' : 'Tax Invoice'}</Text>
        <Text style={styles.subtitle}>{content.isCashMemo ? 'Counter sale, paid in cash' : 'Original for recipient'}</Text>

        <View style={styles.partyBlock}>
          <View style={styles.partyColumn}>
            <Text style={styles.label}>Sold by</Text>
            <Text>{content.sellerName}</Text>
            <Text>{content.sellerAddress}</Text>
            <Text>GSTIN: {content.sellerGSTIN}</Text>
          </View>
          <View style={styles.partyColumn}>
            <Text style={styles.label}>Bill to</Text>
            <Text>{content.buyerName}</Text>
            <Text>Place of supply: {content.placeOfSupply}</Text>
            <View style={styles.metaRow}>
              <Text>{content.isCashMemo ? 'Memo No' : 'Invoice No'}: {content.invoiceNumber}</Text>
            </View>
            <Text>Date: {content.invoiceDate}</Text>
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={styles.colDescription}>Description</Text>
          <Text style={styles.colQuantity}>Qty</Text>
          <Text style={styles.colRate}>Rate</Text>
          <Text style={styles.colAmount}>Amount</Text>
        </View>
        {content.lineItems.map((item, index) => (
          <View key={index} style={styles.tableRow}>
            <Text style={styles.colDescription}>{item.description}</Text>
            <Text style={styles.colQuantity}>{item.quantity}</Text>
            <Text style={styles.colRate}>{formatStatementAmount(item.rate)}</Text>
            <Text style={styles.colAmount}>{formatStatementAmount(item.amount)}</Text>
          </View>
        ))}

        <View style={styles.taxSection}>
          <View style={styles.taxRow}>
            <Text>Taxable value</Text>
            <Text>{formatStatementAmount(subtotal)}</Text>
          </View>
          {content.taxBreakup.cgst_amount !== null && (
            <View style={styles.taxRow}>
              <Text>CGST</Text>
              <Text>{formatStatementAmount(content.taxBreakup.cgst_amount)}</Text>
            </View>
          )}
          {content.taxBreakup.sgst_amount !== null && (
            <View style={styles.taxRow}>
              <Text>SGST</Text>
              <Text>{formatStatementAmount(content.taxBreakup.sgst_amount)}</Text>
            </View>
          )}
          {content.taxBreakup.igst_amount !== null && (
            <View style={styles.taxRow}>
              <Text>IGST</Text>
              <Text>{formatStatementAmount(content.taxBreakup.igst_amount)}</Text>
            </View>
          )}
          <View style={styles.totalRow}>
            <Text>{content.isCashMemo ? 'Total received in cash' : 'Invoice total'}</Text>
            <Text>{formatStatementAmount(content.totalAmount)}</Text>
          </View>
        </View>

        <Text style={styles.footer}>
          Generated by the AIA Academy for training practice. This is the company&apos;s own copy of the document it issued.
        </Text>
      </Page>
    </Document>
  );
}

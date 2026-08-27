import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

// Deterministic, code-based layout — same VendorInvoiceContent always
// produces the same rendered PDF. No LLM involvement at this step; the LLM's
// job ended at producing the validated structured content passed in here.
const styles = StyleSheet.create({
  page: {
    padding: 32,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: '#232326',
  },
  header: {
    marginBottom: 16,
    borderBottom: '1pt solid #DEDEE2',
    paddingBottom: 12,
  },
  title: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    marginBottom: 4,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 2,
  },
  section: {
    marginTop: 12,
    marginBottom: 12,
  },
  tableHeader: {
    flexDirection: 'row',
    backgroundColor: '#F7F7F8',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottom: '1pt solid #DEDEE2',
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 4,
    borderBottom: '0.5pt solid #ECECEE',
  },
  colDescription: { width: '40%' },
  colQuantity: { width: '15%', textAlign: 'right' },
  colRate: { width: '20%', textAlign: 'right' },
  colAmount: { width: '25%', textAlign: 'right' },
  taxSection: {
    marginTop: 12,
    alignItems: 'flex-end',
  },
  taxRow: {
    flexDirection: 'row',
    width: 220,
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  totalRow: {
    flexDirection: 'row',
    width: 220,
    justifyContent: 'space-between',
    marginTop: 6,
    paddingTop: 6,
    borderTop: '1pt solid #DEDEE2',
  },
  totalLabel: {
    fontFamily: 'Helvetica-Bold',
  },
  totalValue: {
    fontFamily: 'Helvetica-Bold',
  },
});

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

type VendorInvoiceDocumentProps = {
  content: VendorInvoiceContent;
};

export function VendorInvoiceDocument({ content }: VendorInvoiceDocumentProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>Tax Invoice</Text>
          <View style={styles.metaRow}>
            <Text>{content.vendorName}</Text>
            <Text>Invoice No: {content.invoiceNumber}</Text>
          </View>
          <View style={styles.metaRow}>
            <Text>GSTIN: {content.vendorGSTIN}</Text>
            <Text>Date: {content.invoiceDate}</Text>
          </View>
        </View>

        <View style={styles.section}>
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
              <Text style={styles.colRate}>{formatAmount(item.rate)}</Text>
              <Text style={styles.colAmount}>{formatAmount(item.amount)}</Text>
            </View>
          ))}
        </View>

        <View style={styles.taxSection}>
          {content.taxBreakup.cgst_amount !== null && (
            <View style={styles.taxRow}>
              <Text>CGST</Text>
              <Text>{formatAmount(content.taxBreakup.cgst_amount)}</Text>
            </View>
          )}
          {content.taxBreakup.sgst_amount !== null && (
            <View style={styles.taxRow}>
              <Text>SGST</Text>
              <Text>{formatAmount(content.taxBreakup.sgst_amount)}</Text>
            </View>
          )}
          {content.taxBreakup.igst_amount !== null && (
            <View style={styles.taxRow}>
              <Text>IGST</Text>
              <Text>{formatAmount(content.taxBreakup.igst_amount)}</Text>
            </View>
          )}
          <View style={styles.totalRow}>
            <Text style={styles.totalLabel}>Total</Text>
            <Text style={styles.totalValue}>{formatAmount(content.totalAmount)}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}

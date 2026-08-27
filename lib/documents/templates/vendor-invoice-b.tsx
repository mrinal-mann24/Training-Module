import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

// Format B — "boxed classic": Times-Roman, full outer border, centered
// letterhead, ruled column grid. Same VendorInvoiceContent as every other
// format; deterministic render (Phase 4, spec 16 format variety).
const styles = StyleSheet.create({
  page: {
    padding: 28,
    fontSize: 10,
    fontFamily: 'Times-Roman',
    color: '#1c1c1e',
  },
  box: {
    border: '1pt solid #1c1c1e',
    padding: 14,
  },
  vendorName: {
    fontSize: 18,
    fontFamily: 'Times-Bold',
    textAlign: 'center',
  },
  gstin: {
    textAlign: 'center',
    marginTop: 2,
    fontSize: 9,
  },
  docTitle: {
    textAlign: 'center',
    marginTop: 8,
    marginBottom: 10,
    fontSize: 11,
    fontFamily: 'Times-Bold',
    letterSpacing: 2,
  },
  metaRow: {
    flexDirection: 'row',
    border: '1pt solid #1c1c1e',
    marginBottom: 10,
  },
  metaCell: {
    flex: 1,
    padding: 6,
    borderRight: '1pt solid #1c1c1e',
  },
  metaCellLast: {
    flex: 1,
    padding: 6,
  },
  metaLabel: {
    fontSize: 8,
    marginBottom: 2,
  },
  tableHeader: {
    flexDirection: 'row',
    borderTop: '1pt solid #1c1c1e',
    borderBottom: '1pt solid #1c1c1e',
    fontFamily: 'Times-Bold',
  },
  tableRow: {
    flexDirection: 'row',
    borderBottom: '0.5pt solid #9a9aa2',
  },
  colDescription: { width: '40%', padding: 5, borderRight: '0.5pt solid #9a9aa2' },
  colQuantity: { width: '15%', padding: 5, textAlign: 'right', borderRight: '0.5pt solid #9a9aa2' },
  colRate: { width: '20%', padding: 5, textAlign: 'right', borderRight: '0.5pt solid #9a9aa2' },
  colAmount: { width: '25%', padding: 5, textAlign: 'right' },
  taxSection: {
    marginTop: 12,
    alignItems: 'flex-end',
  },
  taxBox: {
    border: '1pt solid #1c1c1e',
    width: 230,
    padding: 8,
  },
  taxRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 4,
    paddingTop: 4,
    borderTop: '1pt solid #1c1c1e',
    fontFamily: 'Times-Bold',
  },
  footerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginTop: 24,
    fontSize: 9,
  },
});

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

type Props = {
  content: VendorInvoiceContent;
};

export function VendorInvoiceDocumentB({ content }: Props) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.box}>
          <Text style={styles.vendorName}>{content.vendorName}</Text>
          <Text style={styles.gstin}>GSTIN: {content.vendorGSTIN}</Text>
          <Text style={styles.docTitle}>TAX INVOICE</Text>

          <View style={styles.metaRow}>
            <View style={styles.metaCell}>
              <Text style={styles.metaLabel}>Invoice No.</Text>
              <Text>{content.invoiceNumber}</Text>
            </View>
            <View style={styles.metaCellLast}>
              <Text style={styles.metaLabel}>Invoice Date</Text>
              <Text>{content.invoiceDate}</Text>
            </View>
          </View>

          <View style={styles.tableHeader}>
            <Text style={styles.colDescription}>Particulars</Text>
            <Text style={styles.colQuantity}>Qty.</Text>
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

          <View style={styles.taxSection}>
            <View style={styles.taxBox}>
              {content.taxBreakup.cgst_amount !== null && (
                <View style={styles.taxRow}>
                  <Text>Add: CGST</Text>
                  <Text>{formatAmount(content.taxBreakup.cgst_amount)}</Text>
                </View>
              )}
              {content.taxBreakup.sgst_amount !== null && (
                <View style={styles.taxRow}>
                  <Text>Add: SGST</Text>
                  <Text>{formatAmount(content.taxBreakup.sgst_amount)}</Text>
                </View>
              )}
              {content.taxBreakup.igst_amount !== null && (
                <View style={styles.taxRow}>
                  <Text>Add: IGST</Text>
                  <Text>{formatAmount(content.taxBreakup.igst_amount)}</Text>
                </View>
              )}
              <View style={styles.totalRow}>
                <Text>Grand Total</Text>
                <Text>{formatAmount(content.totalAmount)}</Text>
              </View>
            </View>
          </View>

          <View style={styles.footerRow}>
            <Text>E. &amp; O.E.</Text>
            <Text>For {content.vendorName}, Authorised Signatory</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}

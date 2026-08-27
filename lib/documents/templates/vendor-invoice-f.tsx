import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

// Format F — "modern accent": dark header band, zebra-striped rows, accent
// total band. Same VendorInvoiceContent as every other format (Phase 4,
// spec 16).
const styles = StyleSheet.create({
  page: {
    padding: 0,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: '#232326',
  },
  headerBand: {
    backgroundColor: '#1f2937',
    paddingVertical: 20,
    paddingHorizontal: 36,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  vendorName: {
    fontSize: 16,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
  },
  headerGstin: {
    fontSize: 8,
    color: '#d1d5db',
    marginTop: 3,
  },
  invoiceWord: {
    fontSize: 18,
    fontFamily: 'Helvetica-Bold',
    color: '#ffffff',
    textAlign: 'right',
  },
  body: {
    paddingVertical: 20,
    paddingHorizontal: 36,
  },
  metaRow: {
    flexDirection: 'row',
    gap: 24,
    marginBottom: 16,
  },
  metaBlock: {
    backgroundColor: '#f7f7f8',
    borderRadius: 4,
    paddingVertical: 6,
    paddingHorizontal: 10,
  },
  metaLabel: {
    fontSize: 7,
    color: '#5c5c64',
    marginBottom: 2,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 6,
    borderBottom: '1pt solid #1f2937',
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 6,
  },
  tableRowAlt: {
    flexDirection: 'row',
    paddingVertical: 6,
    paddingHorizontal: 6,
    backgroundColor: '#f7f7f8',
  },
  colDescription: { width: '44%' },
  colQuantity: { width: '12%', textAlign: 'right' },
  colRate: { width: '20%', textAlign: 'right' },
  colAmount: { width: '24%', textAlign: 'right' },
  taxSection: {
    marginTop: 16,
    alignItems: 'flex-end',
  },
  taxRow: {
    flexDirection: 'row',
    width: 210,
    justifyContent: 'space-between',
    marginBottom: 3,
    fontSize: 9,
    paddingHorizontal: 10,
  },
  totalBand: {
    flexDirection: 'row',
    width: 210,
    justifyContent: 'space-between',
    marginTop: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    backgroundColor: '#314dd0',
    borderRadius: 4,
    color: '#ffffff',
    fontFamily: 'Helvetica-Bold',
    fontSize: 11,
  },
});

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

type Props = {
  content: VendorInvoiceContent;
};

export function VendorInvoiceDocumentF({ content }: Props) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.headerBand}>
          <View>
            <Text style={styles.vendorName}>{content.vendorName}</Text>
            <Text style={styles.headerGstin}>GSTIN {content.vendorGSTIN}</Text>
          </View>
          <Text style={styles.invoiceWord}>INVOICE</Text>
        </View>

        <View style={styles.body}>
          <View style={styles.metaRow}>
            <View style={styles.metaBlock}>
              <Text style={styles.metaLabel}>INVOICE NUMBER</Text>
              <Text>{content.invoiceNumber}</Text>
            </View>
            <View style={styles.metaBlock}>
              <Text style={styles.metaLabel}>DATE</Text>
              <Text>{content.invoiceDate}</Text>
            </View>
          </View>

          <View style={styles.tableHeader}>
            <Text style={styles.colDescription}>Description</Text>
            <Text style={styles.colQuantity}>Qty</Text>
            <Text style={styles.colRate}>Rate</Text>
            <Text style={styles.colAmount}>Amount</Text>
          </View>
          {content.lineItems.map((item, index) => (
            <View key={index} style={index % 2 === 1 ? styles.tableRowAlt : styles.tableRow}>
              <Text style={styles.colDescription}>{item.description}</Text>
              <Text style={styles.colQuantity}>{item.quantity}</Text>
              <Text style={styles.colRate}>{formatAmount(item.rate)}</Text>
              <Text style={styles.colAmount}>{formatAmount(item.amount)}</Text>
            </View>
          ))}

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
            <View style={styles.totalBand}>
              <Text>TOTAL</Text>
              <Text>{formatAmount(content.totalAmount)}</Text>
            </View>
          </View>
        </View>
      </Page>
    </Document>
  );
}

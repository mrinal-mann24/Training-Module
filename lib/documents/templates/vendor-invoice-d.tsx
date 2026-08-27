import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

// Format D — "GST portal dense": small type, ORIGINAL FOR RECIPIENT banner,
// two bordered meta panels, fully gridded serial-numbered table with the
// grand total as a table footer row. Same VendorInvoiceContent as every
// other format (Phase 4, spec 16).
const styles = StyleSheet.create({
  page: {
    padding: 26,
    fontSize: 8.5,
    fontFamily: 'Helvetica',
    color: '#232326',
  },
  banner: {
    textAlign: 'center',
    fontSize: 11,
    fontFamily: 'Helvetica-Bold',
  },
  bannerSub: {
    textAlign: 'center',
    fontSize: 7.5,
    marginTop: 2,
    marginBottom: 8,
  },
  metaPanels: {
    flexDirection: 'row',
    border: '0.75pt solid #232326',
    marginBottom: 8,
  },
  metaPanel: {
    flex: 1,
    padding: 6,
    borderRight: '0.75pt solid #232326',
  },
  metaPanelLast: {
    flex: 1,
    padding: 6,
  },
  metaTitle: {
    fontFamily: 'Helvetica-Bold',
    marginBottom: 3,
  },
  metaLine: {
    marginBottom: 2,
  },
  tableHeader: {
    flexDirection: 'row',
    borderTop: '0.75pt solid #232326',
    borderLeft: '0.75pt solid #232326',
    borderRight: '0.75pt solid #232326',
    borderBottom: '0.75pt solid #232326',
    backgroundColor: '#f0f0f2',
    fontFamily: 'Helvetica-Bold',
  },
  tableRow: {
    flexDirection: 'row',
    borderLeft: '0.75pt solid #232326',
    borderRight: '0.75pt solid #232326',
    borderBottom: '0.5pt solid #9a9aa2',
  },
  totalTableRow: {
    flexDirection: 'row',
    borderLeft: '0.75pt solid #232326',
    borderRight: '0.75pt solid #232326',
    borderBottom: '0.75pt solid #232326',
    fontFamily: 'Helvetica-Bold',
  },
  colSl: { width: '6%', padding: 4, borderRight: '0.5pt solid #9a9aa2', textAlign: 'center' },
  colDescription: { width: '40%', padding: 4, borderRight: '0.5pt solid #9a9aa2' },
  colQuantity: { width: '12%', padding: 4, textAlign: 'right', borderRight: '0.5pt solid #9a9aa2' },
  colRate: { width: '18%', padding: 4, textAlign: 'right', borderRight: '0.5pt solid #9a9aa2' },
  colAmount: { width: '24%', padding: 4, textAlign: 'right' },
  taxTable: {
    marginTop: 10,
    width: 220,
    border: '0.75pt solid #232326',
    alignSelf: 'flex-start',
  },
  taxTableRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 4,
    borderBottom: '0.5pt solid #9a9aa2',
  },
  taxTableTotal: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    padding: 4,
    fontFamily: 'Helvetica-Bold',
  },
});

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

type Props = {
  content: VendorInvoiceContent;
};

export function VendorInvoiceDocumentD({ content }: Props) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.banner}>TAX INVOICE</Text>
        <Text style={styles.bannerSub}>(ORIGINAL FOR RECIPIENT)</Text>

        <View style={styles.metaPanels}>
          <View style={styles.metaPanel}>
            <Text style={styles.metaTitle}>{content.vendorName}</Text>
            <Text style={styles.metaLine}>GSTIN/UIN: {content.vendorGSTIN}</Text>
          </View>
          <View style={styles.metaPanelLast}>
            <Text style={styles.metaLine}>Invoice No.: {content.invoiceNumber}</Text>
            <Text style={styles.metaLine}>Dated: {content.invoiceDate}</Text>
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={styles.colSl}>Sl.</Text>
          <Text style={styles.colDescription}>Description of Goods / Services</Text>
          <Text style={styles.colQuantity}>Quantity</Text>
          <Text style={styles.colRate}>Rate</Text>
          <Text style={styles.colAmount}>Amount</Text>
        </View>
        {content.lineItems.map((item, index) => (
          <View key={index} style={styles.tableRow}>
            <Text style={styles.colSl}>{index + 1}</Text>
            <Text style={styles.colDescription}>{item.description}</Text>
            <Text style={styles.colQuantity}>{item.quantity}</Text>
            <Text style={styles.colRate}>{formatAmount(item.rate)}</Text>
            <Text style={styles.colAmount}>{formatAmount(item.amount)}</Text>
          </View>
        ))}
        <View style={styles.totalTableRow}>
          <Text style={styles.colSl}> </Text>
          <Text style={styles.colDescription}>Total (incl. tax)</Text>
          <Text style={styles.colQuantity}> </Text>
          <Text style={styles.colRate}> </Text>
          <Text style={styles.colAmount}>{formatAmount(content.totalAmount)}</Text>
        </View>

        <View style={styles.taxTable}>
          {content.taxBreakup.cgst_amount !== null && (
            <View style={styles.taxTableRow}>
              <Text>CGST</Text>
              <Text>{formatAmount(content.taxBreakup.cgst_amount)}</Text>
            </View>
          )}
          {content.taxBreakup.sgst_amount !== null && (
            <View style={styles.taxTableRow}>
              <Text>SGST</Text>
              <Text>{formatAmount(content.taxBreakup.sgst_amount)}</Text>
            </View>
          )}
          {content.taxBreakup.igst_amount !== null && (
            <View style={styles.taxTableRow}>
              <Text>IGST</Text>
              <Text>{formatAmount(content.taxBreakup.igst_amount)}</Text>
            </View>
          )}
          <View style={styles.taxTableTotal}>
            <Text>Invoice Total</Text>
            <Text>{formatAmount(content.totalAmount)}</Text>
          </View>
        </View>
      </Page>
    </Document>
  );
}

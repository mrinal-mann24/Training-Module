import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

// Format C — "letterhead minimal": large vendor wordmark, one heavy rule,
// hairline table with no fills, right-aligned totals, computer-generated
// footer. Same VendorInvoiceContent as every other format (Phase 4, spec 16).
const styles = StyleSheet.create({
  page: {
    padding: 40,
    fontSize: 10,
    fontFamily: 'Helvetica',
    color: '#232326',
  },
  topRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
  },
  vendorName: {
    fontSize: 20,
    fontFamily: 'Helvetica-Bold',
  },
  gstin: {
    fontSize: 8,
    color: '#5c5c64',
    marginTop: 3,
  },
  invoiceWord: {
    fontSize: 14,
    color: '#5c5c64',
    textAlign: 'right',
  },
  invoiceMeta: {
    fontSize: 9,
    textAlign: 'right',
    marginTop: 3,
  },
  rule: {
    borderBottom: '2pt solid #232326',
    marginTop: 12,
    marginBottom: 16,
  },
  tableHeader: {
    flexDirection: 'row',
    paddingBottom: 5,
    borderBottom: '0.75pt solid #232326',
    fontFamily: 'Helvetica-Bold',
    fontSize: 9,
  },
  tableRow: {
    flexDirection: 'row',
    paddingVertical: 7,
    borderBottom: '0.5pt solid #dedee2',
  },
  colDescription: { width: '46%' },
  colQuantity: { width: '12%', textAlign: 'right' },
  colRate: { width: '18%', textAlign: 'right' },
  colAmount: { width: '24%', textAlign: 'right' },
  taxSection: {
    marginTop: 14,
    alignItems: 'flex-end',
  },
  taxRow: {
    flexDirection: 'row',
    width: 200,
    justifyContent: 'space-between',
    marginBottom: 3,
    fontSize: 9,
    color: '#5c5c64',
  },
  totalRow: {
    flexDirection: 'row',
    width: 200,
    justifyContent: 'space-between',
    marginTop: 6,
    paddingTop: 6,
    borderTop: '0.75pt solid #232326',
    fontFamily: 'Helvetica-Bold',
    fontSize: 12,
  },
  footer: {
    position: 'absolute',
    bottom: 32,
    left: 40,
    right: 40,
    fontSize: 8,
    color: '#9a9aa2',
    fontFamily: 'Helvetica-Oblique',
    textAlign: 'center',
  },
});

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

type Props = {
  content: VendorInvoiceContent;
};

export function VendorInvoiceDocumentC({ content }: Props) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.topRow}>
          <View>
            <Text style={styles.vendorName}>{content.vendorName}</Text>
            <Text style={styles.gstin}>GSTIN {content.vendorGSTIN}</Text>
          </View>
          <View>
            <Text style={styles.invoiceWord}>Invoice</Text>
            <Text style={styles.invoiceMeta}>No. {content.invoiceNumber}</Text>
            <Text style={styles.invoiceMeta}>{content.invoiceDate}</Text>
          </View>
        </View>
        <View style={styles.rule} />

        <View style={styles.tableHeader}>
          <Text style={styles.colDescription}>Item</Text>
          <Text style={styles.colQuantity}>Qty</Text>
          <Text style={styles.colRate}>Unit price</Text>
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
            <Text>Total due</Text>
            <Text>{formatAmount(content.totalAmount)}</Text>
          </View>
        </View>

        <Text style={styles.footer}>This is a computer generated invoice.</Text>
      </Page>
    </Document>
  );
}

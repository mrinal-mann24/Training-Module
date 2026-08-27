import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { VendorInvoiceContent } from '@/lib/schemas/source-document';

// Format E — "cash memo": Courier throughout, dashed separators, qty x rate
// folded into the description line, small-shop register feel. Same
// VendorInvoiceContent as every other format (Phase 4, spec 16).
const styles = StyleSheet.create({
  page: {
    padding: 44,
    fontSize: 10,
    fontFamily: 'Courier',
    color: '#232326',
  },
  vendorName: {
    fontSize: 13,
    fontFamily: 'Courier-Bold',
    textAlign: 'center',
  },
  gstin: {
    fontSize: 8,
    textAlign: 'center',
    marginTop: 2,
  },
  memoTitle: {
    fontSize: 11,
    fontFamily: 'Courier-Bold',
    textAlign: 'center',
    marginTop: 8,
  },
  dashedRule: {
    borderBottom: '1pt dashed #232326',
    marginTop: 8,
    marginBottom: 8,
  },
  metaRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  itemRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 5,
  },
  itemLeft: {
    width: '72%',
  },
  itemQtyRate: {
    fontSize: 8,
    marginTop: 1,
  },
  itemAmount: {
    width: '28%',
    textAlign: 'right',
  },
  taxRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 3,
  },
  totalRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    fontFamily: 'Courier-Bold',
    fontSize: 12,
    marginTop: 6,
  },
  thanks: {
    textAlign: 'center',
    marginTop: 20,
    fontSize: 9,
  },
});

function formatAmount(amount: number): string {
  return amount.toFixed(2);
}

type Props = {
  content: VendorInvoiceContent;
};

export function VendorInvoiceDocumentE({ content }: Props) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <Text style={styles.vendorName}>{content.vendorName}</Text>
        <Text style={styles.gstin}>GSTIN: {content.vendorGSTIN}</Text>
        <Text style={styles.memoTitle}>BILL / CASH MEMO</Text>
        <View style={styles.dashedRule} />

        <View style={styles.metaRow}>
          <Text>Bill No: {content.invoiceNumber}</Text>
          <Text>Date: {content.invoiceDate}</Text>
        </View>
        <View style={styles.dashedRule} />

        {content.lineItems.map((item, index) => (
          <View key={index} style={styles.itemRow}>
            <View style={styles.itemLeft}>
              <Text>{item.description}</Text>
              <Text style={styles.itemQtyRate}>
                {item.quantity} x {formatAmount(item.rate)}
              </Text>
            </View>
            <Text style={styles.itemAmount}>{formatAmount(item.amount)}</Text>
          </View>
        ))}
        <View style={styles.dashedRule} />

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
          <Text>TOTAL</Text>
          <Text>{formatAmount(content.totalAmount)}</Text>
        </View>
        <View style={styles.dashedRule} />

        <Text style={styles.thanks}>Thank you! Visit again.</Text>
      </Page>
    </Document>
  );
}

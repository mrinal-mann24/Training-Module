import { Document, Page, View, Text, StyleSheet } from '@react-pdf/renderer';
import type { BankStatementContent } from '@/lib/schemas/source-document';

// Deterministic, code-based layout — same BankStatementContent always
// produces the same rendered PDF. No LLM involvement at this step.
const styles = StyleSheet.create({
  page: {
    padding: 32,
    fontSize: 9,
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
  colDate: { width: '15%' },
  colNarration: { width: '45%' },
  colDebit: { width: '13%', textAlign: 'right' },
  colCredit: { width: '13%', textAlign: 'right' },
  colBalance: { width: '14%', textAlign: 'right' },
});

function formatAmount(amount: number | null): string {
  return amount === null ? '-' : amount.toFixed(2);
}

type BankStatementDocumentProps = {
  content: BankStatementContent;
};

export function BankStatementDocument({ content }: BankStatementDocumentProps) {
  return (
    <Document>
      <Page size="A4" style={styles.page}>
        <View style={styles.header}>
          <Text style={styles.title}>Account Statement</Text>
          <View style={styles.metaRow}>
            <Text>{content.accountHolderName}</Text>
            <Text>Period: {content.period}</Text>
          </View>
        </View>

        <View style={styles.tableHeader}>
          <Text style={styles.colDate}>Date</Text>
          <Text style={styles.colNarration}>Narration</Text>
          <Text style={styles.colDebit}>Debit</Text>
          <Text style={styles.colCredit}>Credit</Text>
          <Text style={styles.colBalance}>Balance</Text>
        </View>
        {content.transactions.map((transaction, index) => (
          <View key={index} style={styles.tableRow}>
            <Text style={styles.colDate}>{transaction.date}</Text>
            <Text style={styles.colNarration}>{transaction.narration}</Text>
            <Text style={styles.colDebit}>{formatAmount(transaction.debit)}</Text>
            <Text style={styles.colCredit}>{formatAmount(transaction.credit)}</Text>
            <Text style={styles.colBalance}>{formatAmount(transaction.balance)}</Text>
          </View>
        ))}
      </Page>
    </Document>
  );
}

export type SampleVideo = {
  id: string;
  title: string;
  duration: string;
};

// Placeholder samples for the /chat video library. There is no video backend
// yet: these titles are not playable and the tiles render as plain content
// (no links, no buttons), labelled "Sample" in the UI.
export const SAMPLE_VIDEOS: readonly SampleVideo[] = [
  { id: 'sales-voucher', title: 'Recording a sales voucher', duration: '6:40' },
  { id: 'gst-on-purchases', title: 'GST on purchases', duration: '8:15' },
  { id: 'receipts-and-payments', title: 'Receipts and payments', duration: '5:30' },
  { id: 'bank-reconciliation', title: 'Bank reconciliation basics', duration: '7:05' },
  { id: 'reading-trial-balance', title: 'Reading a Trial Balance', duration: '9:20' },
];

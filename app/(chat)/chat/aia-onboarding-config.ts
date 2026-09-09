// The one-time AI Accountant setup flow shown when documents mode unlocks
// (three mastered concepts). Pure data: no imports, safe in the client
// bundle. Wording rules match the walkthrough: no em dashes, plain steps.

export const AIA_SETUP_VIDEO_URL = 'https://youtu.be/myh5RShH6fM';
export const AIA_SETUP_VIDEO_EMBED_URL = 'https://www.youtube.com/embed/myh5RShH6fM';

export type AiaOnboardingStep = {
  id: string;
  title: string;
  body: string;
  // The video step embeds the setup video above its text.
  video?: boolean;
  buttonLabel: string;
};

export const AIA_ONBOARDING_STEPS: AiaOnboardingStep[] = [
  {
    id: 'intro',
    title: 'You have mastered 3 modules',
    body:
      'From your next batch, every entry arrives as documents, the way real work does: vendor invoices, your own sales invoices and cash memos, one bank statement, and a month-end notes sheet. You will process them through AI Accountant (AIA), which posts the vouchers into your Tally company. This setup takes a few minutes and you only do it once.',
    buttonLabel: 'Next',
  },
  {
    id: 'video',
    title: 'Watch the setup video',
    body: 'It shows how to download AI Accountant, install the Tally connector and link it to your company. Watch it fully before moving on.',
    video: true,
    buttonLabel: 'I have watched it',
  },
  {
    id: 'connector',
    title: 'Install the connector',
    body:
      'Download AI Accountant and install the Tally connector on the computer where your Tally company runs, exactly as shown in the video. Have you done that?',
    buttonLabel: 'Yes, installed',
  },
  {
    id: 'connect',
    title: 'Connect your company',
    body:
      'Open AI Accountant, connect it to your Tally company (Blossom Retail Pvt Ltd, books beginning 1 April 2024) and run a first sync so it can see your ledgers. Is it connected?',
    buttonLabel: 'Yes, connected',
  },
  {
    id: 'monthly',
    title: 'How each month works from now on',
    body:
      '1. Download the documents from the exercise message.\n2. Upload the invoices, cash memos and the bank statement to AI Accountant.\n3. Review every voucher it proposes: ledger, side, amount, GST, bill reference. Fix anything wrong before you sync.\n4. Sync to Tally.\n5. Post the month-end notes by hand in Tally.\n6. Export the Day Book and Trial Balance and upload them here as usual.',
    buttonLabel: 'Next',
  },
  {
    id: 'scoring',
    title: 'Scoring does not change',
    body:
      'Your Tally exports are what get evaluated, exactly as before. AI Accountant is a tool; what ends up in the books is still your responsibility, so check its vouchers before you sync. Written explanations continue in the chat for explain batches.',
    buttonLabel: 'Start',
  },
];

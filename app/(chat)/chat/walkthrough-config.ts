import type { LicenseMode } from '@/lib/schemas/onboarding';
import { BOOKS_BEGIN_LABEL } from '@/lib/tutor/timeline';

export type WalkthroughStep = {
  id: string;
  content: string;
  buttonLabel: 'Next' | 'I understand';
};

const WELCOME_STEP: WalkthroughStep = {
  id: 'welcome',
  content:
    "This chat is where you'll do your training. I'll give you exercises, you complete them in Tally, and you upload your exports here for scoring and feedback.",
  buttonLabel: 'Next',
};

// 2026-09-16: the old copy said "last day of any month" and told learners to
// re-date the pack themselves. Tally Educational Mode saves only the 1st, 2nd
// and 31st, so a 30-day month allows just the 1st and 2nd. The pack now ships
// re-dated Educational Mode files (resolvePackFilesForLicense) and generated
// batches are re-dated in code, so every file an educational learner gets is
// already on an allowed day. The Month-end Notes sheet still names days such
// as "30-Apr" in its prose, hence the last sentence.
const EDUCATIONAL_MODE_STEP: WalkthroughStep = {
  id: 'educational-mode',
  content:
    "You're on Educational Mode. Tally only saves vouchers dated the 1st, 2nd or 31st of a month. In a month without a 31st (April, June, September, November and February), only the 1st and 2nd work: Tally does not accept the 28th, 29th or 30th. Your practice files are already dated on these days, so post each voucher on the date shown in the register or bank statement, even if a note mentions another day. Scoring never penalizes the date.",
  buttonLabel: 'Next',
};

const BOOKS_BEGIN_DATE_STEP: WalkthroughStep = {
  id: 'books-begin-date',
  content: `Set your Books Begin Date to ${BOOKS_BEGIN_LABEL} in Tally before starting.`,
  buttonLabel: 'Next',
};

const WHAT_NEXT_STEP: WalkthroughStep = {
  id: 'what-next',
  content:
    "Next, you'll get an exercise. Do it in Tally, then upload your exports here when you're ready.",
  buttonLabel: 'I understand',
};

export function getWalkthroughSteps(licenseMode: LicenseMode): WalkthroughStep[] {
  const steps = [WELCOME_STEP];

  if (licenseMode === 'educational') {
    steps.push(EDUCATIONAL_MODE_STEP);
  }

  steps.push(BOOKS_BEGIN_DATE_STEP, WHAT_NEXT_STEP);

  return steps;
}

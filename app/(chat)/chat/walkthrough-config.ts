import type { LicenseMode } from '@/lib/schemas/onboarding';

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

const EDUCATIONAL_MODE_STEP: WalkthroughStep = {
  id: 'educational-mode',
  content:
    "You're on Educational Mode. That means Tally restricts voucher entry to the 1st, 2nd, and last day of any month. Keep that in mind as you post transactions. Your first practice set uses real-world dates from the source files: if Tally refuses a date, post that voucher on the nearest allowed day. Scoring never penalizes the date.",
  buttonLabel: 'Next',
};

const BOOKS_BEGIN_DATE_STEP: WalkthroughStep = {
  id: 'books-begin-date',
  content: 'Set your Books Begin Date to 01-Apr-2026 in Tally before starting.',
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

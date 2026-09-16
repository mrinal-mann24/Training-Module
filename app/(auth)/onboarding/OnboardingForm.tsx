'use client';

import { useActionState, useState } from 'react';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { submitOnboarding } from './actions';
import { initialOnboardingFormState } from './onboarding-form-state';
import { BOOKS_BEGIN_DATE } from '@/lib/tutor/timeline';

const DEFAULT_BOOKS_BEGIN_DATE = BOOKS_BEGIN_DATE;

const INPUT_CLASSES = 'day-input h-12 w-full rounded-2xl px-5 font-nunito text-base';

const CHOICE_CLASSES =
  'day-choice cursor-pointer rounded-2xl px-4 py-3 text-left font-nunito text-base font-semibold';

const SUBMIT_CLASSES =
  'inline-flex h-12 w-full cursor-pointer items-center justify-center rounded-full bg-day-blue font-urbanist text-lg text-white transition-colors duration-200 hover:bg-day-blue-hover disabled:cursor-not-allowed disabled:opacity-50';

const LEGEND_CLASSES = 'font-nunito text-base font-semibold text-day-ink';

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(
    submitOnboarding,
    initialOnboardingFormState,
  );
  const [licenseMode, setLicenseMode] = useState<LicenseMode | null>(null);
  const [booksBeginDate, setBooksBeginDate] = useState(DEFAULT_BOOKS_BEGIN_DATE);

  const canContinue = licenseMode !== null && booksBeginDate !== '';

  return (
    <form action={formAction} className="flex flex-col gap-6 font-nunito">
      <fieldset className="flex flex-col gap-2">
        <legend className={LEGEND_CLASSES}>Your name</legend>
        <p className="text-sm leading-relaxed text-day-muted">
          Your tutor will address you by this name.
        </p>
        <input
          type="text"
          name="full_name"
          required
          maxLength={120}
          placeholder="e.g. Shruti Nair"
          className={INPUT_CLASSES}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className={LEGEND_CLASSES}>Tally license mode</legend>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setLicenseMode('licensed')}
            aria-pressed={licenseMode === 'licensed'}
            className={CHOICE_CLASSES}
          >
            Licensed Tally
          </button>
          <button
            type="button"
            onClick={() => setLicenseMode('educational')}
            aria-pressed={licenseMode === 'educational'}
            className={CHOICE_CLASSES}
          >
            Educational Mode
          </button>
        </div>

        {licenseMode === 'educational' && (
          <p className="text-sm leading-relaxed text-day-muted">
            In Educational Mode, Tally only saves vouchers dated the 1st, 2nd or 31st of a month,
            so a month without a 31st allows only the 1st and 2nd.
          </p>
        )}

        <input type="hidden" name="license_mode" value={licenseMode ?? ''} />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className={LEGEND_CLASSES}>Books Begin Date</legend>

        <label htmlFor="books_begin_date" className="sr-only">
          Books Begin Date
        </label>
        <input
          id="books_begin_date"
          name="books_begin_date"
          type="date"
          required
          value={booksBeginDate}
          onChange={(event) => setBooksBeginDate(event.target.value)}
          className={INPUT_CLASSES}
        />
      </fieldset>

      {state.error && <p className="day-error text-sm">{state.error}</p>}

      <button type="submit" disabled={!canContinue || isPending} className={SUBMIT_CLASSES}>
        {isPending ? 'Continuing…' : 'Continue'}
      </button>
    </form>
  );
}

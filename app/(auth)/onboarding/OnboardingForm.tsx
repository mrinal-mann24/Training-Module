'use client';

import { useActionState, useState } from 'react';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { submitOnboarding } from './actions';
import { initialOnboardingFormState } from './onboarding-form-state';

const DEFAULT_BOOKS_BEGIN_DATE = '2026-04-01';

const INPUT_CLASSES = 'night-input w-full rounded-lg px-4 py-3 font-body text-sm';

const CHOICE_CLASSES =
  'night-choice cursor-pointer rounded-lg px-4 py-3 text-left text-sm font-medium';

const SUBMIT_CLASSES =
  'night-btn night-btn-solid inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-md font-body text-sm font-medium tracking-tight disabled:cursor-not-allowed';

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(
    submitOnboarding,
    initialOnboardingFormState,
  );
  const [licenseMode, setLicenseMode] = useState<LicenseMode | null>(null);
  const [booksBeginDate, setBooksBeginDate] = useState(DEFAULT_BOOKS_BEGIN_DATE);

  const canContinue = licenseMode !== null && booksBeginDate !== '';

  return (
    <form action={formAction} className="flex flex-col gap-6 font-body">
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-white">Your name</legend>
        <p className="night-muted text-sm leading-relaxed">
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
        <legend className="text-sm font-medium text-white">Tally license mode</legend>

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
          <p className="night-muted text-sm leading-relaxed">
            In Educational Mode, Tally restricts voucher entry to the 1st, 2nd, and last day of
            any month.
          </p>
        )}

        <input type="hidden" name="license_mode" value={licenseMode ?? ''} />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-white">Books Begin Date</legend>

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

      {state.error && <p className="night-error text-sm">{state.error}</p>}

      <button type="submit" disabled={!canContinue || isPending} className={SUBMIT_CLASSES}>
        {isPending ? 'Continuing…' : 'Continue'}
      </button>
    </form>
  );
}

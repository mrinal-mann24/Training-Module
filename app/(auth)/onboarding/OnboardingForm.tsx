'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/lib/cn';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { submitOnboarding } from './actions';
import { initialOnboardingFormState } from './onboarding-form-state';

const DEFAULT_BOOKS_BEGIN_DATE = '2026-04-01';

const INPUT_CLASSES =
  'w-full rounded-2xl border border-white/80 bg-white/75 px-5 py-3.5 font-sans text-base text-wandor-text shadow-[0_0_2px_0_rgba(0,0,0,0.05)] backdrop-blur-[14px] transition-colors placeholder:text-wandor-muted focus:border-wandor-dark focus:outline-none';

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(
    submitOnboarding,
    initialOnboardingFormState,
  );
  const [licenseMode, setLicenseMode] = useState<LicenseMode | null>(null);
  const [booksBeginDate, setBooksBeginDate] = useState(DEFAULT_BOOKS_BEGIN_DATE);

  const canContinue = licenseMode !== null && booksBeginDate !== '';

  return (
    <form action={formAction} className="flex flex-col gap-7">
      <fieldset className="flex flex-col gap-3">
        <legend className="font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-wandor-text">
          Your name
        </legend>
        <p className="text-sm leading-relaxed text-wandor-muted">
          Your tutor will address you by this name.
        </p>
        <input
          type="text"
          name="full_name"
          required
          maxLength={120}
          placeholder="e.g. Elina Shaji"
          className={INPUT_CLASSES}
        />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-wandor-text">
          Tally license mode
        </legend>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setLicenseMode('licensed')}
            className={cn(
              'cursor-pointer rounded-2xl border px-5 py-3.5 text-left font-sans text-base font-medium backdrop-blur-[14px] transition-all',
              licenseMode === 'licensed'
                ? 'border-wandor-dark bg-white text-wandor-text'
                : 'border-white/80 bg-white/60 text-wandor-muted hover:bg-white/80',
            )}
          >
            Licensed Tally
          </button>
          <button
            type="button"
            onClick={() => setLicenseMode('educational')}
            className={cn(
              'cursor-pointer rounded-2xl border px-5 py-3.5 text-left font-sans text-base font-medium backdrop-blur-[14px] transition-all',
              licenseMode === 'educational'
                ? 'border-wandor-dark bg-white text-wandor-text'
                : 'border-white/80 bg-white/60 text-wandor-muted hover:bg-white/80',
            )}
          >
            Educational Mode
          </button>
        </div>

        {licenseMode === 'educational' && (
          <p className="text-sm leading-relaxed text-wandor-prompt">
            In Educational Mode, Tally restricts voucher entry to the 1st, 2nd, and last day of
            any month.
          </p>
        )}

        <input type="hidden" name="license_mode" value={licenseMode ?? ''} />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-sans text-[13px] font-semibold uppercase tracking-[0.08em] text-wandor-text">
          Books Begin Date
        </legend>

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

      {state.error && <p className="text-sm text-status-error">{state.error}</p>}

      <button
        type="submit"
        disabled={!canContinue || isPending}
        className="w-full cursor-pointer rounded-full bg-wandor-dark px-5 py-3.5 font-sans text-[15px] font-medium uppercase tracking-[0.04em] text-[#fafafa] transition-all hover:bg-[#333] active:scale-95 disabled:opacity-60 disabled:active:scale-100"
      >
        {isPending ? 'Continuing…' : 'Continue'}
      </button>
    </form>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/lib/cn';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { submitOnboarding } from './actions';
import { initialOnboardingFormState } from './onboarding-form-state';

const DEFAULT_BOOKS_BEGIN_DATE = '2026-04-01';

export function OnboardingForm() {
  const [state, formAction, isPending] = useActionState(
    submitOnboarding,
    initialOnboardingFormState,
  );
  const [licenseMode, setLicenseMode] = useState<LicenseMode | null>(null);
  const [booksBeginDate, setBooksBeginDate] = useState(DEFAULT_BOOKS_BEGIN_DATE);

  const canContinue = licenseMode !== null && booksBeginDate !== '';

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <fieldset className="flex flex-col gap-3">
        <legend className="text-lg text-text-primary">Your name</legend>
        <p className="text-sm text-text-secondary">Your tutor will address you by this name.</p>
        <input
          type="text"
          name="full_name"
          required
          maxLength={120}
          placeholder="e.g. Elina Shaji"
          className="rounded-md border border-border-default bg-bg-canvas px-4 py-3 text-base text-text-primary placeholder:text-text-muted"
        />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-lg text-text-primary">Tally license mode</legend>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setLicenseMode('licensed')}
            className={cn(
              'rounded-md border px-4 py-3 text-left text-base transition-colors',
              licenseMode === 'licensed'
                ? 'border-accent bg-accent-subtle text-text-primary'
                : 'border-border-default bg-bg-canvas text-text-primary hover:bg-bg-surface',
            )}
          >
            Licensed Tally
          </button>
          <button
            type="button"
            onClick={() => setLicenseMode('educational')}
            className={cn(
              'rounded-md border px-4 py-3 text-left text-base transition-colors',
              licenseMode === 'educational'
                ? 'border-accent bg-accent-subtle text-text-primary'
                : 'border-border-default bg-bg-canvas text-text-primary hover:bg-bg-surface',
            )}
          >
            Educational Mode
          </button>
        </div>

        {licenseMode === 'educational' && (
          <p className="text-sm text-text-secondary">
            In Educational Mode, Tally restricts voucher entry to the 1st, 2nd, and last day of
            any month.
          </p>
        )}

        <input type="hidden" name="license_mode" value={licenseMode ?? ''} />
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-lg text-text-primary">Books Begin Date</legend>

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
          className="w-full rounded-md border border-border-default bg-bg-canvas px-3 py-2 text-base text-text-primary focus:border-accent focus:outline-none"
        />
      </fieldset>

      {state.error && <p className="text-sm text-status-error">{state.error}</p>}

      <button
        type="submit"
        disabled={!canContinue || isPending}
        className="w-full rounded-md bg-accent px-4 py-2 text-base text-white hover:bg-accent-hover disabled:opacity-60"
      >
        {isPending ? 'Continuing…' : 'Continue'}
      </button>
    </form>
  );
}

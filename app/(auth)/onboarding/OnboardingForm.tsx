'use client';

import { useActionState, useState } from 'react';
import { cn } from '@/lib/cn';
import type { LicenseMode } from '@/lib/schemas/onboarding';
import { Button } from '@/app/components/ui/button';
import { submitOnboarding } from './actions';
import { initialOnboardingFormState } from './onboarding-form-state';

const DEFAULT_BOOKS_BEGIN_DATE = '2026-04-01';

const INPUT_CLASSES =
  'w-full rounded-lg border border-border bg-background px-4 py-2.5 font-body text-sm text-foreground transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring';

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
        <legend className="text-sm font-medium text-foreground">Your name</legend>
        <p className="text-sm leading-relaxed text-muted-foreground">
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
        <legend className="text-sm font-medium text-foreground">Tally license mode</legend>

        <div className="grid grid-cols-2 gap-3">
          <button
            type="button"
            onClick={() => setLicenseMode('licensed')}
            className={cn(
              'cursor-pointer rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors',
              licenseMode === 'licensed'
                ? 'border-accent bg-accent/5 text-foreground ring-1 ring-ring'
                : 'border-border bg-background text-muted-foreground hover:bg-secondary',
            )}
          >
            Licensed Tally
          </button>
          <button
            type="button"
            onClick={() => setLicenseMode('educational')}
            className={cn(
              'cursor-pointer rounded-lg border px-4 py-3 text-left text-sm font-medium transition-colors',
              licenseMode === 'educational'
                ? 'border-accent bg-accent/5 text-foreground ring-1 ring-ring'
                : 'border-border bg-background text-muted-foreground hover:bg-secondary',
            )}
          >
            Educational Mode
          </button>
        </div>

        {licenseMode === 'educational' && (
          <p className="text-sm leading-relaxed text-muted-foreground">
            In Educational Mode, Tally restricts voucher entry to the 1st, 2nd, and last day of
            any month.
          </p>
        )}

        <input type="hidden" name="license_mode" value={licenseMode ?? ''} />
      </fieldset>

      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium text-foreground">Books Begin Date</legend>

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

      <Button type="submit" disabled={!canContinue || isPending} className="w-full">
        {isPending ? 'Continuing…' : 'Continue'}
      </Button>
    </form>
  );
}

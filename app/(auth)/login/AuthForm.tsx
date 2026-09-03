'use client';

import { useActionState, useState } from 'react';
import { logIn, signUp } from './actions';
import { initialAuthFormState } from './auth-form-state';

type Mode = 'log-in' | 'sign-up';

/**
 * Sign in and sign up are one form in two modes. Everything that differs
 * between them — heading, blurb, submit label, the link to the other mode —
 * is declared here rather than branched inline, so neither mode can quietly
 * inherit the other's copy.
 */
const COPY: Record<
  Mode,
  {
    heading: React.ReactNode;
    blurb: string;
    submit: string;
    pending: string;
    switchTo: string;
  }
> = {
  'log-in': {
    heading: (
      <>
        Welcome <em>back</em>
      </>
    ),
    blurb: 'Sign in to pick up your next batch where you left it.',
    submit: 'Sign in',
    pending: 'Signing in…',
    switchTo: 'New here? Create an account',
  },
  'sign-up': {
    heading: (
      <>
        Start your <em>first</em> batch
      </>
    ),
    blurb:
      'Create an account and your diagnostic exercise is ready to work in Tally.',
    submit: 'Create account',
    pending: 'Creating account…',
    switchTo: 'Already have an account? Sign in',
  },
};

const INPUT_CLASSES =
  'night-input w-full rounded-lg px-4 py-3 font-body text-sm';

const SUBMIT_CLASSES =
  'night-btn night-btn-solid mt-1 inline-flex h-11 w-full cursor-pointer items-center justify-center rounded-md font-body text-sm font-medium tracking-tight disabled:cursor-not-allowed';

export function AuthForm() {
  const [mode, setMode] = useState<Mode>('log-in');
  const action = mode === 'log-in' ? logIn : signUp;
  const [state, formAction, isPending] = useActionState(action, initialAuthFormState);

  // Sign-up succeeded: the account exists but the auto-session was ended
  // server-side, so flip straight to the login form (guarded render-time
  // state adjustment) and confirm what just happened above it.
  if (state.accountCreated && mode !== 'log-in') {
    setMode('log-in');
  }

  if (state.confirmEmailSent) {
    return (
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="night-title font-body text-white">
          Check your <em>email</em>
        </h1>
        <p className="night-muted font-body text-sm leading-relaxed">
          Confirm your account by clicking the link we sent you.
        </p>
      </div>
    );
  }

  const copy = COPY[mode];

  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <h1 className="night-title font-body text-white">{copy.heading}</h1>
        <p className="night-muted mt-2 font-body text-sm leading-relaxed">{copy.blurb}</p>
      </div>

      {state.accountCreated && (
        <p className="rounded-lg border border-white/15 bg-white/5 px-4 py-3 font-body text-sm leading-relaxed text-white">
          Account created. Sign in below with the email and password you just chose.
        </p>
      )}

      <form action={formAction} className="flex flex-col gap-3">
        <label htmlFor="email" className="sr-only">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          required
          placeholder="you@example.com"
          autoComplete="email"
          className={INPUT_CLASSES}
        />

        <label htmlFor="password" className="sr-only">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          required
          minLength={6}
          placeholder="Password"
          autoComplete={mode === 'log-in' ? 'current-password' : 'new-password'}
          className={INPUT_CLASSES}
        />

        {state.error && (
          <p className="night-error font-body text-sm">{state.error}</p>
        )}

        <button type="submit" disabled={isPending} className={SUBMIT_CLASSES}>
          {isPending ? copy.pending : copy.submit}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setMode(mode === 'log-in' ? 'sign-up' : 'log-in')}
        className="cursor-pointer font-body text-sm font-medium text-white transition-opacity hover:opacity-70"
      >
        {copy.switchTo}
      </button>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { useActionState } from 'react';
import { logIn, signUp } from './actions';
import { initialAuthFormState } from './auth-form-state';

export type Mode = 'log-in' | 'sign-up';

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
  'day-input h-12 w-full rounded-2xl px-5 font-nunito text-base';

const SUBMIT_CLASSES =
  'mt-1 inline-flex h-12 w-full cursor-pointer items-center justify-center rounded-full bg-day-blue font-urbanist text-lg text-white transition-colors duration-200 hover:bg-day-blue-hover disabled:cursor-not-allowed disabled:opacity-50';

const NOTICE_CLASSES =
  'rounded-2xl border border-day-line bg-day-card px-4 py-3 font-nunito text-sm leading-relaxed text-day-ink';

/**
 * The mode comes from the URL (`/login` or `/login?mode=signup`), and the page
 * keys this component on it, so each mode mounts with its own fixed action
 * and a fresh action state. Switching modes is a plain link, not local state.
 */
export function AuthForm({
  mode,
  accountCreated,
  callbackError,
}: {
  mode: Mode;
  accountCreated: boolean;
  callbackError: boolean;
}) {
  const action = mode === 'log-in' ? logIn : signUp;
  const [state, formAction, isPending] = useActionState(action, initialAuthFormState);

  if (state.confirmEmailSent) {
    return (
      <div className="flex flex-col items-center gap-2 text-center">
        <h1 className="day-title font-nunito">
          Check your <em>email</em>
        </h1>
        <p className="font-nunito text-base leading-relaxed text-day-muted">
          Confirm your account by clicking the link we sent you.
        </p>
      </div>
    );
  }

  const copy = COPY[mode];

  return (
    <div className="flex flex-col gap-5">
      <div className="text-center">
        <h1 className="day-title font-nunito">{copy.heading}</h1>
        <p className="mt-2 font-nunito text-base leading-relaxed text-day-muted">{copy.blurb}</p>
      </div>

      {/* Sign-up redirects here with `created=1`: the account exists but its
          auto-session was ended server-side, so confirm that above the form. */}
      {accountCreated && mode === 'log-in' && (
        <p className={NOTICE_CLASSES}>
          Account created. Sign in below with the email and password you just chose.
        </p>
      )}

      {/* The auth callback redirects here with `error` when a link fails.
          The copy is fixed: query text is never echoed onto the page. */}
      {callbackError && mode === 'log-in' && (
        <p className={NOTICE_CLASSES}>That sign-in link didn&apos;t work. Sign in below.</p>
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
          <p className="day-error font-nunito text-sm">{state.error}</p>
        )}

        <button type="submit" disabled={isPending} className={SUBMIT_CLASSES}>
          {isPending ? copy.pending : copy.submit}
        </button>
      </form>

      <Link
        href={mode === 'log-in' ? '/login?mode=signup' : '/login'}
        className="cursor-pointer text-center font-urbanist text-base text-day-blue transition-colors duration-200 hover:text-day-blue-hover"
      >
        {copy.switchTo}
      </Link>
    </div>
  );
}

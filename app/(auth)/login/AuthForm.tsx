'use client';

import { useActionState, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { logIn, signUp } from './actions';
import { initialAuthFormState } from './auth-form-state';

type Mode = 'log-in' | 'sign-up';

const INPUT_CLASSES =
  'w-full rounded-lg border border-border bg-background px-4 py-2.5 font-body text-sm text-foreground transition-colors placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-1 focus:ring-ring';

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
      <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-background/80 px-6 py-8 text-center">
        <p className="font-body text-base font-medium text-foreground">Check your email</p>
        <p className="font-body text-sm leading-relaxed text-muted-foreground">
          Confirm your account by clicking the link we sent you.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {state.accountCreated && (
        <p className="rounded-lg border border-border bg-accent/5 px-4 py-3 font-body text-sm leading-relaxed text-foreground">
          Account created. Log in below with the email and password you just chose.
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

        {state.error && <p className="font-body text-sm text-status-error">{state.error}</p>}

        <Button type="submit" disabled={isPending} className="mt-1 w-full">
          {isPending
            ? mode === 'log-in'
              ? 'Logging in…'
              : 'Signing up…'
            : mode === 'log-in'
              ? 'Log in'
              : 'Sign up'}
        </Button>
      </form>

      <button
        type="button"
        onClick={() => setMode(mode === 'log-in' ? 'sign-up' : 'log-in')}
        className="cursor-pointer font-body text-sm font-medium text-accent transition-opacity hover:opacity-70"
      >
        {mode === 'log-in'
          ? "Don't have an account? Sign up"
          : 'Already have an account? Log in'}
      </button>
    </div>
  );
}

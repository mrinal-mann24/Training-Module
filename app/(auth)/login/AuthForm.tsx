'use client';

import { useActionState, useState } from 'react';
import { logIn, signUp } from './actions';
import { initialAuthFormState } from './auth-form-state';

type Mode = 'log-in' | 'sign-up';

export function AuthForm() {
  const [mode, setMode] = useState<Mode>('log-in');
  const action = mode === 'log-in' ? logIn : signUp;
  const [state, formAction, isPending] = useActionState(action, initialAuthFormState);

  if (state.confirmEmailSent) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-md border border-border-default bg-bg-surface px-4 py-6 text-center">
        <p className="text-base text-text-primary">Check your email</p>
        <p className="text-sm text-text-secondary">
          Confirm your account by clicking the link we sent you.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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
          className="w-full rounded-md border border-border-default bg-bg-canvas px-3 py-2 text-base text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
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
          className="w-full rounded-md border border-border-default bg-bg-canvas px-3 py-2 text-base text-text-primary placeholder:text-text-muted focus:border-accent focus:outline-none"
        />

        {state.error && <p className="text-sm text-status-error">{state.error}</p>}

        <button
          type="submit"
          disabled={isPending}
          className="w-full rounded-md bg-accent px-4 py-2 text-base text-white hover:bg-accent-hover disabled:opacity-60"
        >
          {isPending
            ? mode === 'log-in'
              ? 'Logging in…'
              : 'Signing up…'
            : mode === 'log-in'
              ? 'Log in'
              : 'Sign up'}
        </button>
      </form>

      <button
        type="button"
        onClick={() => setMode(mode === 'log-in' ? 'sign-up' : 'log-in')}
        className="text-sm text-accent hover:text-accent-hover"
      >
        {mode === 'log-in'
          ? "Don't have an account? Sign up"
          : 'Already have an account? Log in'}
      </button>
    </div>
  );
}

'use client';

import { useActionState, useState } from 'react';
import { logIn, signUp } from './actions';
import { initialAuthFormState } from './auth-form-state';

type Mode = 'log-in' | 'sign-up';

const INPUT_CLASSES =
  'w-full rounded-2xl border border-white/80 bg-white/75 px-5 py-3.5 font-sans text-base text-wandor-text shadow-[0_0_2px_0_rgba(0,0,0,0.05)] backdrop-blur-[14px] transition-colors placeholder:text-wandor-muted focus:border-wandor-dark focus:outline-none';

export function AuthForm() {
  const [mode, setMode] = useState<Mode>('log-in');
  const action = mode === 'log-in' ? logIn : signUp;
  const [state, formAction, isPending] = useActionState(action, initialAuthFormState);

  if (state.confirmEmailSent) {
    return (
      <div className="flex flex-col items-center gap-3 rounded-[28px] border-2 border-white bg-white/70 px-6 py-8 text-center backdrop-blur-[14px]">
        <p className="text-base font-medium text-wandor-text">Check your email</p>
        <p className="text-sm leading-relaxed text-wandor-muted">
          Confirm your account by clicking the link we sent you.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
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

        {state.error && <p className="text-sm text-status-error">{state.error}</p>}

        <button
          type="submit"
          disabled={isPending}
          className="mt-1 w-full cursor-pointer rounded-full bg-wandor-dark px-5 py-3.5 font-sans text-[15px] font-medium uppercase tracking-[0.04em] text-[#fafafa] transition-all hover:bg-[#333] active:scale-95 disabled:opacity-60 disabled:active:scale-100"
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
        className="cursor-pointer text-sm font-medium text-wandor-prompt transition-opacity hover:opacity-70"
      >
        {mode === 'log-in'
          ? "Don't have an account? Sign up"
          : 'Already have an account? Log in'}
      </button>
    </div>
  );
}

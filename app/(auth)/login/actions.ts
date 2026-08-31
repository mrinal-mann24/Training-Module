'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import type { AuthFormState } from './auth-form-state';

function readCredentials(formData: FormData): { email: string; password: string } | null {
  const email = formData.get('email');
  const password = formData.get('password');

  if (typeof email !== 'string' || email.trim() === '') {
    return null;
  }
  if (typeof password !== 'string' || password === '') {
    return null;
  }

  return { email, password };
}

export async function logIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const credentials = readCredentials(formData);
  if (!credentials) {
    return { error: 'Enter your email and password.', confirmEmailSent: false, accountCreated: false };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials);

  if (error) {
    return { error: error.message, confirmEmailSent: false, accountCreated: false };
  }

  redirect('/dashboard');
}

export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const credentials = readCredentials(formData);
  if (!credentials) {
    return { error: 'Enter your email and password.', confirmEmailSent: false, accountCreated: false };
  }

  const supabase = await createClient();
  const origin = (await headers()).get('origin');

  const { data, error } = await supabase.auth.signUp({
    ...credentials,
    options: {
      emailRedirectTo: `${origin}/auth/callback`,
    },
  });

  if (error) {
    return { error: error.message, confirmEmailSent: false, accountCreated: false };
  }

  // Email confirmation is disabled in Supabase (2026-08-31), so signUp
  // returns a live session. The product flow is signup -> log in explicitly
  // (a clear, teachable login/logout cycle for interns), so end that
  // auto-session immediately and send the learner to the login form.
  if (data.session) {
    await supabase.auth.signOut();
    return { error: null, confirmEmailSent: false, accountCreated: true };
  }

  // Defensive fallback: if email confirmation is ever re-enabled in the
  // Supabase dashboard, signUp returns a user with no session and the
  // learner must click the emailed link instead.
  return { error: null, confirmEmailSent: true, accountCreated: false };
}

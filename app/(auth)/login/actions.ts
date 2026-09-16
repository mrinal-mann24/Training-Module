'use server';

import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { CredentialsInputSchema, type CredentialsInput } from '@/lib/schemas/auth';
import type { AuthFormState } from './auth-form-state';

// Parsed before any Supabase call; both actions answer a null here with the
// same "Enter your email and password." message.
function readCredentials(formData: FormData): CredentialsInput | null {
  const parsed = CredentialsInputSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  return parsed.success ? parsed.data : null;
}

export async function logIn(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const credentials = readCredentials(formData);
  if (!credentials) {
    return { error: 'Enter your email and password.', confirmEmailSent: false };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(credentials);

  if (error) {
    return { error: error.message, confirmEmailSent: false };
  }

  redirect('/dashboard');
}

export async function signUp(
  _prevState: AuthFormState,
  formData: FormData,
): Promise<AuthFormState> {
  const credentials = readCredentials(formData);
  if (!credentials) {
    return { error: 'Enter your email and password.', confirmEmailSent: false };
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
    return { error: error.message, confirmEmailSent: false };
  }

  // Email confirmation is disabled in Supabase (2026-08-31), so signUp
  // returns a live session. The product flow is signup -> log in explicitly
  // (a clear, teachable login/logout cycle for interns), so end that
  // auto-session immediately and send the learner to the login form. The
  // redirect carries `created=1` so the page confirms what just happened; it
  // throws, so it must stay outside any try/catch.
  if (data.session) {
    await supabase.auth.signOut();
    redirect('/login?created=1');
  }

  // Defensive fallback: if email confirmation is ever re-enabled in the
  // Supabase dashboard, signUp returns a user with no session and the
  // learner must click the emailed link instead.
  return { error: null, confirmEmailSent: true };
}

// Used by the dashboard and chat headers. Lives beside logIn/signUp so the
// whole session lifecycle is in one place.
export async function logOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}

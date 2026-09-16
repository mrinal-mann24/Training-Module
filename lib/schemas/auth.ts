import { z } from 'zod';

// Input boundary for the logIn and signUp Server Actions
// (app/(auth)/login/actions.ts). Mirrors the original check: an email that is
// not blank once trimmed, and a non-empty password. Neither value is
// transformed; Supabase Auth receives them exactly as typed.
//
// ASSUMPTION: both caps are new. 320 characters is the common upper bound
// for an address (64-character local part, @, 255-character domain), and
// 1024 is far past any real password.
export const EMAIL_MAX_LENGTH = 320;
export const PASSWORD_MAX_LENGTH = 1024;

export const CredentialsInputSchema = z.object({
  email: z
    .string()
    .max(EMAIL_MAX_LENGTH)
    .refine((value) => value.trim() !== ''),
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type CredentialsInput = z.infer<typeof CredentialsInputSchema>;

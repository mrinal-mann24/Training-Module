import { describe, expect, it } from 'vitest';
import { CredentialsInputSchema, EMAIL_MAX_LENGTH, PASSWORD_MAX_LENGTH } from './auth';

describe('CredentialsInputSchema', () => {
  it('passes the email and password through exactly as typed', () => {
    const result = CredentialsInputSchema.safeParse({ email: ' asha@example.com ', password: ' secret ' });

    expect(result.success).toBe(true);
    expect(result.data).toEqual({ email: ' asha@example.com ', password: ' secret ' });
  });

  it('accepts a password made only of spaces, as the original check did', () => {
    expect(CredentialsInputSchema.safeParse({ email: 'asha@example.com', password: '   ' }).success).toBe(true);
  });

  it.each([
    ['a missing email', { email: null, password: 'secret' }],
    ['a blank email', { email: '   ', password: 'secret' }],
    ['a file in place of the email', { email: new File(['x'], 'email.txt'), password: 'secret' }],
    ['a missing password', { email: 'asha@example.com', password: null }],
    ['an empty password', { email: 'asha@example.com', password: '' }],
  ])('rejects %s', (_label, input) => {
    expect(CredentialsInputSchema.safeParse(input).success).toBe(false);
  });

  it('caps the email and password length', () => {
    const domain = '@example.com';
    const longestEmail = `${'a'.repeat(EMAIL_MAX_LENGTH - domain.length)}${domain}`;

    expect(CredentialsInputSchema.safeParse({ email: longestEmail, password: 'secret' }).success).toBe(true);
    expect(CredentialsInputSchema.safeParse({ email: `a${longestEmail}`, password: 'secret' }).success).toBe(false);
    expect(
      CredentialsInputSchema.safeParse({ email: 'asha@example.com', password: 'p'.repeat(PASSWORD_MAX_LENGTH) }).success,
    ).toBe(true);
    expect(
      CredentialsInputSchema.safeParse({ email: 'asha@example.com', password: 'p'.repeat(PASSWORD_MAX_LENGTH + 1) }).success,
    ).toBe(false);
  });
});

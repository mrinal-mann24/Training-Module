export type AuthFormState = {
  error: string | null;
  confirmEmailSent: boolean;
  // Sign-up succeeded (email confirmation disabled): the account exists and
  // the learner should now log in with the credentials they just chose.
  accountCreated: boolean;
};

export const initialAuthFormState: AuthFormState = {
  error: null,
  confirmEmailSent: false,
  accountCreated: false,
};

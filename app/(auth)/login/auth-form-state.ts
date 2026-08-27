export type AuthFormState = {
  error: string | null;
  confirmEmailSent: boolean;
};

export const initialAuthFormState: AuthFormState = {
  error: null,
  confirmEmailSent: false,
};

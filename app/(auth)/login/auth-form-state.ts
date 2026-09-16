// A successful sign-up is not form state: the action redirects to
// /login?created=1 and the page reads that flag from the URL.
export type AuthFormState = {
  error: string | null;
  confirmEmailSent: boolean;
};

export const initialAuthFormState: AuthFormState = {
  error: null,
  confirmEmailSent: false,
};

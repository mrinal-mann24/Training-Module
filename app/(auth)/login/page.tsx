import { AuthForm } from './AuthForm';

/**
 * Sign in and sign up share this route. The heading and blurb change with the
 * mode, so they live inside `AuthForm` alongside the state that switches
 * them; this page is only the frosted card they sit in.
 */
export default function LoginPage() {
  return (
    <div className="night-card w-full max-w-md rounded-2xl p-8 backdrop-blur-xl max-md:p-6">
      <AuthForm />
    </div>
  );
}

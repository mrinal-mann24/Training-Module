import { AuthForm } from './AuthForm';

/**
 * Sign in and sign up share this route. The heading and blurb change with the
 * mode, so they live inside `AuthForm` alongside the state that switches
 * them; this page is only the card they sit in: the landing page's grey
 * shell with a white panel inside.
 */
export default function LoginPage() {
  return (
    <div className="w-full max-w-md rounded-card border border-day-line bg-day-card p-2.5">
      <div className="rounded-panel bg-white p-8 max-md:p-6">
        <AuthForm />
      </div>
    </div>
  );
}

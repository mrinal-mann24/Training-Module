import { AuthForm, type Mode } from './AuthForm';

// The real sign-up flow, in order: this form, then onboarding, then the
// dashboard with the first batch. Nothing here is a claim the product can't keep.
const SIGN_UP_STEPS = [
  'Create your account',
  'Tell us your background',
  'Your first batch opens, ready to work in Tally',
] as const;

/**
 * Sign in and sign up share this route, and the mode lives in the URL:
 * `/login` signs in, `/login?mode=signup` signs up. The heading and blurb
 * change with the mode, so they live inside `AuthForm`; this page picks the
 * card they sit in, keyed on the mode so each one mounts with fresh form state.
 *
 * - Sign in: the compact card, the landing page's grey shell with a white
 *   panel inside.
 * - Sign up: the same shell, wider, with a graph-paper panel beside the form
 *   listing what happens next.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{
    mode?: string | string[];
    created?: string | string[];
    error?: string | string[];
  }>;
}) {
  const params = await searchParams;
  const mode: Mode = params.mode === 'signup' ? 'sign-up' : 'log-in';
  // Set by the signUp action's redirect after the account is created.
  const created = params.created === '1';
  // Set by /auth/callback when a sign-in link fails. Only its presence is
  // read; the text itself is never rendered.
  const callbackError = params.error !== undefined;

  const form = (
    <AuthForm key={mode} mode={mode} accountCreated={created} callbackError={callbackError} />
  );

  if (mode === 'log-in') {
    return (
      <div className="w-full max-w-md rounded-card border border-day-line bg-day-card p-2.5">
        <div className="rounded-panel bg-white p-8 max-md:p-6">{form}</div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-3xl rounded-card border border-day-line bg-day-card p-2.5">
      <div className="grid gap-2.5 md:grid-cols-2">
        <section
          aria-label="What happens next"
          className="day-grid-paper rounded-panel border border-day-line p-8 max-md:p-6"
        >
          <span className="inline-flex rounded-full bg-day-blue px-4 py-1.5 font-urbanist text-sm text-white">
            New account
          </span>
          <p className="mt-4 font-nunito text-base leading-relaxed text-day-muted max-md:mt-3">
            Three steps from here to your first exercise.
          </p>
          <ol className="mt-6 flex flex-col gap-4 max-md:mt-4 max-md:gap-3">
            {SIGN_UP_STEPS.map((step, index) => (
              <li key={step} className="flex items-center gap-4 max-md:gap-3">
                <span className="day-disc inline-flex size-10 shrink-0 items-center justify-center rounded-full font-urbanist text-lg text-day-ink">
                  {index + 1}
                </span>
                <span className="font-nunito text-base leading-snug text-day-ink">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="rounded-panel bg-white p-8 max-md:p-6">{form}</div>
      </div>
    </div>
  );
}

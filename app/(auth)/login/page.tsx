import { AuthForm } from './AuthForm';

export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-bg-canvas px-4">
      <div className="w-full max-w-sm rounded-xl border border-border-default bg-bg-surface-raised p-8">
        <h1 className="mb-6 text-center text-xl text-text-primary">
          Log in to AI Tutor
        </h1>

        <AuthForm />
      </div>
    </main>
  );
}

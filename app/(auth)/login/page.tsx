import { AuthForm } from './AuthForm';

export default function LoginPage() {
  return (
    <div
      className="w-full max-w-md rounded-2xl p-8 backdrop-blur-xl max-md:p-6"
      style={{
        background: 'rgba(255, 255, 255, 0.7)',
        border: '1px solid rgba(255, 255, 255, 0.5)',
        boxShadow: 'var(--shadow-dashboard)',
      }}
    >
      <h1 className="text-center font-display text-4xl leading-tight tracking-tight text-foreground">
        Welcome <em className="italic">back</em>
      </h1>
      <p className="mb-8 mt-2 text-center font-body text-sm leading-relaxed text-muted-foreground">
        Log in or create your account to continue your training.
      </p>

      <AuthForm />
    </div>
  );
}

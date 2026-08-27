import { AuthForm } from './AuthForm';

export default function LoginPage() {
  return (
    <div className="w-full max-w-110 rounded-[44px] border-[3px] border-white bg-white/[0.55] p-10 shadow-[0_0_4px_0_rgba(0,0,0,0.15)] backdrop-blur-[20px] max-md:p-7">
      <h1 className="text-center font-sans text-[28px] font-medium leading-tight tracking-[-0.02em] text-wandor-text">
        Welcome back
      </h1>
      <p className="mb-8 mt-2 text-center text-sm font-medium leading-relaxed text-wandor-muted">
        Log in or create your account to continue your training.
      </p>

      <AuthForm />
    </div>
  );
}

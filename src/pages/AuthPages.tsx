import React, { useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { TopNav } from '../components/TopNav';
import { useApp } from '../context/AppContext';
import { apiFetch, safeJson } from '../utils/api';
import type { UserProfile } from '../types/codebase';

function GitHubSignInOption({ redirectAfter }: { redirectAfter: '/login' | '/signup' }) {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    void apiFetch('/api/auth/github/config')
      .then(async (res) => {
        if (!res.ok) return;
        const data = await safeJson<{ enabled?: boolean }>(res);
        if (active) setEnabled(data.enabled === true);
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  if (!enabled) return null;
  return (
    <div className="space-y-2 border-t border-[#232832] pt-4">
      <a
        href={`/api/auth/github/start?redirect_after=${encodeURIComponent(redirectAfter)}`}
        className="block w-full rounded-md border border-[#3B414D] px-4 py-2 text-center text-xs font-semibold text-[#E6E9EF] hover:border-sky-500 hover:text-sky-300"
      >
        Continue with GitHub
      </a>
      <p className="text-center text-[11px] text-[#9CA3AF]">
        We only read your name, avatar and verified email
      </p>
    </div>
  );
}

function githubErrorMessage(reason: string | null): string | null {
  if (!reason) return null;
  const messages: Record<string, string> = {
    access_denied: 'GitHub authorization was denied.',
    unverified_email: 'Add a primary verified email to your GitHub account, then try again.',
    existing_email: 'That verified email already has an account. Sign in with your password first, then connect GitHub in Settings.',
    expired_attempt: 'That GitHub sign-in attempt expired or could not be verified. Please try again.',
    invalid_code: 'GitHub could not complete sign-in. Please try again.',
    invalid_profile: 'GitHub returned an incomplete profile. Please try again.',
    provider_error: 'GitHub could not complete sign-in. Please try again.',
    pkce_rejected: 'GitHub rejected PKCE for this application. Contact the site administrator.',
    github_account_linked: 'That GitHub account is already connected to another account.',
    github_already_linked: 'A different GitHub account is already connected. Disconnect it first.',
    session_changed: 'Your sign-in session changed. Sign in again before connecting GitHub.',
    private_access_denied: 'GitHub App access was not granted.',
    private_install_failed: 'The GitHub App could not be verified. Try again or contact the site administrator.',
  };
  return messages[reason] ?? 'GitHub could not complete the request. Please try again.';
}

export function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setSession } = useApp();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await safeJson<{ user?: UserProfile; error?: string }>(res);
      if (!res.ok || !json.user) {
        throw new Error(json.error || 'Sign in failed.');
      }
      setSession(json.user);
      navigate('/workspace/dietrichgebert__ponytail');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sign in.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E6E9EF]">
      <TopNav />
      <main className="mx-auto max-w-md px-6 py-16">
        <div className="rounded-xl border border-[#232832] bg-[#111419] p-6 space-y-5">
          <div>
            <h1 className="text-lg font-semibold text-[#F9FAFB]">Sign in to Codebase Tutor</h1>
            <p className="mt-1 text-xs text-[#9CA3AF]">
              Access your workspace preferences and imported repositories.
            </p>
          </div>

          {githubErrorMessage(searchParams.get('github_error')) && (
            <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
              {githubErrorMessage(searchParams.get('github_error'))}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="block text-xs font-medium text-[#D1D5DB]">
                Email
              </label>
              <input
                id="login-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3 py-2 text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="login-password" className="block text-xs font-medium text-[#D1D5DB]">
                Password
              </label>
              <input
                id="login-password"
                type="password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3 py-2 text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
              />
            </div>

            {error && (
              <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-sky-500 px-4 py-2 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Signing in...' : 'Sign in'}
            </button>
          </form>

          <GitHubSignInOption redirectAfter="/login" />

          <p className="text-center text-xs text-[#9CA3AF]">
            New to Codebase Tutor?{' '}
            <Link to="/signup" className="text-sky-400 hover:text-sky-300">
              Create an account
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

export function SignupPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { setSession } = useApp();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('Student');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await apiFetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, role, password }),
      });
      const json = await safeJson<{ user?: UserProfile; error?: string }>(res);
      if (!res.ok || !json.user) {
        throw new Error(json.error || 'Registration failed.');
      }
      setSession(json.user);
      navigate('/workspace/dietrichgebert__ponytail');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create account.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E6E9EF]">
      <TopNav />
      <main className="mx-auto max-w-md px-6 py-16">
        <div className="rounded-xl border border-[#232832] bg-[#111419] p-6 space-y-5">
          <div>
            <h1 className="text-lg font-semibold text-[#F9FAFB]">Create a Codebase Tutor account</h1>
            <p className="mt-1 text-xs text-[#9CA3AF]">
              Save your learning workspace preferences.
            </p>
          </div>

          {githubErrorMessage(searchParams.get('github_error')) && (
            <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
              {githubErrorMessage(searchParams.get('github_error'))}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <label htmlFor="signup-name" className="block text-xs font-medium text-[#D1D5DB]">
                Full name
              </label>
              <input
                id="signup-name"
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Alex Rivera"
                className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3 py-2 text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="signup-email" className="block text-xs font-medium text-[#D1D5DB]">
                Email
              </label>
              <input
                id="signup-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="alex@university.edu"
                className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3 py-2 text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
              />
            </div>

            <div className="space-y-1.5">
              <label htmlFor="signup-role" className="block text-xs font-medium text-[#D1D5DB]">
                Role
              </label>
              <select
                id="signup-role"
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3 py-2 text-xs text-[#E6E9EF] focus:border-sky-500 focus:outline-none"
              >
                <option value="Student">Student</option>
                <option value="Software Engineer">Software Engineer</option>
                <option value="Educator">Educator</option>
                <option value="Open Source Contributor">Open Source Contributor</option>
              </select>
            </div>

            <div className="space-y-1.5">
              <label htmlFor="signup-password" className="block text-xs font-medium text-[#D1D5DB]">
                Password (min 12 characters)
              </label>
              <input
                id="signup-password"
                type="password"
                required
                minLength={12}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3 py-2 text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
              />
            </div>

            {error && (
              <div className="rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-md bg-sky-500 px-4 py-2 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 disabled:opacity-50 cursor-pointer"
            >
              {loading ? 'Creating account...' : 'Create account'}
            </button>
          </form>

          <GitHubSignInOption redirectAfter="/signup" />

          <p className="text-center text-xs text-[#9CA3AF]">
            Already have an account?{' '}
            <Link to="/login" className="text-sky-400 hover:text-sky-300">
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}

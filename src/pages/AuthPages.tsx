import React, { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { TopNav } from '../components/TopNav';
import { useApp } from '../context/AppContext';
import { safeJson } from '../utils/api';
import type { UserProfile } from '../types/codebase';

export function LoginPage() {
  const navigate = useNavigate();
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
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const json = await safeJson<{ token?: string; user?: UserProfile; error?: string }>(res);
      if (!res.ok || !json.token || !json.user) {
        throw new Error(json.error || 'Sign in failed.');
      }
      setSession(json.user, json.token);
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
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, role, password }),
      });
      const json = await safeJson<{ token?: string; user?: UserProfile; error?: string }>(res);
      if (!res.ok || !json.token || !json.user) {
        throw new Error(json.error || 'Registration failed.');
      }
      setSession(json.user, json.token);
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
                Password (min 6 characters)
              </label>
              <input
                id="signup-password"
                type="password"
                required
                minLength={6}
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

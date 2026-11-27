import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowRight,
  RefreshCw,
  CheckCircle2,
  AlertCircle,
  Loader2,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { TopNav } from '../components/TopNav';
import { useApp } from '../context/AppContext';
import { apiFetch, safeJson } from '../utils/api';
import type { AnalysisStage, RepositoryRecord } from '../types/codebase';

const STAGE_STEPS: { stage: AnalysisStage; label: string }[] = [
  { stage: 'validating', label: 'Validating repository' },
  { stage: 'fetching', label: 'Fetching repository metadata' },
  { stage: 'reading_tree', label: 'Reading file structure' },
  { stage: 'detecting_stack', label: 'Detecting languages and frameworks' },
  { stage: 'detecting_entrypoints', label: 'Identifying entry points' },
  { stage: 'extracting_symbols', label: 'Extracting functions and classes' },
  { stage: 'building_graph', label: 'Building knowledge graph' },
  { stage: 'generating_diagrams', label: 'Generating architecture and diagrams' },
];

export function LandingPage() {
  const navigate = useNavigate();
  const { user } = useApp();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const [repoUrl, setRepoUrl] = useState('');
  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [activeImport, setActiveImport] = useState<RepositoryRecord | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchRepositories = useCallback(async () => {
    try {
      const res = await apiFetch('/api/repositories');
      if (res.ok) {
        const json = await safeJson<{ repositories: RepositoryRecord[] }>(res);
        setRepositories(json.repositories);
      }
    } catch {
      // ignore transient error
    }
  }, []);

  useEffect(() => {
    void fetchRepositories();
    const timer = setInterval(() => {
      void fetchRepositories();
    }, 1800);
    return () => clearInterval(timer);
  }, [fetchRepositories]);

  // Poll active import progress until ready or error
  useEffect(() => {
    if (!activeImport || activeImport.stage === 'ready' || activeImport.stage === 'error') return;
    const timer = setInterval(async () => {
      try {
        const res = await apiFetch(`/api/repositories/${encodeURIComponent(activeImport.id)}/analysis`);
        if (res.ok) {
          const json = await safeJson<{ repository: RepositoryRecord }>(res);
          setActiveImport(json.repository);
          if (json.repository.stage === 'ready') {
            navigate(`/workspace/${encodeURIComponent(json.repository.id)}`);
          }
        }
      } catch {
        // ignore transient poll error
      }
    }, 900);
    return () => clearInterval(timer);
  }, [activeImport, navigate]);

  const handleAnalyzeSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    if (!user) {
      navigate('/login');
      return;
    }
    const trimmed = repoUrl.trim();
    if (!trimmed) {
      setSubmitError('Enter a GitHub URL such as https://github.com/DietrichGebert/ponytail');
      return;
    }
    setSubmitting(true);
    try {
      const res = await apiFetch('/api/repositories/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: trimmed }),
      });
      const json = await safeJson<{ repository?: RepositoryRecord; error?: string }>(res);
      if (!res.ok || !json.repository) {
        throw new Error(json.error || 'Failed to start repository analysis.');
      }
      setActiveImport(json.repository);
      if (json.repository.stage === 'ready') {
        navigate(`/workspace/${encodeURIComponent(json.repository.id)}`);
      }
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : 'Unable to import repository.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleExploreDemo = (repo: RepositoryRecord) => {
    if (repo.stage === 'error') {
      setSubmitError('The featured demo is currently unavailable. Please try again later.');
    } else {
      navigate(`/workspace/${encodeURIComponent(repo.id)}`);
    }
  };

  const ponytail = repositories.find((r) => r.isFeaturedDemo);
  const otherRepos = repositories.filter((r) => !r.isFeaturedDemo);

  const currentStageIndex = activeImport
    ? STAGE_STEPS.findIndex((s) => s.stage === activeImport.stage)
    : -1;

  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E6E9EF]">
      <TopNav />

      {!user ? (
        <main className="guest-main flex min-h-[calc(100vh-3.5rem)] items-center justify-center px-6 py-6">
          <section className="guest-landing-card w-full max-w-[475px] rounded-[2rem] border border-[#C4DCE8] px-7 py-5 text-center sm:px-9">
            <div className="flex flex-col items-center">
              <img src="/brand/plupus-logo.png" alt="" className="brand-octopus h-7 w-9" />
              <h1 className="brand-wordmark text-[1.75rem] leading-none">PLUPUS</h1>
              <p className="mt-1 text-[13px] text-[#526D7C]">Interactive Codebase Understanding</p>
            </div>

            <Link to="/login" className="guest-sign-in mt-6 inline-flex rounded-full border border-[#B8D3E0] px-4 py-1 text-[13px] text-[#172D3A]">
              Sign in
            </Link>

            <div className="guest-demo-card mt-4 rounded-[1.75rem] border border-white/60 px-5 py-4 text-left sm:px-6">
              <h2 className="text-[13px] font-semibold text-[#172D3A]">Try Plupus on a real repository</h2>
              <p className="mt-1.5 truncate text-[11px] font-semibold text-[#263F4D]">
                ponytail · github.com/DietrichGebert/ponytail ·{' '}
                {ponytail?.stage === 'ready'
                  ? `Ready (commit ${ponytail.commitSha.slice(0, 7)})`
                  : ponytail?.stage === 'error'
                    ? 'Temporarily unavailable'
                    : 'Preparing demo'}
              </p>
              <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-[#526D7C]">
                {ponytail?.overview?.summary ||
                  ponytail?.description ||
                  'Explore a real open-source codebase with interactive diagrams, connected source code, and guided explanations.'}
              </p>
              {submitError && <p className="mt-2 text-xs text-rose-700">{submitError}</p>}
              <div className="mt-2 flex justify-end">
                <button
                  type="button"
                  onClick={() => ponytail ? handleExploreDemo(ponytail) : navigate('/workspace/dietrichgebert__ponytail')}
                  className="guest-explore-button rounded-full border border-[#B8D3E0] px-3 py-0.5 text-[10px] text-[#172D3A]"
                >
                  Explore Repository
                </button>
              </div>
            </div>
          </section>
        </main>
      ) : (
      <main className="mx-auto max-w-[1200px] px-6 py-16 space-y-20">
        {/* Hero + Importer */}
        <section className="grid grid-cols-1 gap-12 lg:grid-cols-12 lg:items-start">
          <div className="lg:col-span-7 space-y-6">
            <p className="text-xs font-medium text-sky-400">
              PLUPUS · Interactive Codebase Understanding
            </p>
            <h1
              className="brand-wordmark text-4xl font-normal tracking-tight sm:text-5xl leading-[1.12]"
              style={{ textWrap: 'balance' }}
            >
              Understand any codebase. Not just read it.
            </h1>
            <p className="max-w-2xl text-base leading-relaxed text-[#9CA3AF]">
              Explore real-world repositories through interactive architecture maps, connected source code, execution flows, and context-aware explanations grounded in actual files and line numbers.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="button"
                onClick={() => {
                  if (user) inputRef.current?.focus();
                  else navigate('/login');
                }}
                className="inline-flex items-center gap-2 rounded-md bg-sky-500 px-4 py-2.5 text-sm font-semibold text-[#0B0D10] hover:bg-sky-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Explore a repository</span>
                <ArrowRight className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  if (ponytail) {
                    handleExploreDemo(ponytail);
                  } else {
                    setSubmitError('The featured demo is currently unavailable. Please try again later.');
                  }
                }}
                className="inline-flex items-center gap-2 rounded-md border border-[#232832] bg-[#141820] px-4 py-2.5 text-sm font-medium text-[#E6E9EF] hover:border-[#3A4354] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <span>Try the demo</span>
              </button>
            </div>
          </div>

          {/* Repository Importer Card */}
          <div className="lg:col-span-5 rounded-xl border border-[#232832] bg-[#111419] p-6 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-[#F3F4F6]">Import a GitHub repository</h2>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                Static analysis runs safely on the server without executing repository code.{' '}
                <Link to="/settings" className="text-sky-400 hover:text-sky-300">
                  {user ? 'Configure GitHub access for private repos' : 'Log in to import repositories'}
                </Link>
              </p>
            </div>

            <form onSubmit={handleAnalyzeSubmit} className="space-y-3">
              <div>
                <label htmlFor="github-url" className="sr-only">
                  GitHub Repository URL
                </label>
                <input
                  ref={inputRef}
                  id="github-url"
                  type="text"
                  value={repoUrl}
                  onChange={(e) => setRepoUrl(e.target.value)}
                  disabled={!user}
                  placeholder="https://github.com/username/repository or owner/repository"
                  className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3.5 py-2.5 font-mono text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
                />
              </div>

              <button
                type="submit"
                disabled={submitting || !user}
                className="flex w-full items-center justify-center gap-2 rounded-md bg-[#F3F4F6] px-4 py-2 text-xs font-semibold text-[#0B0D10] hover:bg-white disabled:opacity-50 transition-colors cursor-pointer"
              >
                {submitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>Starting analysis...</span>
                  </>
                ) : (
                  <span>Analyze repository</span>
                )}
              </button>
            </form>

            {!user && (
              <p className="text-xs text-[#9CA3AF]">
                <Link to="/login" className="text-sky-400 hover:text-sky-300">
                  Log in
                </Link>{' '}
                to analyze your own repositories.
              </p>
            )}

            {submitError && (
              <div className="flex items-start gap-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
                <span>{submitError}</span>
              </div>
            )}

            {/* Real Analysis Progress Tracker */}
            {activeImport && (
              <div className="border-t border-[#232832] pt-4 space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="font-mono font-medium text-[#E6E9EF] truncate">
                    {activeImport.fullName}
                  </span>
                  <span className="font-mono tabular-nums text-sky-400">
                    {activeImport.progress}%
                  </span>
                </div>

                {activeImport.stage === 'error' ? (
                  <div className="space-y-2 rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                    <p>{activeImport.error || activeImport.stageMessage}</p>
                    <button
                      type="button"
                      onClick={() => {
                        setRepoUrl(activeImport.url);
                        setActiveImport(null);
                      }}
                      className="inline-flex items-center gap-1 text-xs font-medium text-[#F3F4F6] underline cursor-pointer"
                    >
                      <RefreshCw className="h-3 w-3" /> Retry
                    </button>
                  </div>
                ) : (
                  <div className="space-y-1.5">
                    {STAGE_STEPS.map((step, idx) => {
                      const isDone =
                        activeImport.stage === 'ready' || (currentStageIndex > idx && currentStageIndex !== -1);
                      const isCurrent = activeImport.stage === step.stage;
                      return (
                        <div key={step.stage} className="flex items-center gap-2 text-xs">
                          {isDone ? (
                            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                          ) : isCurrent ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin text-sky-400 shrink-0" />
                          ) : (
                            <span className="h-3.5 w-3.5 rounded-full border border-[#323947] shrink-0" />
                          )}
                          <span className={isCurrent ? 'text-[#F3F4F6] font-medium' : isDone ? 'text-[#9CA3AF]' : 'text-[#6B7280]'}>
                            {step.label}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        </section>

        {/* Recently Imported Repositories */}
        {otherRepos.length > 0 && (
          <section className="pt-2 space-y-2">
            <div className="text-xs font-medium text-[#9CA3AF]">Your imported repositories</div>
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
              {otherRepos.map((repo) => (
                <div
                  key={repo.id}
                  className="flex items-center justify-between gap-4 rounded-lg border border-[#232832] bg-[#111419] px-4 py-3"
                >
                  <div className="min-w-0">
                    <div className="font-mono text-xs font-semibold text-[#E6E9EF] truncate">
                      {repo.fullName}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#9CA3AF] truncate">
                      {repo.stage === 'ready'
                        ? `${repo.overview?.languages[0]?.name ?? 'Analyzed'} · commit ${repo.commitSha.slice(0, 7)}`
                        : repo.stageMessage}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => navigate(`/workspace/${encodeURIComponent(repo.id)}`)}
                    className="rounded border border-[#232832] bg-[#161A21] px-3 py-1.5 text-xs font-medium text-[#E6E9EF] hover:border-sky-500/50 cursor-pointer shrink-0"
                  >
                    Open
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>
      )}
    </div>
  );
}

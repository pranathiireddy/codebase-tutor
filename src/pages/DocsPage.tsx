import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ArrowRight,
  Code2,
  ExternalLink,
  GitBranch,
  Layers,
  MessageSquare,
} from 'lucide-react';
import { TopNav } from '../components/TopNav';
import { apiFetch, safeJson } from '../utils/api';
import type { RepositoryRecord } from '../types/codebase';

function FeaturedRepositoryGuide() {
  const navigate = useNavigate();
  const [ponytail, setPonytail] = useState<RepositoryRecord | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    const loadFeaturedRepository = async () => {
      try {
        const res = await apiFetch('/api/repositories');
        if (!res.ok) {
          throw new Error('Unable to load the featured repository.');
        }
        const json = await safeJson<{ repositories: RepositoryRecord[] }>(res);
        const repository = json.repositories.find((repo) => repo.isFeaturedDemo) ?? null;
        if (isMounted) {
          setPonytail(repository);
          setLoadError(repository ? null : 'The featured repository is not available.');
        }
      } catch (error) {
        if (isMounted) {
          setLoadError(error instanceof Error ? error.message : 'Unable to load the featured repository.');
        }
      }
    };

    void loadFeaturedRepository();
    return () => {
      isMounted = false;
    };
  }, []);

  const handleExploreDemo = () => {
    if (ponytail?.stage === 'error') {
      setLoadError('The featured demo is currently unavailable. Please try again later.');
      return;
    }
    navigate(`/workspace/${encodeURIComponent(ponytail?.id ?? 'dietrichgebert__ponytail')}`);
  };

  return (
    <section id="guide" className="scroll-mt-24 space-y-4">
      <div className="flex items-baseline justify-between gap-4 border-b border-[#232832] pb-3">
        <div>
          <h2 className="text-lg font-semibold text-[#F3F4F6]">
            Try Plupus on a real repository
          </h2>
          <p className="mt-0.5 text-xs text-[#9CA3AF]">
            Featured repository analyzed through the exact same generic ingestion and knowledge graph pipeline.
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-[#232832] bg-[#111419] p-6">
        <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between">
          <div className="max-w-3xl space-y-2.5">
            <div className="flex flex-wrap items-center gap-3">
              <h3 className="font-mono text-base font-semibold text-[#F9FAFB]">
                {ponytail?.name ?? 'ponytail'}
              </h3>
              <span className="text-xs text-[#6B7280]">·</span>
              <a
                href="https://github.com/DietrichGebert/ponytail"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-mono text-xs text-sky-400 hover:text-sky-300"
              >
                <span>github.com/DietrichGebert/ponytail</span>
                <ExternalLink className="h-3 w-3" />
              </a>
              <span className="text-xs text-[#6B7280]">·</span>
              <span className="text-xs text-[#9CA3AF]">
                {ponytail?.stage === 'ready'
                  ? `Ready (commit ${ponytail.commitSha.slice(0, 7)})`
                  : ponytail?.stage === 'error'
                    ? 'Analysis failed'
                    : ponytail?.stageMessage ?? 'Loading featured repository...'}
              </span>
            </div>

            <p className="text-sm leading-relaxed text-[#D1D5DB]">
              {ponytail?.overview?.summary ||
                ponytail?.description ||
                'Retrieving repository description and README summary from GitHub...'}
            </p>

            {ponytail?.overview?.languages && ponytail.overview.languages.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 text-xs text-[#9CA3AF]">
                <span className="text-[#6B7280]">Detected languages:</span>
                {ponytail.overview.languages.slice(0, 5).map((lang, index) => (
                  <span key={lang.name} className="font-mono tabular-nums">
                    {index > 0 && <span className="mr-2 text-[#4B5563]">·</span>}
                    {lang.name} ({lang.percentage}%)
                  </span>
                ))}
              </div>
            )}

            {(loadError || (ponytail?.stage === 'error' && ponytail.error)) && (
              <p className="text-xs text-rose-400">{loadError ?? ponytail?.error}</p>
            )}
          </div>

          <button
            type="button"
            onClick={handleExploreDemo}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md bg-sky-500 px-4 py-2.5 text-sm font-semibold text-[#0B0D10] transition-colors hover:bg-sky-400"
          >
            <span>Explore repository</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-6 border-t border-[#232832] pt-8 md:grid-cols-2 xl:grid-cols-4">
        <div className="space-y-2">
          <GitBranch className="h-4 w-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">Unified Knowledge Graph</h3>
          <p className="text-xs leading-relaxed text-[#9CA3AF]">
            AST and config parsers extract files, functions, classes, imports, and call edges into one canonical graph.
          </p>
        </div>
        <div className="space-y-2">
          <Layers className="h-4 w-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">Six Synchronized Views</h3>
          <p className="text-xs leading-relaxed text-[#9CA3AF]">
            Explore System Architecture, Data Flow, Sequence Diagrams, CI/CD, Deployment, and Class Diagrams from the same model.
          </p>
        </div>
        <div className="space-y-2">
          <Code2 className="h-4 w-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">Read-Only Source Evidence</h3>
          <p className="text-xs leading-relaxed text-[#9CA3AF]">
            Every diagram node, dependency edge, and explanation jumps directly to verified line numbers in the code viewer.
          </p>
        </div>
        <div className="space-y-2">
          <MessageSquare className="h-4 w-4 text-sky-400" />
          <h3 className="text-sm font-semibold text-[#F3F4F6]">Context-Aware Tutor Chat</h3>
          <p className="text-xs leading-relaxed text-[#9CA3AF]">
            Drag code blocks into chat or click a function to ask targeted questions backed by hybrid graph + source retrieval.
          </p>
        </div>
      </div>
    </section>
  );
}

export function DocsPage() {
  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E6E9EF]">
      <TopNav />
      <main className="mx-auto max-w-6xl px-6 py-14 space-y-10">
        <header className="space-y-2 border-b border-[#232832] pb-6">
          <h1 className="text-2xl font-bold text-[#F9FAFB]">Plupus Documentation</h1>
          <p className="text-sm text-[#9CA3AF]">
            How Plupus analyzes unfamiliar repositories, builds a unified knowledge graph, and grounds every explanation in verifiable source code.
          </p>
        </header>

        <FeaturedRepositoryGuide />

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-[#F3F4F6]">1. Evidence before explanations</h2>
          <p className="text-sm leading-relaxed text-[#D1D5DB]">
            Plupus never executes imported repository code and never lets the AI invent architecture from file names alone. Static AST parsers (TypeScript Compiler API for JS/TS/TSX, indentation-aware Python parsing, YAML workflow parsing, and Dockerfile inspection) extract symbols, imports, and call graphs first. Gemini explains only the retrieved evidence and cites exact file paths and line numbers.
          </p>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[#F3F4F6]">2. Confidence levels</h2>
          <div className="divide-y divide-[#232832] rounded-lg border border-[#232832] bg-[#111419]">
            <div className="p-4">
              <div className="text-xs font-semibold text-emerald-400">Verified</div>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                Backed directly by parsed AST declarations, resolved relative imports, manifest entries (e.g. package.json main/bin), or explicit YAML/Docker config keys.
              </p>
            </div>
            <div className="p-4">
              <div className="text-xs font-semibold text-amber-400">Inferred</div>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                Reasonable architectural link derived from symbol name matching or entry-point conventions without an explicit resolved import path.
              </p>
            </div>
            <div className="p-4">
              <div className="text-xs font-semibold text-[#9CA3AF]">Not found / Unavailable</div>
              <p className="mt-1 text-xs text-[#9CA3AF]">
                When a repository contains no CI/CD workflows, no container manifests, or no class definitions, those diagram views honestly report that none exist instead of fabricating nodes.
              </p>
            </div>
          </div>
        </section>

        <section className="space-y-3">
          <h2 className="text-base font-semibold text-[#F3F4F6]">3. Six synchronized diagram views</h2>
          <ul className="space-y-2 text-xs leading-relaxed text-[#D1D5DB] list-disc pl-5">
            <li><strong className="text-[#F3F4F6]">System Architecture:</strong> Entry points, logical modules, APIs, and external package integrations.</li>
            <li><strong className="text-[#F3F4F6]">Data Flow:</strong> Parameter signatures and call transitions across functions and modules.</li>
            <li><strong className="text-[#F3F4F6]">Sequence Diagrams:</strong> Step-by-step execution traces from entry callers through downstream functions.</li>
            <li><strong className="text-[#F3F4F6]">CI/CD Pipeline:</strong> Triggers, jobs, dependencies, and steps parsed from <code className="font-mono text-sky-300">.github/workflows/*.yml</code>.</li>
            <li><strong className="text-[#F3F4F6]">Deployment Architecture:</strong> Intended container and service topology parsed from <code className="font-mono text-sky-300">Dockerfile</code> and Compose manifests.</li>
            <li><strong className="text-[#F3F4F6]">Class Diagrams:</strong> Extracted classes, attributes, methods, and inheritance relationships.</li>
          </ul>
        </section>
      </main>
    </div>
  );
}

import { TopNav } from '../components/TopNav';

export function DocsPage() {
  return (
    <div className="min-h-screen bg-[#0B0D10] text-[#E6E9EF]">
      <TopNav />
      <main className="mx-auto max-w-3xl px-6 py-14 space-y-10">
        <header className="space-y-2 border-b border-[#232832] pb-6">
          <h1 className="text-2xl font-bold text-[#F9FAFB]">Codebase Tutor Documentation</h1>
          <p className="text-sm text-[#9CA3AF]">
            How Codebase Tutor analyzes unfamiliar repositories, builds a unified knowledge graph, and grounds every explanation in verifiable source code.
          </p>
        </header>

        <section className="space-y-2">
          <h2 className="text-base font-semibold text-[#F3F4F6]">1. Evidence before explanations</h2>
          <p className="text-sm leading-relaxed text-[#D1D5DB]">
            Codebase Tutor never executes imported repository code and never lets the AI invent architecture from file names alone. Static AST parsers (TypeScript Compiler API for JS/TS/TSX, indentation-aware Python parsing, YAML workflow parsing, and Dockerfile inspection) extract symbols, imports, and call graphs first. Gemini explains only the retrieved evidence and cites exact file paths and line numbers.
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

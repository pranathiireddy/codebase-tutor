import { PlayCircle, ArrowRight, Layers, FolderTree, Compass, ShieldAlert } from 'lucide-react';
import type { DiagramType, RepositoryRecord } from '../types/codebase';

interface OverviewWalkthroughPanelProps {
  repository: RepositoryRecord;
  onOpenCodeLocation: (filePath: string, startLine?: number, endLine?: number) => void;
  onOpenDiagram: (type: DiagramType) => void;
  onAskQuestion: (q: string) => void;
}

export function OverviewWalkthroughPanel({
  repository,
  onOpenCodeLocation,
  onOpenDiagram,
  onAskQuestion,
}: OverviewWalkthroughPanelProps) {
  const overview = repository.overview;
  if (!overview) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-[#9CA3AF]">
        Overview metadata unavailable.
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto bg-[#0B0D10] p-6">
      <div className="mx-auto max-w-4xl space-y-8">
        {/* Project Summary */}
        <section className="space-y-2 border-b border-[#232832] pb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold text-[#F3F4F6]">{repository.fullName}</h2>
            <span className="font-mono text-xs tabular-nums text-[#9CA3AF]">
              Commit {repository.commitSha.slice(0, 8)} · Branch {repository.defaultBranch}
            </span>
          </div>
          <p className="text-sm leading-relaxed text-[#D1D5DB]">{overview.summary}</p>
          <p className="text-xs text-[#6B7280]">{overview.purposeEvidence}</p>

          {/* Detected Stack Breakdown */}
          <div className="mt-4 grid grid-cols-1 gap-4 pt-2 sm:grid-cols-3">
            <div className="rounded-lg border border-[#232832] bg-[#111419] p-3.5">
              <div className="text-xs font-medium text-[#9CA3AF] mb-2">Detected Languages</div>
              <div className="space-y-1.5">
                {overview.languages.slice(0, 5).map((lang) => (
                  <div key={lang.name} className="flex items-center justify-between text-xs">
                    <span className="text-[#E6E9EF]">{lang.name}</span>
                    <span className="font-mono tabular-nums text-[#9CA3AF]">
                      {lang.files} files · {lang.percentage}%
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-[#232832] bg-[#111419] p-3.5">
              <div className="text-xs font-medium text-[#9CA3AF] mb-2">Frameworks & Tooling</div>
              <div className="space-y-1 text-xs text-[#E6E9EF]">
                {overview.frameworks.length > 0 ? (
                  overview.frameworks.map((f) => <div key={f}>{f}</div>)
                ) : (
                  <div className="text-[#6B7280]">No specific framework detected</div>
                )}
                {overview.packageManagers.map((pm) => (
                  <div key={pm} className="text-[#9CA3AF]">{pm}</div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-[#232832] bg-[#111419] p-3.5">
              <div className="text-xs font-medium text-[#9CA3AF] mb-2">Testing & Infrastructure</div>
              <div className="space-y-1 text-xs text-[#E6E9EF]">
                {overview.testFrameworks.length === 0 && overview.infrastructureTools.length === 0 ? (
                  <div className="text-[#6B7280]">None detected in manifests</div>
                ) : (
                  <>
                    {overview.testFrameworks.map((t) => (
                      <div key={t}>Tests: {t}</div>
                    ))}
                    {overview.infrastructureTools.map((tool) => (
                      <div key={tool}>Infra: {tool}</div>
                    ))}
                  </>
                )}
              </div>
            </div>
          </div>
        </section>

        {/* Guided Walkthrough */}
        {overview.walkthrough.length > 0 && (
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Compass className="h-4 w-4 text-sky-400" />
              <h3 className="text-sm font-semibold text-[#F3F4F6]">Guided Repository Walkthrough</h3>
            </div>
            <div className="space-y-2">
              {overview.walkthrough.map((step) => (
                <div
                  key={step.id}
                  className="flex flex-col gap-2 rounded-lg border border-[#232832] bg-[#111419] p-4 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="space-y-1 min-w-0">
                    <div className="text-xs font-semibold text-[#F3F4F6]">{step.title}</div>
                    <p className="text-xs text-[#9CA3AF] leading-relaxed">{step.summary}</p>
                    <div className="font-mono text-[11px] text-sky-400">{step.file_path}</div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() => onOpenCodeLocation(step.file_path, step.start_line, step.end_line)}
                      className="rounded border border-[#232832] bg-[#161A21] px-2.5 py-1.5 text-xs font-medium text-[#E6E9EF] hover:border-sky-500/50 cursor-pointer whitespace-nowrap"
                    >
                      Open Code
                    </button>
                    {step.diagram_type && (
                      <button
                        type="button"
                        onClick={() => onOpenDiagram(step.diagram_type!)}
                        className="flex items-center gap-1 rounded bg-sky-500/15 px-2.5 py-1.5 text-xs font-medium text-sky-300 hover:bg-sky-500/25 cursor-pointer whitespace-nowrap"
                      >
                        <span>View Diagram</span>
                        <ArrowRight className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Entry Points with Evidence */}
        <section className="space-y-3">
          <div className="flex items-center gap-2">
            <PlayCircle className="h-4 w-4 text-sky-400" />
            <h3 className="text-sm font-semibold text-[#F3F4F6]">Verified Entry Points</h3>
          </div>
          <div className="divide-y divide-[#232832] rounded-lg border border-[#232832] bg-[#111419]">
            {overview.entryPoints.map((ep) => (
              <div key={ep.file_path} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <button
                    type="button"
                    onClick={() => onOpenCodeLocation(ep.file_path, 1, 40)}
                    className="font-mono text-xs font-medium text-sky-400 hover:text-sky-300 cursor-pointer"
                  >
                    {ep.file_path}
                  </button>
                  <p className="mt-0.5 text-xs text-[#9CA3AF]">{ep.reason}</p>
                </div>
                <button
                  type="button"
                  onClick={() => onAskQuestion(`Where does execution start in ${ep.file_path} and what does it trigger?`)}
                  className="text-xs text-[#9CA3AF] hover:text-[#E6E9EF] whitespace-nowrap shrink-0 cursor-pointer"
                >
                  Ask Tutor →
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Major Modules & Important Folders */}
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <Layers className="h-4 w-4 text-sky-400" />
              <h3 className="text-sm font-semibold text-[#F3F4F6]">Logical Modules</h3>
            </div>
            <div className="space-y-2">
              {overview.majorModules.slice(0, 6).map((mod) => (
                <div key={mod.id} className="rounded-lg border border-[#232832] bg-[#111419] p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#E6E9EF]">{mod.name}</span>
                    <span className="font-mono text-[11px] tabular-nums text-[#6B7280]">
                      {mod.fileCount} files
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-[#9CA3AF]">{mod.description}</p>
                </div>
              ))}
            </div>
          </section>

          <section className="space-y-3">
            <div className="flex items-center gap-2">
              <FolderTree className="h-4 w-4 text-sky-400" />
              <h3 className="text-sm font-semibold text-[#F3F4F6]">Top Directories</h3>
            </div>
            <div className="divide-y divide-[#232832] rounded-lg border border-[#232832] bg-[#111419]">
              {overview.importantFolders.map((folder) => (
                <div key={folder.path} className="flex items-center justify-between px-3.5 py-2.5 text-xs">
                  <span className="font-mono text-[#E6E9EF]">{folder.path}</span>
                  <span className="text-[#9CA3AF]">
                    {folder.role} · <span className="font-mono tabular-nums">{folder.fileCount}</span>
                  </span>
                </div>
              ))}
            </div>
          </section>
        </div>

        {/* Coverage & Limitations */}
        <section className="rounded-lg border border-[#232832] bg-[#111419] p-4 space-y-2">
          <div className="flex items-center gap-2 text-xs font-semibold text-[#E6E9EF]">
            <ShieldAlert className="h-4 w-4 text-amber-400" />
            <span>Analysis Coverage & Limitations</span>
          </div>
          <ul className="list-disc pl-5 space-y-1 text-xs text-[#9CA3AF]">
            {overview.coverageNotes.map((note, idx) => (
              <li key={idx}>{note}</li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

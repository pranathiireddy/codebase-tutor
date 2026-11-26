import { useMemo, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileCode2,
  FileJson,
  FileText,
  Folder,
  FolderOpen,
  Search,
  Terminal,
  Workflow,
  PlayCircle,
  ArrowDownLeft,
  ArrowUpRight,
  PanelLeftClose,
} from 'lucide-react';
import type { AnalyzedFileMeta, FileRole, FileTreeNode, GraphEdgeType } from '../types/codebase';

interface FileExplorerPanelProps {
  onCollapse: () => void;
  tree: FileTreeNode[];
  filesMeta: AnalyzedFileMeta[];
  selectedFilePath: string | null;
  onSelectFile: (filePath: string) => void;
  incomingDeps: { file_path: string; relationship: GraphEdgeType; line?: number }[];
  outgoingDeps: { file_path: string; relationship: GraphEdgeType; line?: number }[];
}

const ROLE_FILTERS: { id: 'all' | FileRole; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'entry_point', label: 'Entry Points' },
  { id: 'service', label: 'Logic / Services' },
  { id: 'frontend', label: 'Frontend' },
  { id: 'backend', label: 'Backend / API' },
  { id: 'plugin_or_skill', label: 'Plugins / Rules' },
  { id: 'config', label: 'Config' },
  { id: 'tests', label: 'Tests' },
  { id: 'infrastructure', label: 'Infra' },
];

function getFileIcon(name: string, role?: FileRole) {
  const lower = name.toLowerCase();
  if (role === 'entry_point') return <PlayCircle className="h-3.5 w-3.5 text-sky-400 shrink-0" />;
  if (role === 'infrastructure') return <Workflow className="h-3.5 w-3.5 text-amber-400 shrink-0" />;
  if (lower.endsWith('.json') || lower.endsWith('.yaml') || lower.endsWith('.yml') || lower.endsWith('.toml')) {
    return <FileJson className="h-3.5 w-3.5 text-[#9CA3AF] shrink-0" />;
  }
  if (lower.endsWith('.sh') || lower.endsWith('.ps1')) {
    return <Terminal className="h-3.5 w-3.5 text-emerald-400 shrink-0" />;
  }
  if (lower.endsWith('.md') || lower === 'license') {
    return <FileText className="h-3.5 w-3.5 text-[#6B7280] shrink-0" />;
  }
  return <FileCode2 className="h-3.5 w-3.5 text-sky-300/80 shrink-0" />;
}

function TreeBranch({
  node,
  depth,
  selectedFilePath,
  expandedDirs,
  onToggleDir,
  onSelectFile,
}: {
  node: FileTreeNode;
  depth: number;
  selectedFilePath: string | null;
  expandedDirs: Set<string>;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
}) {
  if (node.type === 'tree') {
    const isExpanded = expandedDirs.has(node.path);
    return (
      <div>
        <button
          type="button"
          onClick={() => onToggleDir(node.path)}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          className="flex w-full items-center gap-1.5 py-1 pr-2 text-left text-xs text-[#D1D5DB] hover:bg-[#1A1F28] transition-colors cursor-pointer"
        >
          {isExpanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-[#6B7280] shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-[#6B7280] shrink-0" />
          )}
          {isExpanded ? (
            <FolderOpen className="h-3.5 w-3.5 text-sky-400/80 shrink-0" />
          ) : (
            <Folder className="h-3.5 w-3.5 text-[#9CA3AF] shrink-0" />
          )}
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {isExpanded &&
          node.children?.map((child) => (
            <TreeBranch
              key={child.path}
              node={child}
              depth={depth + 1}
              selectedFilePath={selectedFilePath}
              expandedDirs={expandedDirs}
              onToggleDir={onToggleDir}
              onSelectFile={onSelectFile}
            />
          ))}
      </div>
    );
  }

  const isSelected = selectedFilePath === node.path;
  return (
    <button
      type="button"
      onClick={() => onSelectFile(node.path)}
      style={{ paddingLeft: `${depth * 12 + 24}px` }}
      title={node.path}
      className={`flex w-full items-center justify-between gap-2 py-1 pr-2 text-left text-xs transition-colors cursor-pointer ${
        isSelected
          ? 'bg-sky-500/15 text-sky-200 font-medium'
          : 'text-[#9CA3AF] hover:bg-[#1A1F28] hover:text-[#E6E9EF]'
      }`}
    >
      <span className="flex items-center gap-1.5 min-w-0">
        {getFileIcon(node.name, node.role)}
        <span className="truncate">{node.name}</span>
      </span>
      {node.isEntryPoint ? (
        <span className="text-[10px] text-sky-400 shrink-0">entry</span>
      ) : (node.symbolCount ?? 0) > 0 ? (
        <span className="font-mono text-[10px] tabular-nums text-[#6B7280] shrink-0">
          {node.symbolCount}
        </span>
      ) : null}
    </button>
  );
}

export function FileExplorerPanel({
  onCollapse,
  tree,
  filesMeta,
  selectedFilePath,
  onSelectFile,
  incomingDeps,
  outgoingDeps,
}: FileExplorerPanelProps) {
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | FileRole>('all');
  const [expandedDirs, setExpandedDirs] = useState<Set<string>>(() => {
    const initial = new Set<string>();
    tree.forEach((n) => {
      if (n.type === 'tree' && !n.name.startsWith('.')) {
        initial.add(n.path);
      }
    });
    return initial;
  });

  const selectedMeta = useMemo(
    () => filesMeta.find((f) => f.path === selectedFilePath) ?? null,
    [filesMeta, selectedFilePath]
  );

  const filteredList = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q && roleFilter === 'all') return null;
    return filesMeta.filter((f) => {
      const matchQuery = !q || f.path.toLowerCase().includes(q) || f.language.toLowerCase().includes(q);
      const matchRole =
        roleFilter === 'all' ||
        f.role === roleFilter ||
        (roleFilter === 'backend' && f.role === 'api_route') ||
        (roleFilter === 'frontend' && f.role === 'component');
      return matchQuery && matchRole;
    });
  }, [filesMeta, search, roleFilter]);

  const toggleDir = (dirPath: string) => {
    setExpandedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  };

  return (
    <div className="flex h-full flex-col bg-[#111419] border-r border-[#232832]">
      {/* Header */}
      <div className="border-b border-[#232832] px-3 py-2.5">
        <div className="flex items-center justify-between mb-2">
          <h2 className="text-xs font-semibold text-[#E6E9EF]">File Explorer</h2>
          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] tabular-nums text-[#6B7280]">
              {filesMeta.length} files
            </span>
            <button
              type="button"
              onClick={onCollapse}
              title="Collapse File Explorer"
              aria-label="Collapse File Explorer"
              className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-[#E6E9EF] cursor-pointer"
            >
              <PanelLeftClose className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        {/* Search input */}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6B7280]" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Filter files by path or language..."
            className="w-full rounded-md border border-[#232832] bg-[#0B0D10] py-1.5 pl-8 pr-2.5 text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500/60 focus:outline-none"
          />
        </div>

        {/* Role filter select */}
        <div className="mt-2 flex items-center gap-1 overflow-x-auto pb-0.5">
          {ROLE_FILTERS.map((rf) => (
            <button
              key={rf.id}
              type="button"
              onClick={() => setRoleFilter(rf.id)}
              className={`rounded px-2 py-1 text-[11px] whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                roleFilter === rf.id
                  ? 'bg-sky-500/15 text-sky-300 font-medium'
                  : 'text-[#9CA3AF] hover:bg-[#1A1F28] hover:text-[#E6E9EF]'
              }`}
            >
              {rf.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tree or Filtered Flat List */}
      <div className="flex-1 overflow-y-auto py-1.5">
        {filteredList ? (
          filteredList.length === 0 ? (
            <div className="px-3 py-6 text-center text-xs text-[#6B7280]">
              No matching files found.
            </div>
          ) : (
            filteredList.map((f) => {
              const isSel = selectedFilePath === f.path;
              return (
                <button
                  key={f.path}
                  type="button"
                  onClick={() => onSelectFile(f.path)}
                  className={`flex w-full flex-col gap-0.5 px-3 py-1.5 text-left transition-colors cursor-pointer ${
                    isSel ? 'bg-sky-500/15 text-sky-200' : 'text-[#9CA3AF] hover:bg-[#1A1F28] hover:text-[#E6E9EF]'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="flex items-center gap-1.5 min-w-0 text-xs font-medium">
                      {getFileIcon(f.name, f.role)}
                      <span className="truncate">{f.name}</span>
                    </span>
                    <span className="text-[10px] text-[#6B7280] shrink-0">{f.language}</span>
                  </div>
                  <span className="truncate pl-5 font-mono text-[10px] text-[#6B7280]">{f.path}</span>
                </button>
              );
            })
          )
        ) : (
          tree.map((node) => (
            <TreeBranch
              key={node.path}
              node={node}
              depth={0}
              selectedFilePath={selectedFilePath}
              expandedDirs={expandedDirs}
              onToggleDir={toggleDir}
              onSelectFile={onSelectFile}
            />
          ))
        )}
      </div>

      {/* Selected File Responsibility & Dependencies Footer */}
      {selectedMeta && (
        <div className="max-h-56 overflow-y-auto border-t border-[#232832] bg-[#0D1015] p-3 text-xs">
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="font-mono text-[11px] font-medium text-[#E6E9EF] truncate">
              {selectedMeta.name}
            </span>
            <span className="text-[11px] text-[#9CA3AF] whitespace-nowrap shrink-0">
              {selectedMeta.language} · {selectedMeta.role.replace(/_/g, ' ')}
            </span>
          </div>
          <p className="text-[11px] leading-relaxed text-[#9CA3AF] mb-2">{selectedMeta.summary}</p>
          {selectedMeta.entryPointReason && (
            <p className="mb-2 text-[11px] text-sky-300">
              Entry point: {selectedMeta.entryPointReason}
            </p>
          )}

          {(incomingDeps.length > 0 || outgoingDeps.length > 0) && (
            <div className="space-y-1.5 pt-1.5 border-t border-[#232832]/80">
              {incomingDeps.length > 0 && (
                <div>
                  <div className="flex items-center gap-1 text-[10px] font-medium text-[#9CA3AF] mb-0.5">
                    <ArrowDownLeft className="h-3 w-3 text-sky-400" />
                    <span>Imported by ({incomingDeps.length})</span>
                  </div>
                  <div className="space-y-0.5">
                    {incomingDeps.slice(0, 4).map((d, i) => (
                      <button
                        key={`${d.file_path}-${i}`}
                        type="button"
                        onClick={() => onSelectFile(d.file_path)}
                        className="block w-full truncate text-left font-mono text-[10px] text-sky-400/90 hover:text-sky-300 cursor-pointer"
                      >
                        {d.file_path}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {outgoingDeps.length > 0 && (
                <div>
                  <div className="flex items-center gap-1 text-[10px] font-medium text-[#9CA3AF] mb-0.5">
                    <ArrowUpRight className="h-3 w-3 text-[#9CA3AF]" />
                    <span>Depends on ({outgoingDeps.length})</span>
                  </div>
                  <div className="space-y-0.5">
                    {outgoingDeps.slice(0, 4).map((d, i) => {
                      const isPkg = d.file_path.startsWith('pkg:');
                      return isPkg ? (
                        <div key={`${d.file_path}-${i}`} className="truncate font-mono text-[10px] text-[#6B7280]">
                          {d.file_path.replace('pkg:', 'package: ')}
                        </div>
                      ) : (
                        <button
                          key={`${d.file_path}-${i}`}
                          type="button"
                          onClick={() => onSelectFile(d.file_path)}
                          className="block w-full truncate text-left font-mono text-[10px] text-sky-400/90 hover:text-sky-300 cursor-pointer"
                        >
                          {d.file_path}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

import { useEffect, useRef, useState } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type * as MonacoType from 'monaco-editor';
import {
  Braces,
  Copy,
  Check,
  GripVertical,
  MessageSquarePlus,
  ExternalLink,
  Search,
} from 'lucide-react';
import type {
  CodeAttachment,
  ExtractedSymbol,
  FileContentResponse,
} from '../types/codebase';
import { useApp } from '../context/AppContext';

interface SourceCodePanelProps {
  fileData: FileContentResponse | null;
  loading: boolean;
  repoUrl: string;
  highlightRange: { start_line: number; end_line: number } | null;
  selectedSymbolId: string | null;
  onSelectSymbol: (symbol: ExtractedSymbol) => void;
  onAttachCodeToChat: (attachment: CodeAttachment) => void;
  onAskAboutCode: (attachment: CodeAttachment, question: string) => void;
}

function toMonacoLanguage(lang: string, filePath: string): string {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.tsx') || lower.endsWith('.ts') || lang === 'TypeScript') return 'typescript';
  if (lower.endsWith('.jsx') || lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs') || lang === 'JavaScript') return 'javascript';
  if (lang === 'Python') return 'python';
  if (lang === 'JSON') return 'json';
  if (lang === 'YAML') return 'yaml';
  if (lang === 'Markdown') return 'markdown';
  if (lang === 'Shell') return 'shell';
  if (lang === 'PowerShell') return 'powershell';
  if (lang === 'HTML') return 'html';
  if (lang === 'CSS') return 'css';
  if (lang === 'SQL') return 'sql';
  if (lang === 'Dockerfile') return 'dockerfile';
  return 'plaintext';
}

export function SourceCodePanel({
  fileData,
  loading,
  repoUrl,
  highlightRange,
  selectedSymbolId,
  onSelectSymbol,
  onAttachCodeToChat,
  onAskAboutCode,
}: SourceCodePanelProps) {
  const { preferences } = useApp();
  const editorRef = useRef<MonacoType.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof MonacoType | null>(null);
  const decorationsRef = useRef<string[]>([]);

  const [selectedLines, setSelectedLines] = useState<{ start: number; end: number; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [symbolFilter, setSymbolFilter] = useState('');
  const highlightRangeRef = useRef(highlightRange);
  highlightRangeRef.current = highlightRange;

  const applyHighlight = (
    editor: MonacoType.editor.IStandaloneCodeEditor | null,
    monaco: typeof MonacoType | null,
    range: { start_line: number; end_line: number } | null
  ) => {
    if (!editor || !monaco) return;
    if (!range) {
      decorationsRef.current = editor.deltaDecorations(decorationsRef.current, []);
      return;
    }
    const model = editor.getModel();
    const maxLine = model ? model.getLineCount() : range.end_line;
    const start = Math.max(1, Math.min(range.start_line, maxLine));
    const end = Math.max(start, Math.min(range.end_line, maxLine));

    editor.layout();
    decorationsRef.current = editor.deltaDecorations(decorationsRef.current, [
      {
        range: new monaco.Range(start, 1, end, 1),
        options: {
          isWholeLine: true,
          className: 'ct-highlight-line',
          glyphMarginClassName: 'ct-highlight-glyph',
        },
      },
    ]);

    editor.setPosition({ lineNumber: start, column: 1 });
    editor.revealLineInCenter(start);
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;

    editor.onDidChangeCursorSelection(() => {
      const sel = editor.getSelection();
      const model = editor.getModel();
      if (!sel || !model) return;
      if (sel.isEmpty()) {
        setSelectedLines(null);
        return;
      }
      const text = model.getValueInRange(sel);
      if (text.trim().length > 0) {
        setSelectedLines({
          start: sel.startLineNumber,
          end: sel.endLineNumber,
          text,
        });
      }
    });

    if (highlightRangeRef.current) {
      requestAnimationFrame(() => {
        applyHighlight(editor, monaco, highlightRangeRef.current);
      });
      setTimeout(() => {
        applyHighlight(editor, monaco, highlightRangeRef.current);
      }, 75);
    }
  };

  // Apply line highlights & scroll when highlightRange or fileData changes
  useEffect(() => {
    if (!fileData) return;
    const rafId = requestAnimationFrame(() => {
      applyHighlight(editorRef.current, monacoRef.current, highlightRange);
    });
    const timerId = setTimeout(() => {
      applyHighlight(editorRef.current, monacoRef.current, highlightRange);
    }, 75);
    return () => {
      cancelAnimationFrame(rafId);
      clearTimeout(timerId);
    };
  }, [highlightRange, fileData]);

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center bg-[#0B0D10] text-xs text-[#9CA3AF]">
        Loading source file...
      </div>
    );
  }

  if (!fileData) {
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[#0B0D10] p-6 text-center">
        <p className="text-sm font-medium text-[#E6E9EF] mb-1">Select a file from the explorer</p>
        <p className="text-xs text-[#9CA3AF] max-w-md">
          Inspect read-only source code, jump to functions and classes, highlight evidence lines, or drag any code block into chat.
        </p>
      </div>
    );
  }

  const { file, content, symbols } = fileData;
  const filteredSymbols = symbols.filter(
    (s) => !symbolFilter.trim() || s.name.toLowerCase().includes(symbolFilter.toLowerCase())
  );

  const handleCopy = async () => {
    const textToCopy = selectedLines?.text ?? content;
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const buildAttachmentFromSelection = (): CodeAttachment | null => {
    if (selectedLines) {
      return {
        file_path: file.path,
        start_line: selectedLines.start,
        end_line: selectedLines.end,
        code: selectedLines.text.slice(0, 2500),
      };
    }
    const activeSym = symbols.find((s) => s.id === selectedSymbolId);
    if (activeSym) {
      const lines = content.split('\n').slice(activeSym.start_line - 1, activeSym.end_line).join('\n');
      return {
        file_path: file.path,
        start_line: activeSym.start_line,
        end_line: activeSym.end_line,
        code: lines.slice(0, 2500),
        symbol_name: activeSym.name,
      };
    }
    const firstLines = content.split('\n').slice(0, 40).join('\n');
    return {
      file_path: file.path,
      start_line: 1,
      end_line: Math.min(40, file.lineCount),
      code: firstLines,
    };
  };

  return (
    <div className="flex h-full flex-col bg-[#0B0D10]">
      {/* File Header & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#232832] bg-[#111419] px-4 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="truncate font-mono text-xs font-medium text-[#E6E9EF]">{file.path}</span>
          <span className="text-[11px] text-[#6B7280] whitespace-nowrap shrink-0">
            · {file.language} · <span className="tabular-nums">{file.lineCount}</span> lines · Read-only
          </span>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Draggable Code Block Handle for Chat */}
          <div
            draggable
            onDragStart={(e) => {
              const att = buildAttachmentFromSelection();
              if (att) {
                e.dataTransfer.setData('application/x-codebase-tutor-snippet', JSON.stringify(att));
                e.dataTransfer.setData(
                  'text/plain',
                  `${att.file_path}:L${att.start_line}-${att.end_line}\n${att.code}`
                );
                e.dataTransfer.effectAllowed = 'copy';
              }
            }}
            title="Drag this handle into the Chat panel to attach the selected lines or active symbol"
            className="flex items-center gap-1 rounded border border-[#232832] bg-[#161A21] px-2 py-1 text-[11px] text-[#D1D5DB] hover:border-sky-500/50 cursor-grab active:cursor-grabbing select-none whitespace-nowrap shrink-0"
          >
            <GripVertical className="h-3 w-3 text-[#6B7280]" />
            <span>
              {selectedLines
                ? `Drag L${selectedLines.start}-${selectedLines.end} to Chat`
                : 'Drag Block to Chat'}
            </span>
          </div>

          <button
            type="button"
            onClick={() => {
              const att = buildAttachmentFromSelection();
              if (att) {
                onAskAboutCode(
                  att,
                  selectedLines
                    ? `Explain lines ${selectedLines.start}-${selectedLines.end} in ${file.path}.`
                    : `Explain how ${file.path} works.`
                );
              }
            }}
            className="flex items-center gap-1 rounded bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <MessageSquarePlus className="h-3.5 w-3.5" />
            <span>{selectedLines ? 'Ask about selection' : 'Explain file'}</span>
          </button>

          <button
            type="button"
            onClick={() => void handleCopy()}
            className="flex items-center gap-1 rounded border border-[#232832] px-2 py-1 text-[11px] text-[#9CA3AF] hover:text-[#E6E9EF] transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>

          <a
            href={`${repoUrl}/blob/HEAD/${file.path}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1 rounded border border-[#232832] px-2 py-1 text-[11px] text-[#9CA3AF] hover:text-[#E6E9EF] transition-colors whitespace-nowrap shrink-0"
          >
            <ExternalLink className="h-3 w-3" />
            <span>GitHub</span>
          </a>
        </div>
      </div>

      {/* Interactive Code Blocks / Symbol Outline Strip */}
      {symbols.length > 0 && (
        <div className="border-b border-[#232832] bg-[#0E1116] px-4 py-2">
          <div className="flex items-center justify-between gap-3 mb-1.5">
            <div className="flex items-center gap-2 text-[11px] font-medium text-[#9CA3AF]">
              <Braces className="h-3.5 w-3.5 text-sky-400" />
              <span>Interactive Code Blocks ({symbols.length})</span>
              <span className="hidden sm:inline text-[10px] font-normal text-[#6B7280]">
                · Drag any block into Tutor Chat
              </span>
            </div>
            {symbols.length > 5 && (
              <div className="relative w-44">
                <Search className="pointer-events-none absolute left-2 top-1/2 h-3 w-3 -translate-y-1/2 text-[#6B7280]" />
                <input
                  type="text"
                  value={symbolFilter}
                  onChange={(e) => setSymbolFilter(e.target.value)}
                  placeholder="Filter symbols..."
                  className="w-full rounded border border-[#232832] bg-[#0B0D10] py-0.5 pl-6 pr-2 text-[11px] text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500/60 focus:outline-none"
                />
              </div>
            )}
          </div>
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
            {filteredSymbols.map((sym) => {
              const active = selectedSymbolId === sym.id;
              const buildSymbolAttachment = (): CodeAttachment => {
                const lines = content
                  .split('\n')
                  .slice(sym.start_line - 1, sym.end_line)
                  .join('\n');
                return {
                  file_path: file.path,
                  start_line: sym.start_line,
                  end_line: sym.end_line,
                  code: lines.slice(0, 2500),
                  symbol_name: sym.name,
                };
              };
              return (
                <div
                  key={sym.id}
                  role="button"
                  tabIndex={0}
                  draggable
                  onClick={() => onSelectSymbol(sym)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelectSymbol(sym);
                    }
                  }}
                  onDoubleClick={() => onAttachCodeToChat(buildSymbolAttachment())}
                  onDragStart={(e) => {
                    const att = buildSymbolAttachment();
                    e.dataTransfer.setData('application/x-codebase-tutor-snippet', JSON.stringify(att));
                    e.dataTransfer.setData(
                      'text/plain',
                      `${sym.name} (${file.path}:L${sym.start_line}-${sym.end_line})\n${att.code}`
                    );
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  title={`${sym.description} (L${sym.start_line}-${sym.end_line}) — Click to jump, drag into Tutor Chat, or double-click to attach`}
                  className={`group flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] whitespace-nowrap shrink-0 transition-colors cursor-grab active:cursor-grabbing select-none ${
                    active
                      ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                      : 'border-[#232832] bg-[#141820] text-[#D1D5DB] hover:border-sky-500/40'
                  }`}
                >
                  <GripVertical className="h-3 w-3 text-[#6B7280] group-hover:text-sky-400 shrink-0" />
                  <span className="text-[10px] text-[#6B7280]">
                    {sym.kind === 'api_route' ? 'route' : sym.kind}
                  </span>
                  <span className="font-mono font-medium">{sym.name}</span>
                  <span className="font-mono text-[10px] tabular-nums text-[#6B7280]">
                    L{sym.start_line}-{sym.end_line}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Read-only Monaco Editor */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <Editor
          height="100%"
          path={file.path}
          language={toMonacoLanguage(file.language, file.path)}
          value={content}
          theme="vs-dark"
          onMount={handleMount}
          options={{
            readOnly: true,
            domReadOnly: true,
            fontSize: preferences.editorFontSize,
            fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace",
            minimap: { enabled: preferences.showMinimap },
            lineNumbers: 'on',
            glyphMargin: true,
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            automaticLayout: true,
            renderLineHighlight: 'line',
            padding: { top: 12, bottom: 12 },
          }}
        />
      </div>
    </div>
  );
}

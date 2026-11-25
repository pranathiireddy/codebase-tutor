import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeft,
  Code2,
  Compass,
  Network,
  Plus,
  RefreshCw,
  Loader2,
  AlertCircle,
  ExternalLink,
} from 'lucide-react';
import { ChatPanel } from '../components/ChatPanel';
import { FileExplorerPanel } from '../components/FileExplorerPanel';
import { SourceCodePanel } from '../components/SourceCodePanel';
import { DiagramExplorerPanel } from '../components/DiagramExplorerPanel';
import { OverviewWalkthroughPanel } from '../components/OverviewWalkthroughPanel';
import { useApp } from '../context/AppContext';
import { ApiHtmlFallbackError, buildApiHeaders, safeJson } from '../utils/api';
import { generateClientFallbackExplanation } from '../utils/clientTutorFallback';
import type {
  AnalyzedFileMeta,
  ChatCitation,
  ChatContext,
  ChatMessage,
  CodeAttachment,
  DiagramType,
  DiagramVisualEdge,
  DiagramVisualNode,
  ExtractedSymbol,
  FileContentResponse,
  FileTreeNode,
  GraphNode,
  KnowledgeGraph,
  RepositoryRecord,
} from '../types/codebase';

type ExplorationMode = 'overview' | 'code' | 'diagrams';

export function WorkspacePage() {
  const { repositoryId } = useParams<{ repositoryId?: string }>();
  const navigate = useNavigate();
  const { preferences, credentials, updateCredentials, setCredentialStatus } = useApp();

  const targetRepoId = repositoryId || 'dietrichgebert__ponytail';

  const [repositories, setRepositories] = useState<RepositoryRecord[]>([]);
  const [repository, setRepository] = useState<RepositoryRecord | null>(null);
  const [tree, setTree] = useState<FileTreeNode[]>([]);
  const [filesMeta, setFilesMeta] = useState<AnalyzedFileMeta[]>([]);
  const [graphNodes, setGraphNodes] = useState<GraphNode[]>([]);
  const fileContentCacheRef = useRef<Map<string, FileContentResponse>>(new Map());

  // Workspace selection & synchronized state
  const [explorationMode, setExplorationMode] = useState<ExplorationMode>('diagrams');
  const [activeDiagramType, setActiveDiagramType] = useState<DiagramType>(preferences.defaultDiagramType);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [fileData, setFileData] = useState<FileContentResponse | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [highlightRange, setHighlightRange] = useState<{ start_line: number; end_line: number } | null>(null);
  const [selectedSymbolId, setSelectedSymbolId] = useState<string | null>(null);
  const [selectedSymbolName, setSelectedSymbolName] = useState<string | undefined>(undefined);
  const [selectedGraphNodeId, setSelectedGraphNodeId] = useState<string | null>(null);
  const [selectedNodeName, setSelectedNodeName] = useState<string | undefined>(undefined);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | undefined>(undefined);

  // Chat state
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [attachedCode, setAttachedCode] = useState<CodeAttachment | undefined>(undefined);

  // Quick import modal
  const [showImportModal, setShowImportModal] = useState(false);
  const [importUrl, setImportUrl] = useState('');
  const [importError, setImportError] = useState<string | null>(null);

  // Resizable panel widths (percentages)
  const [leftWidth, setLeftWidth] = useState(26);
  const [midWidth, setMidWidth] = useState(20);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingDivider = useRef<'left' | 'mid' | null>(null);

  useEffect(() => {
    let rafId = 0;
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingDivider.current || !containerRef.current) return;
      const clientX = e.clientX;
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        if (!draggingDivider.current || !containerRef.current) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width <= 0) return;
        const pct = ((clientX - rect.left) / rect.width) * 100;
        if (draggingDivider.current === 'left') {
          setLeftWidth(Math.min(42, Math.max(18, pct)));
        } else {
          const nextMid = pct - leftWidth;
          setMidWidth(Math.min(34, Math.max(14, nextMid)));
        }
      });
    };
    const onMouseUp = () => {
      draggingDivider.current = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, [leftWidth]);

  // Load repository list
  const loadRepoList = useCallback(async () => {
    try {
      const res = await fetch('/api/repositories');
      if (res.ok) {
        const json = await safeJson<{ repositories: RepositoryRecord[] }>(res);
        setRepositories(json.repositories);
      }
    } catch {
      // ignore
    }
  }, []);

  // Poll target repository analysis until ready
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Reset selection when switching repo
    setSelectedFilePath(null);
    setFileData(null);
    setHighlightRange(null);
    setSelectedSymbolId(null);
    setSelectedGraphNodeId(null);
    setGraphNodes([]);
    fileContentCacheRef.current.clear();
    setMessages([]);
    setAttachedCode(undefined);

    async function loadAnalysis() {
      try {
        const res = await fetch(`/api/repositories/${encodeURIComponent(targetRepoId)}/analysis`);
        if (res.status === 404 && targetRepoId === 'dietrichgebert__ponytail') {
          await fetch('/api/repositories/analyze', {
            method: 'POST',
            headers: buildApiHeaders(credentials, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({ url: 'https://github.com/DietrichGebert/ponytail' }),
          });
        }
        if (res.ok) {
          const json = await safeJson<{ repository: RepositoryRecord }>(res);
          if (cancelled) return;
          setRepository(json.repository);

          if (json.repository.stage === 'ready') {
            const [filesRes, graphRes] = await Promise.all([
              fetch(`/api/repositories/${encodeURIComponent(targetRepoId)}/files`),
              fetch(`/api/repositories/${encodeURIComponent(targetRepoId)}/graph`),
            ]);
            if (filesRes.ok && !cancelled) {
              const filesJson = await safeJson<{
                tree: FileTreeNode[];
                files: AnalyzedFileMeta[];
              }>(filesRes);
              setTree(filesJson.tree);
              setFilesMeta(filesJson.files);

              // Auto-select primary entry point or README
              const defaultFile =
                json.repository.overview?.entryPoints[0]?.file_path ||
                filesJson.files.find((f) => f.path.toLowerCase() === 'readme.md')?.path ||
                filesJson.files[0]?.path;
              if (defaultFile) {
                setSelectedFilePath(defaultFile);
              }
            }
            if (graphRes.ok && !cancelled) {
              try {
                const gJson = await safeJson<{ graph?: KnowledgeGraph }>(graphRes);
                if (gJson.graph?.nodes) {
                  setGraphNodes(gJson.graph.nodes);
                }
              } catch {
                // ignore graph load error
              }
            }
            void loadRepoList();
            return;
          }
          if (json.repository.stage !== 'error') {
            timer = setTimeout(() => void loadAnalysis(), 1000);
          }
        } else {
          timer = setTimeout(() => void loadAnalysis(), 1200);
        }
      } catch {
        timer = setTimeout(() => void loadAnalysis(), 1500);
      }
    }

    void loadRepoList();
    void loadAnalysis();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [targetRepoId, loadRepoList]);

  // Fetch file content whenever selectedFilePath changes
  useEffect(() => {
    if (!selectedFilePath || repository?.stage !== 'ready') return;
    let cancelled = false;

    const cached = fileContentCacheRef.current.get(selectedFilePath);
    if (cached) {
      setFileData(cached);
      setFileLoading(false);
      return;
    }

    async function fetchContent() {
      setFileLoading(true);
      try {
        const res = await fetch(
          `/api/repositories/${encodeURIComponent(targetRepoId)}/files/content?path=${encodeURIComponent(selectedFilePath!)}`
        );
        if (res.ok) {
          const json = await safeJson<FileContentResponse>(res);
          fileContentCacheRef.current.set(selectedFilePath!, json);
          if (!cancelled) {
            setFileData(json);
          }
        }
      } finally {
        if (!cancelled) setFileLoading(false);
      }
    }

    void fetchContent();
    return () => {
      cancelled = true;
    };
  }, [targetRepoId, selectedFilePath, repository?.stage]);

  const openCodeLocation = useCallback(
    (filePath: string, startLine?: number, endLine?: number, symbolId?: string) => {
      const cleanPath = filePath.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
      const canonical =
        filesMeta.find((f) => f.path === cleanPath)?.path ||
        filesMeta.find((f) => f.path.toLowerCase() === cleanPath.toLowerCase())?.path ||
        filesMeta.find((f) => f.path.toLowerCase().endsWith(`/${cleanPath.toLowerCase()}`))?.path ||
        cleanPath;

      setSelectedFilePath(canonical);
      setExplorationMode('code');
      if (startLine) {
        setHighlightRange({ start_line: startLine, end_line: endLine ?? startLine });
      } else {
        setHighlightRange(null);
      }
      if (symbolId) {
        setSelectedSymbolId(symbolId);
        setSelectedGraphNodeId(symbolId);
      }
    },
    [filesMeta]
  );

  const loadFileContentCached = useCallback(
    async (filePath: string): Promise<FileContentResponse | null> => {
      const cached = fileContentCacheRef.current.get(filePath);
      if (cached) return cached;
      try {
        const res = await fetch(
          `/api/repositories/${encodeURIComponent(targetRepoId)}/files/content?path=${encodeURIComponent(filePath)}`
        );
        if (!res.ok) return null;
        const json = await safeJson<FileContentResponse>(res);
        fileContentCacheRef.current.set(filePath, json);
        return json;
      } catch {
        return null;
      }
    },
    [targetRepoId]
  );

  const handleTraceCode = useCallback(
    async (rawToken: string, citations?: ChatCitation[]): Promise<boolean> => {
      const token = rawToken.trim().replace(/^['"]|['"]$/g, '').replace(/[–—]/g, '-');
      if (!token) return false;

      // Support context labels like "Snippet path/to/file.ts:L10-25" or "A · B"
      const primaryToken = token.includes(' · ') ? token.split(' · ').pop()!.trim() : token;
      const cleaned = primaryToken.replace(/^Snippet\s+/i, '').trim();

      const citationFiles = new Set((citations ?? []).map((c) => c.file_path));

      const findFileMatch = (candidatePath: string): AnalyzedFileMeta | undefined => {
        const norm = candidatePath.replace(/\\/g, '/').replace(/^\.?\//, '').trim();
        if (!norm) return undefined;
        const exact = filesMeta.find((f) => f.path === norm);
        if (exact) return exact;
        const lower = norm.toLowerCase();
        const suffixMatches = filesMeta.filter(
          (f) => f.path.toLowerCase().endsWith(`/${lower}`) || f.name.toLowerCase() === lower
        );
        if (suffixMatches.length === 1) return suffixMatches[0];
        if (suffixMatches.length > 1) {
          return (
            suffixMatches.find((f) => f.path === selectedFilePath) ||
            suffixMatches.find((f) => citationFiles.has(f.path)) ||
            suffixMatches[0]
          );
        }
        return undefined;
      };

      // 0. Standalone line references like "L10-25", "lines 10-25", "line 42"
      const standaloneLineMatch = cleaned.match(/^(?:lines?|L)\s*(\d+)(?:\s*-\s*L?(\d+))?$/i);
      if (standaloneLineMatch) {
        const targetFile = selectedFilePath || citations?.[0]?.file_path;
        if (targetFile) {
          const start = Math.max(1, Number(standaloneLineMatch[1]));
          const end = standaloneLineMatch[2] ? Math.max(start, Number(standaloneLineMatch[2])) : start;
          openCodeLocation(targetFile, start, end);
          return true;
        }
      }

      // 1. Check explicit path + optional line range:
      // Handles "src/foo.ts:10-25", "foo.ts:L12", "foo.ts#L10-25", "foo.ts (lines 10-25)", "foo.ts line 10"
      const pathLineMatch = cleaned.match(
        /^([^\s:#()]+?)(?:\s*(?::|#|\(\s*(?:lines?\s*)?|\s+lines?\s+)L?(\d+)(?:\s*-\s*L?(\d+))?\s*\)?)?$/i
      );
      if (pathLineMatch) {
        const pathCandidate = pathLineMatch[1];
        const startStr = pathLineMatch[2];
        const endStr = pathLineMatch[3];
        const matchedFile = findFileMatch(pathCandidate);
        if (matchedFile) {
          if (startStr) {
            const start = Math.max(1, Number(startStr));
            const end = endStr ? Math.max(start, Number(endStr)) : start;
            openCodeLocation(matchedFile.path, start, end);
            return true;
          }
          const cit = citations?.find((c) => c.file_path === matchedFile.path);
          openCodeLocation(
            matchedFile.path,
            cit?.start_line ?? 1,
            cit?.end_line ?? Math.min(30, matchedFile.lineCount || 30)
          );
          return true;
        }
      }

      // 2. Check file#symbol (e.g. personalities.ts#getScore)
      if (cleaned.includes('#')) {
        const [leftPath, rightSym] = cleaned.split('#');
        const matchedFile = findFileMatch(leftPath);
        if (matchedFile) {
          const fc = await loadFileContentCached(matchedFile.path);
          if (fc) {
            const targetSym = rightSym.replace(/\(\)$/, '').trim().toLowerCase();
            const sym = fc.symbols.find((s) => s.name.toLowerCase() === targetSym);
            if (sym) {
              openCodeLocation(matchedFile.path, sym.start_line, sym.end_line, sym.id);
              return true;
            }
          }
        }
      }

      // Build symbol / identifier search candidates (strip keywords like export/const/function, parens, and prefixes)
      const withoutKeywords = cleaned
        .replace(/^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|const|let|var|type|interface|class|enum|def)\s+/i, '')
        .trim();
      const noParens = withoutKeywords.replace(/\([^)]*\)$/, '').trim();
      const baseIdent = noParens.includes('.') ? noParens.split('.').pop()!.trim() : noParens;
      const identCandidates = Array.from(
        new Set([noParens, baseIdent, withoutKeywords, cleaned].filter((s) => s.length >= 2))
      );

      // 3. Check symbols in currently open file
      if (fileData) {
        const localSym = fileData.symbols.find((s) =>
          identCandidates.some((c) => s.name === c || s.name.toLowerCase() === c.toLowerCase())
        );
        if (localSym) {
          openCodeLocation(fileData.file.path, localSym.start_line, localSym.end_line, localSym.id);
          return true;
        }
      }

      // 4. Check Knowledge Graph nodes across entire repository (functions, classes, routes, files)
      let nodesToSearch = graphNodes;
      if (nodesToSearch.length === 0) {
        try {
          const gRes = await fetch(`/api/repositories/${encodeURIComponent(targetRepoId)}/graph`);
          if (gRes.ok) {
            const gJson = await safeJson<{ graph?: KnowledgeGraph }>(gRes);
            if (gJson.graph?.nodes) {
              nodesToSearch = gJson.graph.nodes;
              setGraphNodes(nodesToSearch);
            }
          }
        } catch {
          // ignore
        }
      }

      if (nodesToSearch.length > 0) {
        const matchingNodes = nodesToSearch.filter((n) => {
          if (!n.file_path) return false;
          return identCandidates.some(
            (c) => n.name === c || n.name.toLowerCase() === c.toLowerCase()
          );
        });
        if (matchingNodes.length > 0) {
          const best =
            matchingNodes.find((n) => n.file_path === selectedFilePath) ||
            matchingNodes.find((n) => n.file_path && citationFiles.has(n.file_path)) ||
            matchingNodes.find((n) => n.type !== 'file') ||
            matchingNodes[0];
          if (best.file_path) {
            openCodeLocation(
              best.file_path,
              best.start_line ?? 1,
              best.end_line ?? best.start_line ?? 25,
              best.type === 'file' ? undefined : best.id
            );
            return true;
          }
        }
      }

      // 5. Search declarations in currently open file and cited files
      const searchDeclInContent = (content: string, needles: string[]): number | null => {
        const lines = content.split('\n');
        for (const needle of needles) {
          if (needle.length < 2) continue;
          const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          if (!/^[A-Za-z0-9_$-]+$/.test(needle)) continue;
          const declRe = new RegExp(
            `\\b(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?(?:function|const|let|var|type|interface|class|enum|def)\\s+${escaped}\\b`,
            'i'
          );
          for (let i = 0; i < lines.length; i += 1) {
            if (declRe.test(lines[i])) return i + 1;
          }
        }
        return null;
      };

      const searchLineInContent = (content: string, needles: string[]): number | null => {
        const lines = content.split('\n');
        for (const needle of needles) {
          if (needle.length < 2) continue;
          const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const wordRe = /^[A-Za-z0-9_$-]+$/.test(needle) ? new RegExp(`\\b${escaped}\\b`, 'i') : null;
          for (let i = 0; i < lines.length; i += 1) {
            if (wordRe ? wordRe.test(lines[i]) : lines[i].includes(needle)) {
              return i + 1;
            }
          }
        }
        return null;
      };

      if (fileData) {
        const declLine = searchDeclInContent(fileData.content, identCandidates);
        if (declLine) {
          openCodeLocation(fileData.file.path, declLine, Math.min(fileData.file.lineCount || declLine + 15, declLine + 15));
          return true;
        }
      }

      const loadedCitedFiles: FileContentResponse[] = [];
      for (const cit of citations ?? []) {
        const fc = await loadFileContentCached(cit.file_path);
        if (!fc) continue;
        loadedCitedFiles.push(fc);
        const sym = fc.symbols.find((s) =>
          identCandidates.some((c) => s.name === c || s.name.toLowerCase() === c.toLowerCase())
        );
        if (sym) {
          openCodeLocation(fc.file.path, sym.start_line, sym.end_line, sym.id);
          return true;
        }
        const declLine = searchDeclInContent(fc.content, identCandidates);
        if (declLine) {
          openCodeLocation(fc.file.path, declLine, Math.min(fc.file.lineCount || declLine + 15, declLine + 15));
          return true;
        }
      }

      // 6. Full-repository backend trace search across every analyzed file (declarations, types, constants, snippets)
      const traceQuery = baseIdent || noParens || cleaned;
      if (traceQuery.length >= 2) {
        try {
          const preferred = selectedFilePath || citations?.[0]?.file_path || '';
          const traceRes = await fetch(
            `/api/repositories/${encodeURIComponent(targetRepoId)}/trace?q=${encodeURIComponent(traceQuery)}&preferredFile=${encodeURIComponent(preferred)}`
          );
          if (traceRes.ok) {
            const traceJson = await safeJson<{
              match: {
                file_path: string;
                start_line: number;
                end_line: number;
                symbol_id?: string;
              } | null;
            }>(traceRes);
            if (traceJson.match) {
              openCodeLocation(
                traceJson.match.file_path,
                traceJson.match.start_line,
                traceJson.match.end_line,
                traceJson.match.symbol_id
              );
              return true;
            }
          }
        } catch {
          // ignore if trace endpoint unavailable
        }
      }

      // 6b. Local / cited usage line fallback if backend returned no match
      if (fileData) {
        const hitLine = searchLineInContent(fileData.content, identCandidates);
        if (hitLine) {
          openCodeLocation(fileData.file.path, hitLine, hitLine);
          return true;
        }
      }
      for (const fc of loadedCitedFiles) {
        const hitLine = searchLineInContent(fc.content, identCandidates);
        if (hitLine) {
          openCodeLocation(fc.file.path, hitLine, hitLine);
          return true;
        }
      }

      // 7. Fallback: partial filename match if a single clear file matches (e.g. "personalities")
      if (baseIdent.length >= 4) {
        const lower = baseIdent.toLowerCase();
        const fileHit =
          filesMeta.find((f) => f.name.toLowerCase().replace(/\.[^.]+$/, '') === lower) ||
          filesMeta.find((f) => f.path.toLowerCase().includes(lower));
        if (fileHit) {
          openCodeLocation(fileHit.path, 1, Math.min(30, fileHit.lineCount || 30));
          return true;
        }
      }

      return false;
    },
    [filesMeta, selectedFilePath, fileData, graphNodes, targetRepoId, openCodeLocation, loadFileContentCached]
  );

  const handleSelectFile = useCallback((filePath: string) => {
    setSelectedFilePath(filePath);
    setHighlightRange(null);
    setSelectedSymbolId(null);
    setSelectedSymbolName(undefined);
    setSelectedGraphNodeId(`file:${filePath}`);
    setExplorationMode('code');
  }, []);

  const handleSelectSymbol = useCallback((sym: ExtractedSymbol) => {
    setSelectedSymbolId(sym.id);
    setSelectedSymbolName(sym.name);
    setSelectedGraphNodeId(sym.id);
    setHighlightRange({ start_line: sym.start_line, end_line: sym.end_line });
  }, []);

  const handleSelectDiagramNode = useCallback((node: DiagramVisualNode) => {
    setSelectedGraphNodeId(node.graphNodeId);
    setSelectedNodeName(node.label);
    setSelectedEdgeId(undefined);
    if (node.file_path) {
      setSelectedFilePath(node.file_path);
      if (node.start_line) {
        setHighlightRange({ start_line: node.start_line, end_line: node.end_line ?? node.start_line });
      }
    }
  }, []);

  const currentChatContext: ChatContext = {
    selectedFilePath: selectedFilePath ?? undefined,
    selectedSymbolId: selectedSymbolId ?? undefined,
    selectedSymbolName,
    selectedCodeRange: highlightRange ?? undefined,
    selectedDiagramType: explorationMode === 'diagrams' ? activeDiagramType : undefined,
    selectedNodeId: selectedGraphNodeId ?? undefined,
    selectedNodeName,
    selectedEdgeId,
    attachedCode,
  };

  const sendQuestion = useCallback(
    async (
      question: string,
      overrideContext?: ChatContext,
      overrideCreds?: typeof credentials
    ) => {
      const credsToUse = overrideCreds ?? credentials;
      const ctxToUse = overrideContext ?? currentChatContext;
      const contextLabels: string[] = [];
      if (ctxToUse.selectedNodeName) contextLabels.push(ctxToUse.selectedNodeName);
      if (ctxToUse.selectedSymbolName) contextLabels.push(ctxToUse.selectedSymbolName);
      if (ctxToUse.selectedFilePath) contextLabels.push(ctxToUse.selectedFilePath);
      if (ctxToUse.attachedCode) {
        contextLabels.push(
          `Snippet ${ctxToUse.attachedCode.file_path}:L${ctxToUse.attachedCode.start_line}-${ctxToUse.attachedCode.end_line}`
        );
      }

      const userMsg: ChatMessage = {
        id: `u_${Date.now()}`,
        role: 'user',
        content: question,
        timestamp: new Date().toISOString(),
        contextLabel: contextLabels.join(' · ') || undefined,
      };

      const nextHistory = [...messages, userMsg];
      setMessages(nextHistory);
      setChatLoading(true);

      try {
        let json: {
          answer?: string;
          citations?: ChatMessage['citations'];
          confidenceSummary?: ChatMessage['confidenceSummary'];
          modelUsed?: string;
          error?: string;
        };

        try {
          const res = await fetch(`/api/repositories/${encodeURIComponent(targetRepoId)}/chat`, {
            method: 'POST',
            headers: buildApiHeaders(credsToUse, { 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              question,
              context: ctxToUse,
              history: messages
                .filter((m) => !m.error && m.content.trim().length > 0)
                .map((m) => ({ role: m.role, content: m.content })),
            }),
          });
          json = await safeJson<typeof json>(res);

          if (!res.ok) {
            throw new Error(json.error || 'Unable to generate explanation.');
          }
        } catch (backendErr) {
          // If preview/static host served HTML instead of the backend /api route, fall back to direct Gemini call
          if (backendErr instanceof ApiHtmlFallbackError && repository) {
            json = await generateClientFallbackExplanation({
              repository,
              filesMeta,
              fileData,
              question,
              context: ctxToUse,
              history: messages
                .filter((m) => !m.error && m.content.trim().length > 0)
                .map((m) => ({ role: m.role, content: m.content })),
              apiKey: credsToUse.geminiApiKey,
              model: credsToUse.geminiModel,
            });
          } else {
            throw backendErr;
          }
        }

        if (
          credsToUse.geminiApiKey.trim() &&
          json.modelUsed &&
          json.modelUsed !== credsToUse.geminiModel
        ) {
          updateCredentials({ geminiModel: json.modelUsed });
        }

        const assistantMsg: ChatMessage = {
          id: `a_${Date.now()}`,
          role: 'assistant',
          content: json.answer || 'No explanation generated.',
          timestamp: new Date().toISOString(),
          citations: json.citations,
          confidenceSummary: json.confidenceSummary,
        };
        setMessages((prev) => [...prev, assistantMsg]);

        // Automatically highlight primary cited code if user is in code mode or no lines highlighted
        if (json.citations && json.citations[0] && explorationMode === 'code') {
          setSelectedFilePath(json.citations[0].file_path);
          setHighlightRange({
            start_line: json.citations[0].start_line,
            end_line: json.citations[0].end_line,
          });
        }
      } catch (err) {
        setMessages((prev) => [
          ...prev,
          {
            id: `err_${Date.now()}`,
            role: 'assistant',
            content: '',
            timestamp: new Date().toISOString(),
            error: err instanceof Error ? err.message : 'Chat request failed.',
          },
        ]);
      } finally {
        setChatLoading(false);
      }
    },
    [
      currentChatContext,
      messages,
      targetRepoId,
      explorationMode,
      credentials,
      updateCredentials,
      repository,
      filesMeta,
      fileData,
    ]
  );

  const handleQuickApplyGeminiKey = useCallback(
    async (apiKey: string, retryQuestion?: string): Promise<string | null> => {
      try {
        let resolvedModel = credentials.geminiModel;
        try {
          const res = await fetch('/api/settings/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              geminiApiKey: apiKey,
              geminiModel: credentials.geminiModel,
            }),
          });
          const json = await safeJson<{
            gemini?: { valid: boolean; model: string; note?: string; error?: string };
            error?: string;
          }>(res);
          if (!res.ok) {
            return json.error || 'Failed to verify Gemini API key.';
          }
          if (!json.gemini?.valid) {
            return json.gemini?.error || 'Gemini API key verification failed.';
          }
          resolvedModel = json.gemini.model || credentials.geminiModel;
        } catch (verifyErr) {
          if (!(verifyErr instanceof ApiHtmlFallbackError)) {
            throw verifyErr;
          }
        }

        const nextCreds = {
          ...credentials,
          geminiApiKey: apiKey,
          geminiModel: resolvedModel,
        };
        updateCredentials({
          geminiApiKey: nextCreds.geminiApiKey,
          geminiModel: nextCreds.geminiModel,
        });
        setCredentialStatus({
          geminiVerified: true,
          geminiMessage: `Verified (${nextCreds.geminiModel})`,
          githubVerified: null,
        });
        if (retryQuestion) {
          void sendQuestion(retryQuestion, undefined, nextCreds);
        }
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : 'Verification failed.';
      }
    },
    [credentials, updateCredentials, setCredentialStatus, sendQuestion]
  );

  const handleQuickImport = async (e: React.FormEvent) => {
    e.preventDefault();
    setImportError(null);
    let targetInput = importUrl.trim();
    if (
      credentials.githubDefaultOwner.trim() &&
      targetInput &&
      !targetInput.includes('/') &&
      !targetInput.includes(':')
    ) {
      targetInput = `${credentials.githubDefaultOwner.trim()}/${targetInput}`;
    }
    try {
      const res = await fetch('/api/repositories/analyze', {
        method: 'POST',
        headers: buildApiHeaders(credentials, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({ url: targetInput }),
      });
      const json = await safeJson<{ repository?: RepositoryRecord; error?: string }>(res);
      if (!res.ok || !json.repository) {
        throw new Error(json.error || 'Failed to import repository.');
      }
      setShowImportModal(false);
      setImportUrl('');
      navigate(`/workspace/${encodeURIComponent(json.repository.id)}`);
    } catch (err) {
      setImportError(err instanceof Error ? err.message : 'Import failed.');
    }
  };

  const handleRetryAnalysis = async () => {
    if (!repository) return;
    await fetch('/api/repositories/analyze', {
      method: 'POST',
      headers: buildApiHeaders(credentials, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ url: repository.url, forceRefresh: true }),
    });
    const res = await fetch(`/api/repositories/${encodeURIComponent(targetRepoId)}/analysis`);
    if (res.ok) {
      const json = await safeJson<{ repository: RepositoryRecord }>(res);
      setRepository(json.repository);
    }
  };

  const handleAttachCode = useCallback(
    async (att: CodeAttachment) => {
      setAttachedCode(att);
      if (att.file_path && att.start_line && att.end_line) {
        // If dragged from Diagram Explorer, fetch the actual line range when fileData isn't already open for it
        if (fileData?.file.path === att.file_path) {
          const lines = fileData.content
            .split('\n')
            .slice(att.start_line - 1, att.end_line)
            .join('\n');
          if (lines.trim()) {
            setAttachedCode({ ...att, code: lines.slice(0, 2500) });
          }
          return;
        }
        try {
          const res = await fetch(
            `/api/repositories/${encodeURIComponent(targetRepoId)}/files/content?path=${encodeURIComponent(att.file_path)}`
          );
          if (res.ok) {
            const json = await safeJson<FileContentResponse>(res);
            const lines = json.content
              .split('\n')
              .slice(att.start_line - 1, att.end_line)
              .join('\n');
            if (lines.trim()) {
              setAttachedCode({ ...att, code: lines.slice(0, 2500) });
            }
          }
        } catch {
          // keep initial attachment
        }
      }
    },
    [fileData, targetRepoId]
  );

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-[#0B0D10] text-[#E6E9EF]">
      {/* Workspace Header Bar */}
      <header className="flex h-12 shrink-0 items-center justify-between gap-4 border-b border-[#232832] bg-[#111419] px-4">
        <div className="flex items-center gap-3 min-w-0">
          <Link
            to="/"
            className="flex items-center gap-1.5 text-xs font-medium text-[#9CA3AF] hover:text-[#F3F4F6] whitespace-nowrap shrink-0"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>Codebase Tutor</span>
          </Link>
          <span className="text-[#323947]">/</span>

          {/* Repository Switcher */}
          <select
            aria-label="Select repository"
            value={targetRepoId}
            onChange={(e) => navigate(`/workspace/${encodeURIComponent(e.target.value)}`)}
            className="max-w-[240px] rounded border border-[#232832] bg-[#0B0D10] px-2.5 py-1 font-mono text-xs text-[#E6E9EF] focus:border-sky-500 focus:outline-none"
          >
            {repositories.map((r) => (
              <option key={r.id} value={r.id}>
                {r.fullName} {r.isFeaturedDemo ? '(Demo)' : ''}
              </option>
            ))}
            {!repositories.some((r) => r.id === targetRepoId) && (
              <option value={targetRepoId}>{targetRepoId.replace('__', '/')}</option>
            )}
          </select>

          <button
            type="button"
            onClick={() => setShowImportModal(true)}
            className="inline-flex items-center gap-1 rounded border border-[#232832] bg-[#161A21] px-2 py-1 text-[11px] font-medium text-[#D1D5DB] hover:border-sky-500/50 cursor-pointer whitespace-nowrap shrink-0"
          >
            <Plus className="h-3 w-3" />
            <span>Import Repo</span>
          </button>

          {repository?.commitSha && (
            <span className="hidden lg:inline font-mono text-[11px] tabular-nums text-[#6B7280] whitespace-nowrap">
              {repository.defaultBranch} · {repository.commitSha.slice(0, 7)}
            </span>
          )}
        </div>

        {/* Right Panel Mode Switcher */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center rounded-md border border-[#232832] bg-[#0B0D10] p-0.5">
            <button
              type="button"
              onClick={() => setExplorationMode('diagrams')}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                explorationMode === 'diagrams'
                  ? 'bg-sky-500/15 text-sky-300'
                  : 'text-[#9CA3AF] hover:text-[#E6E9EF]'
              }`}
            >
              <Network className="h-3.5 w-3.5" />
              <span>Architecture & Diagrams</span>
            </button>
            <button
              type="button"
              onClick={() => setExplorationMode('code')}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                explorationMode === 'code'
                  ? 'bg-sky-500/15 text-sky-300'
                  : 'text-[#9CA3AF] hover:text-[#E6E9EF]'
              }`}
            >
              <Code2 className="h-3.5 w-3.5" />
              <span>Source Code</span>
            </button>
            <button
              type="button"
              onClick={() => setExplorationMode('overview')}
              className={`flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                explorationMode === 'overview'
                  ? 'bg-sky-500/15 text-sky-300'
                  : 'text-[#9CA3AF] hover:text-[#E6E9EF]'
              }`}
            >
              <Compass className="h-3.5 w-3.5" />
              <span>Overview & Walkthrough</span>
            </button>
          </div>

          {repository && (
            <a
              href={repository.url}
              target="_blank"
              rel="noopener noreferrer"
              title="Open repository on GitHub"
              className="rounded border border-[#232832] p-1.5 text-[#9CA3AF] hover:text-[#E6E9EF]"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          )}
        </div>
      </header>

      {/* Main Content: Loading / Error OR Three Resizable Panels */}
      {!repository || (repository.stage !== 'ready' && repository.stage !== 'error') ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center">
          <Loader2 className="h-7 w-7 animate-spin text-sky-400 mb-3" />
          <h2 className="text-sm font-semibold text-[#F3F4F6]">
            Analyzing {repository?.fullName ?? targetRepoId.replace('__', '/')}...
          </h2>
          <p className="mt-1 text-xs text-[#9CA3AF]">
            {repository?.stageMessage ?? 'Fetching repository and running static analysis...'}
          </p>
          {repository && (
            <div className="mt-4 w-64 overflow-hidden rounded-full bg-[#1A1F28] h-1.5">
              <div
                className="h-full bg-sky-500 transition-all duration-300"
                style={{ width: `${repository.progress}%` }}
              />
            </div>
          )}
        </div>
      ) : repository.stage === 'error' ? (
        <div className="flex flex-1 flex-col items-center justify-center p-8 text-center space-y-3">
          <AlertCircle className="h-7 w-7 text-rose-400" />
          <h2 className="text-sm font-semibold text-[#F3F4F6]">
            Failed to analyze {repository.fullName}
          </h2>
          <p className="max-w-md text-xs text-rose-300">{repository.error || repository.stageMessage}</p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => void handleRetryAnalysis()}
              className="inline-flex items-center gap-1.5 rounded-md bg-sky-500 px-3.5 py-2 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 cursor-pointer"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              <span>Retry Analysis</span>
            </button>
            <Link
              to="/"
              className="rounded-md border border-[#232832] px-3.5 py-2 text-xs text-[#D1D5DB] hover:text-white"
            >
              Back to Explore
            </Link>
          </div>
        </div>
      ) : (
        <div ref={containerRef} className="flex flex-1 min-h-0 overflow-hidden select-text">
          {/* Panel A: Chat */}
          <div style={{ width: `${leftWidth}%` }} className="h-full min-w-[240px] shrink-0">
            <ChatPanel
              repositoryName={repository.name}
              messages={messages}
              loading={chatLoading}
              context={currentChatContext}
              credentials={credentials}
              hasCustomGeminiKey={Boolean(credentials.geminiApiKey.trim())}
              onQuickApplyGeminiKey={handleQuickApplyGeminiKey}
              onClearAttachedCode={() => setAttachedCode(undefined)}
              onAttachCode={(att) => void handleAttachCode(att)}
              onSendMessage={(q) => void sendQuestion(q)}
              onClearChat={() => setMessages([])}
              onOpenCitation={(fp, s, e) => openCodeLocation(fp, s, e)}
              onTraceCode={handleTraceCode}
            />
          </div>

          {/* Resize Handle 1 */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={() => {
              draggingDivider.current = 'left';
            }}
            className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-sky-500/40 transition-colors"
          />

          {/* Panel B: File Explorer */}
          <div style={{ width: `${midWidth}%` }} className="h-full min-w-[200px] shrink-0">
            <FileExplorerPanel
              tree={tree}
              filesMeta={filesMeta}
              selectedFilePath={selectedFilePath}
              onSelectFile={handleSelectFile}
              incomingDeps={fileData?.incomingDependencies ?? []}
              outgoingDeps={fileData?.outgoingDependencies ?? []}
            />
          </div>

          {/* Resize Handle 2 */}
          <div
            role="separator"
            aria-orientation="vertical"
            onMouseDown={() => {
              draggingDivider.current = 'mid';
            }}
            className="w-1 shrink-0 cursor-col-resize bg-transparent hover:bg-sky-500/40 transition-colors"
          />

          {/* Panel C: Code & Visual Exploration */}
          <div className="flex-1 h-full min-w-[360px]">
            {explorationMode === 'diagrams' ? (
              <DiagramExplorerPanel
                repositoryId={repository.id}
                activeDiagramType={activeDiagramType}
                onChangeDiagramType={setActiveDiagramType}
                selectedGraphNodeId={selectedGraphNodeId}
                onSelectGraphNode={handleSelectDiagramNode}
                onOpenCodeLocation={openCodeLocation}
                onAskAboutDiagramItem={(q, node?: DiagramVisualNode, edge?: DiagramVisualEdge) => {
                  const overrideCtx: ChatContext = {
                    ...currentChatContext,
                    selectedDiagramType: activeDiagramType,
                    selectedNodeId: node?.id ?? currentChatContext.selectedNodeId,
                    selectedNodeName: node?.label ?? currentChatContext.selectedNodeName,
                    selectedEdgeId: edge?.id,
                  };
                  void sendQuestion(q, overrideCtx);
                }}
              />
            ) : explorationMode === 'code' ? (
              <SourceCodePanel
                fileData={fileData}
                loading={fileLoading}
                repoUrl={repository.url}
                highlightRange={highlightRange}
                selectedSymbolId={selectedSymbolId}
                onSelectSymbol={handleSelectSymbol}
                onAttachCodeToChat={(att) => setAttachedCode(att)}
                onAskAboutCode={(att, q) => {
                  setAttachedCode(att);
                  void sendQuestion(q, {
                    ...currentChatContext,
                    selectedFilePath: att.file_path,
                    selectedCodeRange: { start_line: att.start_line, end_line: att.end_line },
                    attachedCode: att,
                  });
                }}
              />
            ) : (
              <OverviewWalkthroughPanel
                repository={repository}
                onOpenCodeLocation={openCodeLocation}
                onOpenDiagram={(type) => {
                  setActiveDiagramType(type);
                  setExplorationMode('diagrams');
                }}
                onAskQuestion={(q) => void sendQuestion(q)}
              />
            )}
          </div>
        </div>
      )}

      {/* Quick Import Modal */}
      {showImportModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-md rounded-xl border border-[#232832] bg-[#111419] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-[#F3F4F6]">Import GitHub Repository</h3>
              <button
                type="button"
                onClick={() => setShowImportModal(false)}
                className="text-xs text-[#9CA3AF] hover:text-white cursor-pointer"
              >
                Close
              </button>
            </div>
            <form onSubmit={handleQuickImport} className="space-y-3">
              <input
                type="text"
                value={importUrl}
                onChange={(e) => setImportUrl(e.target.value)}
                placeholder="https://github.com/owner/repository"
                autoFocus
                className="w-full rounded-md border border-[#232832] bg-[#0B0D10] px-3 py-2 font-mono text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
              />
              {importError && <p className="text-xs text-rose-400">{importError}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowImportModal(false)}
                  className="rounded-md border border-[#232832] px-3 py-1.5 text-xs text-[#9CA3AF] hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="rounded-md bg-sky-500 px-3.5 py-1.5 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 cursor-pointer"
                >
                  Analyze & Open
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

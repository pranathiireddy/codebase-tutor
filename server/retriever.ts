import type { AnalyzedRepoData } from './repoStore.ts';
import type { ChatCitation, ChatContext } from '../src/types/codebase.ts';

export interface RetrievedEvidence {
  contextSummary: string;
  evidenceBlocks: string[];
  candidateCitations: ChatCitation[];
}

function sliceLines(content: string, startLine: number, endLine: number): string {
  const lines = content.split('\n');
  const s = Math.max(1, startLine);
  const e = Math.min(lines.length, endLine);
  return lines
    .slice(s - 1, e)
    .map((line, idx) => `${s + idx}: ${line}`)
    .join('\n');
}

export function retrieveRepositoryEvidence(
  repo: AnalyzedRepoData,
  question: string,
  ctx: ChatContext
): RetrievedEvidence {
  const blocks: string[] = [];
  const citations: ChatCitation[] = [];
  const seenFiles = new Set<string>();

  const addFileSnippet = (filePath: string, startLine: number, endLine: number, reason: string): void => {
    const content = repo.analysis.fileContents[filePath];
    if (!content) return;
    const key = `${filePath}:${startLine}-${endLine}`;
    if (seenFiles.has(key)) return;
    seenFiles.add(key);

    const cappedEnd = Math.min(endLine, startLine + 80);
    const numbered = sliceLines(content, startLine, cappedEnd);
    blocks.push(`FILE: ${filePath} (lines ${startLine}-${cappedEnd}) [${reason}]\n${numbered}`);
    citations.push({
      file_path: filePath,
      start_line: startLine,
      end_line: cappedEnd,
      label: `${filePath}:${startLine}-${cappedEnd}`,
    });
  };

  // 1. Repository overview summary
  const overview = repo.record.overview;
  const overviewText = [
    `Repository: ${repo.record.fullName} (commit ${repo.record.commitSha.slice(0, 8)})`,
    `Description: ${overview?.summary ?? repo.record.description}`,
    `Languages: ${(overview?.languages ?? []).map((l) => `${l.name} (${l.percentage}%)`).join(', ') || 'Unknown'}`,
    `Frameworks/Patterns: ${(overview?.frameworks ?? []).join(', ') || 'None detected'}`,
    `Entry points: ${(overview?.entryPoints ?? []).map((e) => `${e.file_path} (${e.reason})`).join('; ') || 'None verified'}`,
    `Major modules: ${(overview?.majorModules ?? []).slice(0, 6).map((m) => `${m.name} (${m.fileCount} files)`).join(', ')}`,
  ].join('\n');

  // 2. Attached code block from drag-and-drop or editor selection
  if (ctx.attachedCode) {
    blocks.push(
      `USER ATTACHED CODE BLOCK (${ctx.attachedCode.file_path}:${ctx.attachedCode.start_line}-${ctx.attachedCode.end_line}):\n${ctx.attachedCode.code}`
    );
    citations.push({
      file_path: ctx.attachedCode.file_path,
      start_line: ctx.attachedCode.start_line,
      end_line: ctx.attachedCode.end_line,
      label: `${ctx.attachedCode.file_path}:${ctx.attachedCode.start_line}-${ctx.attachedCode.end_line}`,
    });
  }

  // 3. Selected symbol & graph neighbors
  if (ctx.selectedSymbolId) {
    const sym = repo.analysis.symbols.find((s) => s.id === ctx.selectedSymbolId);
    if (sym) {
      addFileSnippet(sym.file_path, sym.start_line, sym.end_line, `Selected ${sym.kind} ${sym.name}`);
      const relatedEdges = repo.graph.edges.filter((e) => e.source === sym.id || e.target === sym.id).slice(0, 8);
      if (relatedEdges.length > 0) {
        const edgeDesc = relatedEdges
          .map((e) => `${e.source} --[${e.relationship} (${e.confidence})]--> ${e.target}`)
          .join('\n');
        blocks.push(`GRAPH NEIGHBORS FOR ${sym.name}:\n${edgeDesc}`);
      }
    }
  }

  // 4. Selected diagram node / edge
  if (ctx.selectedDiagramType && ctx.selectedNodeId) {
    const diag = repo.diagrams[ctx.selectedDiagramType];
    const node = diag?.nodes.find((n) => n.id === ctx.selectedNodeId || n.graphNodeId === ctx.selectedNodeId);
    if (node) {
      blocks.push(
        `SELECTED DIAGRAM NODE (${diag.title}): ${node.label} (${node.category})\nDescription: ${node.description}\nAssociated files: ${(node.associatedFiles ?? []).join(', ') || node.file_path || 'None'}`
      );
      if (node.file_path) {
        addFileSnippet(
          node.file_path,
          node.start_line ?? 1,
          node.end_line ?? 55,
          `Diagram node ${node.label}`
        );
      }
      const nodeEdges = diag.edges
        .filter((e) => e.source === node.id || e.target === node.id)
        .slice(0, 8);
      if (nodeEdges.length > 0) {
        blocks.push(
          `CONNECTED EDGES FOR NODE ${node.label}:\n` +
            nodeEdges.map((e) => `${e.source} --[${e.label} | ${e.confidence}]--> ${e.target}`).join('\n')
        );
      }
    }
  }

  // 5. Selected file in explorer / code viewer
  if (ctx.selectedFilePath) {
    const start = ctx.selectedCodeRange?.start_line ?? 1;
    const end = ctx.selectedCodeRange?.end_line ?? 75;
    addFileSnippet(ctx.selectedFilePath, start, end, 'Currently open file');
    const fileEdges = repo.graph.edges
      .filter((e) => e.source === `file:${ctx.selectedFilePath}` || e.target === `file:${ctx.selectedFilePath}`)
      .slice(0, 10);
    if (fileEdges.length > 0) {
      blocks.push(
        `FILE DEPENDENCIES FOR ${ctx.selectedFilePath}:\n` +
          fileEdges.map((e) => `${e.source} --[${e.relationship}]--> ${e.target}`).join('\n')
      );
    }
  }

  // 6. Keyword & symbol retrieval from the user's question
  const tokens = question
    .toLowerCase()
    .split(/[^a-z0-9_.-]+/)
    .filter((t) => t.length >= 3 && !['the', 'and', 'for', 'this', 'that', 'what', 'does', 'how', 'where', 'why', 'with', 'from'].includes(t));

  if (tokens.length > 0) {
    // Score symbols
    const scoredSymbols = repo.analysis.symbols
      .map((sym) => {
        const hay = `${sym.name} ${sym.file_path} ${sym.description}`.toLowerCase();
        const score = tokens.reduce((acc, tok) => acc + (hay.includes(tok) ? 1 : 0), 0);
        return { sym, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { sym } of scoredSymbols) {
      addFileSnippet(sym.file_path, sym.start_line, sym.end_line, `Matched symbol ${sym.name}`);
    }

    // Score files
    const scoredFiles = repo.analysis.filesMeta
      .filter((f) => f.role !== 'asset')
      .map((f) => {
        const content = repo.analysis.fileContents[f.path] ?? '';
        const hay = `${f.path} ${f.summary}`.toLowerCase();
        let score = tokens.reduce((acc, tok) => acc + (hay.includes(tok) ? 3 : 0), 0);
        if (score === 0 && content) {
          const lc = content.slice(0, 6000).toLowerCase();
          score = tokens.reduce((acc, tok) => acc + (lc.includes(tok) ? 1 : 0), 0);
        }
        return { file: f, score };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);

    for (const { file } of scoredFiles) {
      addFileSnippet(file.path, 1, 60, 'Keyword/content match');
    }
  }

  // 7. Always include README & primary entry point for repository-wide grounding if blocks are sparse
  if (blocks.length < 3) {
    const readme = repo.analysis.filesMeta.find((f) => f.path.toLowerCase() === 'readme.md');
    if (readme) addFileSnippet(readme.path, 1, 70, 'Repository README');
    const ep = repo.analysis.entryPoints[0];
    if (ep) addFileSnippet(ep.file_path, 1, 65, `Entry point (${ep.reason})`);
    const pkg = repo.analysis.filesMeta.find((f) => f.path === 'package.json');
    if (pkg) addFileSnippet(pkg.path, 1, 60, 'Package manifest');
  }

  // Trim total evidence size safely for model context
  const cappedBlocks = blocks.slice(0, 8);
  const contextParts: string[] = [];
  if (ctx.selectedFilePath) contextParts.push(`File: ${ctx.selectedFilePath}`);
  if (ctx.selectedSymbolName) contextParts.push(`Symbol: ${ctx.selectedSymbolName}`);
  if (ctx.selectedNodeName) contextParts.push(`Node: ${ctx.selectedNodeName}`);
  if (ctx.attachedCode) contextParts.push(`Attached snippet (${ctx.attachedCode.file_path}:${ctx.attachedCode.start_line}-${ctx.attachedCode.end_line})`);

  return {
    contextSummary: `${overviewText}\n\nActive Workspace Focus: ${contextParts.join(' · ') || 'Repository-wide overview'}`,
    evidenceBlocks: cappedBlocks,
    candidateCitations: citations.slice(0, 10),
  };
}

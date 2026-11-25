import * as yaml from 'js-yaml';
import type { IngestedFile } from './github.ts';
import type {
  AnalyzedFileMeta,
  EntryPointInfo,
  ExtractedSymbol,
  FileRole,
  FileTreeNode,
  ImportInfo,
} from '../src/types/codebase.ts';

export interface WorkflowJobSpec {
  workflowFile: string;
  workflowName: string;
  triggers: string[];
  jobId: string;
  jobName: string;
  needs: string[];
  runsOn: string;
  steps: { name: string; uses?: string; run?: string }[];
  start_line: number;
  end_line: number;
}

export interface DeploymentUnitSpec {
  sourceFile: string;
  kind: 'container' | 'service' | 'database' | 'proxy' | 'cloud_config';
  name: string;
  imageOrBase?: string;
  ports: string[];
  dependsOn: string[];
  commands: string[];
  start_line: number;
  end_line: number;
}

export interface AnalysisResult {
  filesMeta: AnalyzedFileMeta[];
  fileContents: Record<string, string>;
  fileTree: FileTreeNode[];
  symbols: ExtractedSymbol[];
  languages: { name: string; files: number; percentage: number }[];
  frameworks: string[];
  packageManagers: string[];
  testFrameworks: string[];
  infrastructureTools: string[];
  entryPoints: EntryPointInfo[];
  workflowJobs: WorkflowJobSpec[];
  deploymentUnits: DeploymentUnitSpec[];
  readmeSummary: string;
  coverageNotes: string[];
}

export function detectLanguage(filePath: string, isBinary: boolean): string {
  if (isBinary) return 'Binary Asset';
  const base = (filePath.split('/').pop() ?? '').toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'Dockerfile';
  if (base === 'makefile') return 'Makefile';
  if (base === 'jenkinsfile') return 'Groovy';

  const dot = base.lastIndexOf('.');
  if (dot === -1) return 'Plain Text';
  const ext = base.slice(dot);
  const map: Record<string, string> = {
    '.ts': 'TypeScript',
    '.tsx': 'TypeScript',
    '.mts': 'TypeScript',
    '.cts': 'TypeScript',
    '.d.ts': 'TypeScript',
    '.js': 'JavaScript',
    '.jsx': 'JavaScript',
    '.mjs': 'JavaScript',
    '.cjs': 'JavaScript',
    '.py': 'Python',
    '.go': 'Go',
    '.rs': 'Rust',
    '.java': 'Java',
    '.kt': 'Kotlin',
    '.rb': 'Ruby',
    '.php': 'PHP',
    '.cs': 'C#',
    '.cpp': 'C++',
    '.c': 'C',
    '.h': 'C/C++',
    '.sh': 'Shell',
    '.bash': 'Shell',
    '.zsh': 'Shell',
    '.ps1': 'PowerShell',
    '.yml': 'YAML',
    '.yaml': 'YAML',
    '.json': 'JSON',
    '.toml': 'TOML',
    '.md': 'Markdown',
    '.mdx': 'Markdown',
    '.css': 'CSS',
    '.scss': 'CSS',
    '.html': 'HTML',
    '.sql': 'SQL',
    '.svg': 'SVG',
    '.txt': 'Plain Text',
  };
  return map[ext] ?? 'Other';
}

function isTsOrJs(lang: string): boolean {
  return lang === 'TypeScript' || lang === 'JavaScript';
}

function findBraceBlockEnd(lines: string[], startIdx: number): number {
  let depth = 0;
  let opened = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    let inSingle = false;
    let inDouble = false;
    let inTemplate = false;
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      const prev = c > 0 ? line[c - 1] : '';
      if (ch === '/' && line[c + 1] === '/' && !inSingle && !inDouble && !inTemplate) break;
      if (ch === "'" && !inDouble && !inTemplate && prev !== '\\') inSingle = !inSingle;
      else if (ch === '"' && !inSingle && !inTemplate && prev !== '\\') inDouble = !inDouble;
      else if (ch === '`' && !inSingle && !inDouble && prev !== '\\') inTemplate = !inTemplate;
      else if (!inSingle && !inDouble && !inTemplate) {
        if (ch === '{') {
          depth++;
          opened = true;
        } else if (ch === '}') {
          depth--;
          if (opened && depth <= 0) {
            return i + 1;
          }
        }
      }
    }
    if (!opened && i > startIdx + 2 && line.trim().endsWith(';')) {
      return i + 1;
    }
  }
  return Math.min(lines.length, startIdx + 15);
}

function extractJsCalls(lines: string[], startIdx: number, endLine: number): string[] {
  const calls = new Set<string>();
  const skip = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'await', 'new',
    'function', 'import', 'require', 'console', 'Object', 'Array', 'JSON', 'Math', 'Promise',
  ]);
  for (let i = startIdx + 1; i < Math.min(endLine, lines.length); i++) {
    const matches = lines[i].matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)?)\s*\(/g);
    for (const m of matches) {
      const name = m[1];
      if (!skip.has(name) && !skip.has(name.split('.')[0])) {
        calls.add(name);
        if (name.includes('.')) calls.add(name.split('.').pop()!);
      }
    }
  }
  return Array.from(calls);
}

function parseParamsList(rawParams: string): string[] {
  if (!rawParams.trim()) return [];
  return rawParams
    .split(',')
    .map((p) => p.trim().split(':')[0]?.split('=')[0]?.trim())
    .filter(Boolean);
}

function parseTsOrJsFile(
  filePath: string,
  content: string,
  language: string
): {
  imports: ImportInfo[];
  exports: string[];
  symbols: ExtractedSymbol[];
} {
  const lines = content.split('\n');
  const imports: ImportInfo[] = [];
  const exports: string[] = [];
  const symbols: ExtractedSymbol[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // ES import statements (single-line or starting line)
    const impMatch = trimmed.match(/^import\s+(?:type\s+)?(?:(.+?)\s+from\s+)?['"]([^'"]+)['"]/);
    if (impMatch) {
      const clause = impMatch[1] ?? '';
      const specifiers = clause
        .replace(/[{}]/g, ' ')
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/).pop()?.trim())
        .filter((s): s is string => Boolean(s));
      imports.push({ source: impMatch[2], specifiers, line: i + 1 });
      continue;
    }

    // Multi-line import tail: } from '...'
    const fromTail = trimmed.match(/^\}?\s*from\s+['"]([^'"]+)['"]/);
    if (fromTail && !trimmed.startsWith('export')) {
      imports.push({ source: fromTail[1], specifiers: [], line: i + 1 });
      continue;
    }

    // CommonJS require('...')
    const reqMatches = trimmed.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g);
    for (const rm of reqMatches) {
      imports.push({ source: rm[1], specifiers: [], line: i + 1 });
    }

    // Class declaration
    const classMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+extends\s+([A-Za-z0-9_$.]+))?(?:\s+implements\s+([A-Za-z0-9_$.\s,]+))?/);
    if (classMatch) {
      const className = classMatch[1];
      const endLine = findBraceBlockEnd(lines, i);
      if (trimmed.startsWith('export')) exports.push(className);
      const methods: string[] = [];
      const attributes: string[] = [];
      for (let j = i + 1; j < Math.min(endLine - 1, lines.length); j++) {
        const mTrim = lines[j].trim();
        const methodMatch = mTrim.match(/^(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^)]*)\)/);
        if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
          methods.push(methodMatch[1]);
          const mEnd = findBraceBlockEnd(lines, j);
          symbols.push({
            id: `method:${filePath}:${className}.${methodMatch[1]}:${j + 1}`,
            kind: 'method',
            name: `${className}.${methodMatch[1]}`,
            parent_class: className,
            file_path: filePath,
            start_line: j + 1,
            end_line: mEnd,
            language,
            signature: `${methodMatch[1]}(${parseParamsList(methodMatch[2]).join(', ')})`,
            parameters: parseParamsList(methodMatch[2]),
            calls: extractJsCalls(lines, j, mEnd),
            description: `Method ${methodMatch[1]} on class ${className}`,
            confidence: 'verified',
          });
        } else {
          const propMatch = mTrim.match(/^(?:readonly\s+|private\s+|public\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::|=|;)/);
          if (propMatch && !['return', 'const', 'let', 'var', 'this'].includes(propMatch[1])) {
            attributes.push(propMatch[1]);
          }
        }
      }

      symbols.push({
        id: `class:${filePath}:${className}:${i + 1}`,
        kind: 'class',
        name: className,
        file_path: filePath,
        start_line: i + 1,
        end_line: endLine,
        language,
        extends_name: classMatch[2],
        implements_names: classMatch[3] ? classMatch[3].split(',').map((s) => s.trim()).filter(Boolean) : [],
        methods,
        attributes,
        calls: extractJsCalls(lines, i, endLine),
        description: `Class ${className} in ${filePath}`,
        confidence: 'verified',
      });
      continue;
    }

    // Function declaration: function name(...)
    const fnMatch = trimmed.match(/^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/);
    if (fnMatch) {
      const fnName = fnMatch[1];
      const params = parseParamsList(fnMatch[2]);
      const endLine = findBraceBlockEnd(lines, i);
      if (trimmed.startsWith('export')) exports.push(fnName);
      symbols.push({
        id: `fn:${filePath}:${fnName}:${i + 1}`,
        kind: 'function',
        name: fnName,
        file_path: filePath,
        start_line: i + 1,
        end_line: endLine,
        language,
        signature: `${fnName}(${params.join(', ')})`,
        parameters: params,
        calls: extractJsCalls(lines, i, endLine),
        description: `Function ${fnName}(${params.join(', ')}) defined in ${filePath}`,
        confidence: 'verified',
      });
      continue;
    }

    // Arrow / function expression assigned to const/let: const foo = (...) => ...
    const arrowMatch = trimmed.match(/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][A-Za-z0-9_$]*))\s*(?::\s*[^=]+)?=>/);
    if (arrowMatch) {
      const fnName = arrowMatch[1];
      const params = parseParamsList(arrowMatch[2] ?? arrowMatch[3] ?? '');
      const endLine = findBraceBlockEnd(lines, i);
      if (trimmed.startsWith('export')) exports.push(fnName);
      symbols.push({
        id: `fn:${filePath}:${fnName}:${i + 1}`,
        kind: 'function',
        name: fnName,
        file_path: filePath,
        start_line: i + 1,
        end_line: endLine,
        language,
        signature: `${fnName}(${params.join(', ')})`,
        parameters: params,
        calls: extractJsCalls(lines, i, endLine),
        description: `Function ${fnName}(${params.join(', ')}) defined in ${filePath}`,
        confidence: 'verified',
      });
      continue;
    }

    // Express / HTTP route handlers: app.get('/api/...', ...)
    const routeMatch = trimmed.match(/\b(?:app|router|server|api)\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]/i);
    if (routeMatch) {
      const endLine = findBraceBlockEnd(lines, i);
      symbols.push({
        id: `route:${filePath}:${routeMatch[1].toUpperCase()}:${routeMatch[2]}:${i + 1}`,
        kind: 'api_route',
        name: `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`,
        file_path: filePath,
        start_line: i + 1,
        end_line: endLine,
        language,
        signature: `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`,
        calls: extractJsCalls(lines, i, endLine),
        description: `HTTP route handler ${routeMatch[1].toUpperCase()} ${routeMatch[2]}`,
        confidence: 'verified',
      });
    }

    // CommonJS module.exports
    const cjsExp = trimmed.match(/module\.exports\s*=\s*\{([^}]+)\}/);
    if (cjsExp) {
      cjsExp[1].split(',').forEach((e) => {
        const clean = e.trim().split(':')[0]?.trim();
        if (clean) exports.push(clean);
      });
    }
  }

  return {
    imports,
    exports: Array.from(new Set(exports)),
    symbols,
  };
}

function parsePythonFile(
  filePath: string,
  content: string
): {
  imports: ImportInfo[];
  exports: string[];
  symbols: ExtractedSymbol[];
} {
  const lines = content.split('\n');
  const imports: ImportInfo[] = [];
  const exports: string[] = [];
  const symbols: ExtractedSymbol[] = [];

  const getIndent = (line: string): number => {
    const m = line.match(/^(\s*)/);
    return m ? m[1].length : 0;
  };

  const findBlockEnd = (startIdx: number, baseIndent: number): number => {
    let lastNonEmpty = startIdx;
    for (let i = startIdx + 1; i < lines.length; i++) {
      const raw = lines[i];
      const trimmed = raw.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (getIndent(raw) <= baseIndent) break;
      lastNonEmpty = i;
    }
    return lastNonEmpty + 1;
  };

  const extractCallsFromRange = (startIdx: number, endLine: number): string[] => {
    const calls = new Set<string>();
    const pyKeywords = new Set(['if', 'for', 'while', 'with', 'return', 'print', 'len', 'str', 'int', 'float', 'list', 'dict', 'set', 'range', 'enumerate', 'isinstance', 'super', 'def', 'class']);
    for (let i = startIdx + 1; i < Math.min(endLine, lines.length); i++) {
      const matches = lines[i].matchAll(/\b([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)?)\s*\(/g);
      for (const m of matches) {
        const name = m[1];
        if (!pyKeywords.has(name)) {
          calls.add(name);
          if (name.includes('.')) calls.add(name.split('.').pop()!);
        }
      }
    }
    return Array.from(calls);
  };

  let currentClass: { name: string; indent: number; methods: string[]; attributes: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    const indent = getIndent(raw);

    if (currentClass && trimmed && !trimmed.startsWith('#') && indent <= currentClass.indent) {
      currentClass = null;
    }

    // Imports
    const impMatch = trimmed.match(/^import\s+([A-Za-z0-9_.,\s]+)/);
    if (impMatch) {
      for (const mod of impMatch[1].split(',')) {
        const clean = mod.trim().split(/\s+as\s+/)[0]?.trim();
        if (clean) imports.push({ source: clean, specifiers: [], line: i + 1 });
      }
      continue;
    }

    const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_.]+)\s+import\s+(.+)/);
    if (fromMatch) {
      const specs = fromMatch[2]
        .split(',')
        .map((s) => s.trim().split(/\s+as\s+/)[0]?.trim())
        .filter(Boolean);
      imports.push({ source: fromMatch[1], specifiers: specs, line: i + 1 });
      continue;
    }

    // Class definition
    const classMatch = trimmed.match(/^class\s+([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?\s*:/);
    if (classMatch) {
      const className = classMatch[1];
      const bases = (classMatch[2] ?? '')
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean);
      const endLine = findBlockEnd(i, indent);
      const clsMeta = { name: className, indent, methods: [] as string[], attributes: [] as string[] };
      currentClass = clsMeta;

      // Scan attributes inside class (self.x = ...)
      const attrSet = new Set<string>();
      for (let j = i + 1; j < Math.min(endLine, lines.length); j++) {
        const attrMatch = lines[j].match(/self\.([A-Za-z_][A-Za-z0-9_]*)\s*=/);
        if (attrMatch) attrSet.add(attrMatch[1]);
      }

      exports.push(className);
      symbols.push({
        id: `class:${filePath}:${className}:${i + 1}`,
        kind: 'class',
        name: className,
        file_path: filePath,
        start_line: i + 1,
        end_line: endLine,
        language: 'Python',
        extends_name: bases[0],
        implements_names: bases.slice(1),
        methods: clsMeta.methods,
        attributes: Array.from(attrSet),
        calls: extractCallsFromRange(i, endLine),
        description: `Python class ${className} in ${filePath}`,
        confidence: 'verified',
      });
      continue;
    }

    // Function / method definition
    const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)(?:\s*->\s*([^:]+))?\s*:/);
    if (defMatch) {
      const fnName = defMatch[1];
      const params = defMatch[2]
        .split(',')
        .map((p) => p.trim().split(':')[0]?.split('=')[0]?.trim())
        .filter((p) => p && p !== 'self' && p !== 'cls');
      const retType = defMatch[3]?.trim();
      const endLine = findBlockEnd(i, indent);
      const calls = extractCallsFromRange(i, endLine);

      // Check previous line for FastAPI/Flask route decorator
      if (i > 0) {
        const prev = lines[i - 1].trim();
        const routeMatch = prev.match(/^@(?:app|router|bp)\.(get|post|put|patch|delete|route)\(\s*['"]([^'"]+)['"]/i);
        if (routeMatch) {
          symbols.push({
            id: `route:${filePath}:${routeMatch[1].toUpperCase()}:${routeMatch[2]}:${i}`,
            kind: 'api_route',
            name: `${routeMatch[1].toUpperCase()} ${routeMatch[2]}`,
            file_path: filePath,
            start_line: i,
            end_line: endLine,
            language: 'Python',
            signature: `${routeMatch[1].toUpperCase()} ${routeMatch[2]} -> ${fnName}`,
            calls,
            description: `Python HTTP route ${routeMatch[1].toUpperCase()} ${routeMatch[2]} handled by ${fnName}`,
            confidence: 'verified',
          });
        }
      }

      if (currentClass && indent > currentClass.indent) {
        currentClass.methods.push(fnName);
        symbols.push({
          id: `method:${filePath}:${currentClass.name}.${fnName}:${i + 1}`,
          kind: 'method',
          name: `${currentClass.name}.${fnName}`,
          parent_class: currentClass.name,
          file_path: filePath,
          start_line: i + 1,
          end_line: endLine,
          language: 'Python',
          signature: `${fnName}(${params.join(', ')})`,
          parameters: params,
          return_type: retType,
          calls,
          description: `Method ${fnName} on class ${currentClass.name}`,
          confidence: 'verified',
        });
      } else {
        if (!fnName.startsWith('_')) exports.push(fnName);
        symbols.push({
          id: `fn:${filePath}:${fnName}:${i + 1}`,
          kind: 'function',
          name: fnName,
          file_path: filePath,
          start_line: i + 1,
          end_line: endLine,
          language: 'Python',
          signature: `${fnName}(${params.join(', ')})`,
          parameters: params,
          return_type: retType,
          calls,
          description: `Python function ${fnName}(${params.join(', ')}) in ${filePath}`,
          confidence: 'verified',
        });
      }
    }
  }

  return { imports, exports: Array.from(new Set(exports)), symbols };
}

function parseShellFunctions(filePath: string, content: string, language: string): ExtractedSymbol[] {
  const lines = content.split('\n');
  const symbols: ExtractedSymbol[] = [];
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const shMatch = trimmed.match(/^(?:function\s+)?([A-Za-z_][A-Za-z0-9_-]*)\s*\(\)\s*\{?/) ||
      trimmed.match(/^function\s+([A-Za-z_][A-Za-z0-9_-]*)\s*\{?/);
    if (shMatch) {
      symbols.push({
        id: `fn:${filePath}:${shMatch[1]}:${i + 1}`,
        kind: 'function',
        name: shMatch[1],
        file_path: filePath,
        start_line: i + 1,
        end_line: Math.min(lines.length, i + 15),
        language,
        signature: `${shMatch[1]}()`,
        calls: [],
        description: `${language} function ${shMatch[1]} in ${filePath}`,
        confidence: 'verified',
      });
    }
  }
  return symbols;
}

function parseWorkflowYaml(filePath: string, content: string): WorkflowJobSpec[] {
  const jobs: WorkflowJobSpec[] = [];
  try {
    const parsed = yaml.load(content) as Record<string, unknown> | null;
    if (!parsed || typeof parsed !== 'object') return jobs;

    const workflowName = typeof parsed.name === 'string' ? parsed.name : filePath.split('/').pop() ?? filePath;
    const rawOn = parsed.on;
    const triggers: string[] = [];
    if (typeof rawOn === 'string') triggers.push(rawOn);
    else if (Array.isArray(rawOn)) triggers.push(...rawOn.map(String));
    else if (rawOn && typeof rawOn === 'object') triggers.push(...Object.keys(rawOn));

    const rawJobs = parsed.jobs as Record<string, Record<string, unknown>> | undefined;
    if (!rawJobs || typeof rawJobs !== 'object') return jobs;

    const lines = content.split('\n');
    for (const [jobId, jobObj] of Object.entries(rawJobs)) {
      if (!jobObj || typeof jobObj !== 'object') continue;
      const lineIdx = lines.findIndex((l) => new RegExp(`^\\s*${jobId}\\s*:`).test(l));
      const startLine = lineIdx >= 0 ? lineIdx + 1 : 1;

      const needsRaw = jobObj.needs;
      const needs = Array.isArray(needsRaw) ? needsRaw.map(String) : typeof needsRaw === 'string' ? [needsRaw] : [];
      const rawSteps = Array.isArray(jobObj.steps) ? (jobObj.steps as Record<string, unknown>[]) : [];
      const steps = rawSteps.map((s) => ({
        name: typeof s.name === 'string' ? s.name : typeof s.uses === 'string' ? s.uses : 'Run command',
        uses: typeof s.uses === 'string' ? s.uses : undefined,
        run: typeof s.run === 'string' ? s.run.trim() : undefined,
      }));

      jobs.push({
        workflowFile: filePath,
        workflowName,
        triggers,
        jobId,
        jobName: typeof jobObj.name === 'string' ? jobObj.name : jobId,
        needs,
        runsOn: typeof jobObj['runs-on'] === 'string' ? jobObj['runs-on'] : 'ubuntu-latest',
        steps,
        start_line: startLine,
        end_line: Math.min(lines.length, startLine + Math.max(steps.length * 3, 6)),
      });
    }
  } catch {
    // Ignore malformed YAML safely
  }
  return jobs;
}

function parseDeploymentFiles(filePath: string, content: string): DeploymentUnitSpec[] {
  const units: DeploymentUnitSpec[] = [];
  const lower = filePath.toLowerCase();
  const lines = content.split('\n');

  if (lower.endsWith('dockerfile') || lower.includes('/dockerfile')) {
    let baseImage = '';
    const ports: string[] = [];
    const commands: string[] = [];
    for (const line of lines) {
      const t = line.trim();
      if (t.toUpperCase().startsWith('FROM ')) baseImage = t.slice(5).trim();
      if (t.toUpperCase().startsWith('EXPOSE ')) ports.push(t.slice(7).trim());
      if (t.toUpperCase().startsWith('CMD ') || t.toUpperCase().startsWith('ENTRYPOINT ')) {
        commands.push(t);
      }
    }
    units.push({
      sourceFile: filePath,
      kind: 'container',
      name: `Docker Container (${filePath})`,
      imageOrBase: baseImage || undefined,
      ports,
      dependsOn: [],
      commands,
      start_line: 1,
      end_line: lines.length,
    });
  } else if (/docker-compose.*\.ya?ml$/i.test(lower) || /compose\.ya?ml$/i.test(lower)) {
    try {
      const parsed = yaml.load(content) as Record<string, unknown> | null;
      const services = (parsed?.services ?? {}) as Record<string, Record<string, unknown>>;
      for (const [svcName, svc] of Object.entries(services)) {
        if (!svc || typeof svc !== 'object') continue;
        const lineIdx = lines.findIndex((l) => new RegExp(`^\\s*${svcName}\\s*:`).test(l));
        const img = typeof svc.image === 'string' ? svc.image : typeof svc.build === 'string' ? `build:${svc.build}` : undefined;
        const isDb = /postgres|mysql|mongo|redis|sqlite|mariadb|db/i.test(`${svcName} ${img ?? ''}`);
        const isProxy = /nginx|traefik|caddy|haproxy|proxy/i.test(`${svcName} ${img ?? ''}`);
        const deps = Array.isArray(svc.depends_on)
          ? svc.depends_on.map(String)
          : svc.depends_on && typeof svc.depends_on === 'object'
            ? Object.keys(svc.depends_on)
            : [];
        const ports = Array.isArray(svc.ports) ? svc.ports.map(String) : [];

        units.push({
          sourceFile: filePath,
          kind: isDb ? 'database' : isProxy ? 'proxy' : 'service',
          name: svcName,
          imageOrBase: img,
          ports,
          dependsOn: deps,
          commands: typeof svc.command === 'string' ? [svc.command] : [],
          start_line: lineIdx >= 0 ? lineIdx + 1 : 1,
          end_line: Math.min(lines.length, (lineIdx >= 0 ? lineIdx + 1 : 1) + 10),
        });
      }
    } catch {
      // ignore malformed yaml
    }
  }
  return units;
}

function resolveImportPath(fromFile: string, specifier: string, allPaths: Set<string>): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const dirParts = fromFile.split('/').slice(0, -1);
  const specParts = specifier.split('/');
  const combined = [...dirParts];
  for (const part of specParts) {
    if (part === '.' || part === '') continue;
    if (part === '..') combined.pop();
    else combined.push(part);
  }
  const base = combined.join('/');
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.py`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/__init__.py`,
  ];
  for (const c of candidates) {
    if (allPaths.has(c)) return c;
  }
  return undefined;
}

function classifyFileRole(
  filePath: string,
  content: string,
  language: string,
  symbols: ExtractedSymbol[],
  entryPointPaths: Set<string>,
  isBinary: boolean
): FileRole {
  if (isBinary) return 'asset';
  if (entryPointPaths.has(filePath)) return 'entry_point';

  const lower = filePath.toLowerCase();
  const base = lower.split('/').pop() ?? '';

  if (lower.includes('.github/workflows/') || base === 'dockerfile' || base.includes('docker-compose') || lower.endsWith('.tf')) {
    return 'infrastructure';
  }
  if (/\.(test|spec)\.[jt]sx?$/.test(lower) || lower.startsWith('tests/') || lower.includes('/tests/') || base.startsWith('test_') || base.endsWith('_test.py')) {
    return 'tests';
  }
  if (language === 'Markdown' || base === 'license' || lower.startsWith('docs/') || lower.startsWith('examples/') || lower.startsWith('i18n/')) {
    return 'documentation';
  }
  if (symbols.some((s) => s.kind === 'api_route')) {
    return 'api_route';
  }
  if (lower.includes('plugin') || lower.includes('skills/') || lower.includes('.claude') || lower.includes('.cursor') || lower.includes('.opencode') || lower.includes('.agents') || lower.includes('commands/') || lower.includes('hooks/')) {
    if (language === 'JSON' || language === 'YAML' || language === 'Markdown' || base.endsWith('.toml')) {
      return 'plugin_or_skill';
    }
    if (language === 'Shell' || language === 'PowerShell') {
      return 'script';
    }
  }
  if (lower.startsWith('scripts/') || language === 'Shell' || language === 'PowerShell') {
    return 'script';
  }
  if (language === 'JSON' || language === 'YAML' || language === 'TOML' || base.startsWith('.env') || base === '.gitignore' || base.endsWith('.config.js') || base.endsWith('.config.ts')) {
    return 'config';
  }
  if (lower.includes('model') || lower.includes('schema') || lower.includes('types')) {
    return 'model';
  }
  if (lower.includes('db') || lower.includes('database') || lower.includes('prisma') || lower.includes('drizzle') || language === 'SQL') {
    return 'database';
  }
  if (filePath.endsWith('.tsx') || filePath.endsWith('.jsx') || content.includes('from \'react\'') || content.includes('from "react"')) {
    return lower.includes('component') ? 'component' : 'frontend';
  }
  if (lower.includes('service') || lower.includes('client') || lower.includes('runtime') || lower.includes('adapter')) {
    return 'service';
  }
  if (content.includes('express') || content.includes('FastAPI') || content.includes('Flask') || content.includes('http.createServer')) {
    return 'backend';
  }
  if (isTsOrJs(language) || language === 'Python' || language === 'Go' || language === 'Rust') {
    return 'service';
  }
  return 'other';
}

function summarizeFile(filePath: string, role: FileRole, language: string, symbols: ExtractedSymbol[], content: string): string {
  const fnCount = symbols.filter((s) => s.kind === 'function').length;
  const clsCount = symbols.filter((s) => s.kind === 'class').length;
  const routeCount = symbols.filter((s) => s.kind === 'api_route').length;

  if (language === 'Markdown') {
    const heading = content.split('\n').find((l) => l.trim().startsWith('#'));
    if (heading) return `Documentation: ${heading.replace(/^#+\s*/, '').trim()}`;
  }
  if (filePath === 'package.json') {
    return 'Node.js package manifest defining scripts, entry points, and dependencies.';
  }
  if (routeCount > 0) {
    return `${language} module defining ${routeCount} API route handler(s) and ${fnCount} function(s).`;
  }
  if (clsCount > 0 || fnCount > 0) {
    const parts: string[] = [];
    if (clsCount > 0) parts.push(`${clsCount} class${clsCount > 1 ? 'es' : ''}`);
    if (fnCount > 0) parts.push(`${fnCount} function${fnCount > 1 ? 's' : ''}`);
    return `${language} ${role.replace(/_/g, ' ')} module exporting/defining ${parts.join(' and ')}.`;
  }
  return `${language} ${role.replace(/_/g, ' ')} file.`;
}

function buildFileTree(filesMeta: AnalyzedFileMeta[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];

  for (const file of filesMeta) {
    const parts = file.path.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      if (isLast) {
        currentLevel.push({
          path: file.path,
          name: part,
          type: 'blob',
          size: file.size,
          language: file.language,
          role: file.role,
          summary: file.summary,
          isEntryPoint: file.isEntryPoint,
          entryPointReason: file.entryPointReason,
          symbolCount: file.symbolIds.length,
        });
      } else {
        let dir = currentLevel.find((n) => n.type === 'tree' && n.name === part);
        if (!dir) {
          dir = {
            path: currentPath,
            name: part,
            type: 'tree',
            children: [],
          };
          currentLevel.push(dir);
        }
        currentLevel = dir.children!;
      }
    }
  }

  const sortTree = (nodes: FileTreeNode[]): void => {
    nodes.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const n of nodes) {
      if (n.children) sortTree(n.children);
    }
  };
  sortTree(root);
  return root;
}

export function analyzeRepositoryFiles(
  files: IngestedFile[],
  repoName: string,
  githubDescription: string,
  truncatedByLimit: boolean
): AnalysisResult {
  const allPathSet = new Set(files.map((f) => f.path));
  const fileMap = new Map(files.map((f) => [f.path, f]));

  const frameworks = new Set<string>();
  const packageManagers = new Set<string>();
  const testFrameworks = new Set<string>();
  const infrastructureTools = new Set<string>();
  const entryPointMap = new Map<string, EntryPointInfo>();

  // 1. Inspect package.json if present
  const pkgFile = fileMap.get('package.json');
  if (pkgFile && !pkgFile.isBinary) {
    packageManagers.add('npm / Node.js');
    try {
      const pkg = JSON.parse(pkgFile.content) as {
        main?: string;
        module?: string;
        bin?: string | Record<string, string>;
        scripts?: Record<string, string>;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const allDeps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      if (allDeps.react) frameworks.add('React');
      if (allDeps.next) frameworks.add('Next.js');
      if (allDeps.express) frameworks.add('Express');
      if (allDeps.fastify) frameworks.add('Fastify');
      if (allDeps.vite) frameworks.add('Vite');
      if (allDeps.vue) frameworks.add('Vue');
      if (allDeps.vitest) testFrameworks.add('Vitest');
      if (allDeps.jest) testFrameworks.add('Jest');
      if (allDeps.mocha) testFrameworks.add('Mocha');
      if (allDeps.promptfoo) testFrameworks.add('Promptfoo');

      const normalizeRel = (p: string) => p.replace(/^\.\//, '');
      if (pkg.main && allPathSet.has(normalizeRel(pkg.main))) {
        const p = normalizeRel(pkg.main);
        entryPointMap.set(p, {
          file_path: p,
          reason: `Declared as "main" entry point in package.json`,
          confidence: 'verified',
          role: 'entry_point',
        });
      }
      if (typeof pkg.bin === 'string' && allPathSet.has(normalizeRel(pkg.bin))) {
        const p = normalizeRel(pkg.bin);
        entryPointMap.set(p, {
          file_path: p,
          reason: `Declared as CLI "bin" executable in package.json`,
          confidence: 'verified',
          role: 'entry_point',
        });
      } else if (pkg.bin && typeof pkg.bin === 'object') {
        for (const [cmd, target] of Object.entries(pkg.bin)) {
          const p = normalizeRel(target);
          if (allPathSet.has(p)) {
            entryPointMap.set(p, {
              file_path: p,
              reason: `Declared as CLI binary "${cmd}" in package.json`,
              confidence: 'verified',
              role: 'entry_point',
            });
          }
        }
      }
      if (pkg.scripts) {
        if (pkg.scripts.test && pkg.scripts.test.includes('node --test')) {
          testFrameworks.add('Node.js built-in test runner');
        }
        for (const [scriptName, cmd] of Object.entries(pkg.scripts)) {
          if (scriptName === 'start' || scriptName === 'dev') {
            const match = cmd.match(/(?:node|tsx|ts-node|vite)\s+([A-Za-z0-9_./-]+\.[jt]sx?)/);
            if (match && allPathSet.has(normalizeRel(match[1]))) {
              const p = normalizeRel(match[1]);
              entryPointMap.set(p, {
                file_path: p,
                reason: `Executed by package.json "${scriptName}" script (${cmd})`,
                confidence: 'verified',
                role: 'entry_point',
              });
            }
          }
        }
      }
    } catch {
      // ignore invalid package.json
    }
  }

  // 2. Inspect Python manifests
  const reqFile = fileMap.get('requirements.txt');
  const pyprojectFile = fileMap.get('pyproject.toml');
  if (reqFile || pyprojectFile) {
    packageManagers.add(pyprojectFile ? 'Python (pyproject.toml)' : 'pip (requirements.txt)');
    const pyText = `${reqFile?.content ?? ''}\n${pyprojectFile?.content ?? ''}`.toLowerCase();
    if (pyText.includes('fastapi')) frameworks.add('FastAPI');
    if (pyText.includes('flask')) frameworks.add('Flask');
    if (pyText.includes('django')) frameworks.add('Django');
    if (pyText.includes('pytest')) testFrameworks.add('pytest');
  }

  // 3. Inspect plugin/hook manifests (important for agent/CLI repos like Ponytail)
  for (const f of files) {
    if (f.isBinary) continue;
    const base = f.path.split('/').pop() ?? '';
    if (base === 'plugin.json' || base === 'gemini-extension.json' || base.endsWith('-hooks.json')) {
      frameworks.add('Agent Plugin / Hook Architecture');
      try {
        const parsed = JSON.parse(f.content) as Record<string, unknown>;
        const jsonStr = JSON.stringify(parsed);
        // Extract referenced script paths inside hook/plugin manifests
        const scriptRefs = jsonStr.matchAll(/([A-Za-z0-9_./-]+\.(?:js|ts|py|sh|ps1))/g);
        for (const m of scriptRefs) {
          const candidate = m[1].replace(/^\.\//, '');
          if (allPathSet.has(candidate) && !entryPointMap.has(candidate)) {
            entryPointMap.set(candidate, {
              file_path: candidate,
              reason: `Invoked by manifest ${f.path}`,
              confidence: 'verified',
              role: 'entry_point',
            });
          }
        }
      } catch {
        // ignore invalid json
      }
    }
  }

  // 4. Parse all text files for symbols, imports, workflows, deployment, and additional entry points
  const allSymbols: ExtractedSymbol[] = [];
  const workflowJobs: WorkflowJobSpec[] = [];
  const deploymentUnits: DeploymentUnitSpec[] = [];
  const parsedImportsByFile = new Map<string, ImportInfo[]>();
  const parsedExportsByFile = new Map<string, string[]>();
  const symbolsByFile = new Map<string, ExtractedSymbol[]>();
  const langCounts = new Map<string, number>();
  let totalCodeFiles = 0;

  for (const f of files) {
    const lang = detectLanguage(f.path, f.isBinary);
    if (!f.isBinary && lang !== 'Plain Text' && lang !== 'Other') {
      langCounts.set(lang, (langCounts.get(lang) ?? 0) + 1);
      totalCodeFiles++;
    }

    if (f.isBinary) {
      symbolsByFile.set(f.path, []);
      continue;
    }

    if (f.path.includes('.github/workflows/') && (f.path.endsWith('.yml') || f.path.endsWith('.yaml'))) {
      infrastructureTools.add('GitHub Actions');
      workflowJobs.push(...parseWorkflowYaml(f.path, f.content));
    }
    if (f.path.toLowerCase().includes('dockerfile') || /compose.*\.ya?ml$/i.test(f.path)) {
      infrastructureTools.add('Docker');
      deploymentUnits.push(...parseDeploymentFiles(f.path, f.content));
    }

    let imports: ImportInfo[] = [];
    let exports: string[] = [];
    let fileSymbols: ExtractedSymbol[] = [];

    if (isTsOrJs(lang)) {
      const parsed = parseTsOrJsFile(f.path, f.content, lang);
      imports = parsed.imports.map((imp) => ({
        ...imp,
        resolvedPath: resolveImportPath(f.path, imp.source, allPathSet),
      }));
      exports = parsed.exports;
      fileSymbols = parsed.symbols;

      // Detect server/CLI entry points (excluding test files)
      const isTestPath = /\.(test|spec)\.[jt]sx?$/i.test(f.path) || f.path.startsWith('tests/') || f.path.includes('/tests/');
      if (!isTestPath && f.content.includes('.listen(') && !entryPointMap.has(f.path)) {
        entryPointMap.set(f.path, {
          file_path: f.path,
          reason: 'Initializes an HTTP/network listener via .listen()',
          confidence: 'verified',
          role: 'entry_point',
        });
      } else if (!isTestPath && f.content.startsWith('#!/usr/bin/env') && !entryPointMap.has(f.path)) {
        entryPointMap.set(f.path, {
          file_path: f.path,
          reason: 'Executable CLI script with #!/usr/bin/env shebang',
          confidence: 'verified',
          role: 'entry_point',
        });
      }
    } else if (lang === 'Python') {
      const parsed = parsePythonFile(f.path, f.content);
      imports = parsed.imports.map((imp) => {
        const relCandidate = imp.source.replace(/\./g, '/') + '.py';
        return {
          ...imp,
          resolvedPath: allPathSet.has(relCandidate) ? relCandidate : undefined,
        };
      });
      exports = parsed.exports;
      fileSymbols = parsed.symbols;

      if (f.content.includes('if __name__ == "__main__"') || f.content.includes("if __name__ == '__main__'")) {
        entryPointMap.set(f.path, {
          file_path: f.path,
          reason: 'Contains Python __main__ execution guard',
          confidence: 'verified',
          role: 'entry_point',
        });
      }
    } else if (lang === 'Shell' || lang === 'PowerShell') {
      fileSymbols = parseShellFunctions(f.path, f.content, lang);
    }

    parsedImportsByFile.set(f.path, imports);
    parsedExportsByFile.set(f.path, exports);
    symbolsByFile.set(f.path, fileSymbols);
    allSymbols.push(...fileSymbols);
  }

  // Fallback entry point check for index/main files if none detected yet
  if (entryPointMap.size === 0) {
    for (const candidate of ['src/main.tsx', 'src/main.ts', 'src/index.ts', 'src/index.js', 'main.py', 'app.py', 'index.js', 'index.ts', 'README.md']) {
      if (allPathSet.has(candidate)) {
        entryPointMap.set(candidate, {
          file_path: candidate,
          reason: candidate === 'README.md' ? 'Primary repository documentation entry point' : `Conventional root entry point (${candidate})`,
          confidence: 'inferred',
          role: 'entry_point',
        });
        break;
      }
    }
  }

  const entryPointSet = new Set(entryPointMap.keys());
  const filesMeta: AnalyzedFileMeta[] = [];
  const fileContents: Record<string, string> = {};

  for (const f of files) {
    const lang = detectLanguage(f.path, f.isBinary);
    const fileSymbols = symbolsByFile.get(f.path) ?? [];
    const role = classifyFileRole(f.path, f.content, lang, fileSymbols, entryPointSet, f.isBinary);
    const ep = entryPointMap.get(f.path);

    if (!f.isBinary) {
      fileContents[f.path] = f.content;
    }

    filesMeta.push({
      path: f.path,
      name: f.path.split('/').pop() ?? f.path,
      size: f.size,
      language: lang,
      role,
      summary: summarizeFile(f.path, role, lang, fileSymbols, f.content),
      lineCount: f.isBinary ? 0 : f.content.split('\n').length,
      isEntryPoint: Boolean(ep),
      entryPointReason: ep?.reason,
      imports: parsedImportsByFile.get(f.path) ?? [],
      exports: parsedExportsByFile.get(f.path) ?? [],
      symbolIds: fileSymbols.map((s) => s.id),
    });
  }

  // Extract concise README summary strictly from README.md
  const readmeFile = fileMap.get('README.md') ?? fileMap.get('readme.md');
  let readmeSummary = githubDescription || `${repoName} repository`;
  if (readmeFile && !readmeFile.isBinary) {
    const paragraphs = readmeFile.content
      .split(/\n\s*\n/)
      .map((p) => p.replace(/[#>*`[\]]/g, '').trim())
      .filter((p) => p.length > 40 && !p.startsWith('!') && !p.startsWith('<'));
    if (paragraphs[0]) {
      readmeSummary = githubDescription
        ? `${githubDescription} ${paragraphs[0].slice(0, 260)}`
        : paragraphs[0].slice(0, 320);
    }
  }

  const languages = Array.from(langCounts.entries())
    .map(([name, count]) => ({
      name,
      files: count,
      percentage: totalCodeFiles > 0 ? Math.round((count / totalCodeFiles) * 100) : 0,
    }))
    .sort((a, b) => b.files - a.files)
    .slice(0, 8);

  const coverageNotes: string[] = [
    `Analyzed ${files.filter((f) => !f.isBinary).length} text/source files using static AST and structured config parsers (no imported code was executed).`,
  ];
  if (truncatedByLimit) {
    coverageNotes.push('Repository exceeded the 2,500-file ingestion cap; remaining files were omitted.');
  }
  const binaryCount = files.filter((f) => f.isBinary).length;
  if (binaryCount > 0) {
    coverageNotes.push(`Skipped ${binaryCount} binary/image/compiled asset file(s) from symbol extraction.`);
  }
  if (workflowJobs.length === 0) {
    coverageNotes.push('No CI/CD workflow files (.github/workflows/*.yml) were found in this repository.');
  }
  if (deploymentUnits.length === 0) {
    coverageNotes.push('No Dockerfile or Docker Compose manifests were found in this repository.');
  }

  return {
    filesMeta,
    fileContents,
    fileTree: buildFileTree(filesMeta),
    symbols: allSymbols,
    languages,
    frameworks: Array.from(frameworks),
    packageManagers: Array.from(packageManagers),
    testFrameworks: Array.from(testFrameworks),
    infrastructureTools: Array.from(infrastructureTools),
    entryPoints: Array.from(entryPointMap.values()),
    workflowJobs,
    deploymentUnits,
    readmeSummary,
    coverageNotes,
  };
}

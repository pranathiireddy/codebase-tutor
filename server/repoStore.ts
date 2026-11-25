import fs from 'node:fs';
import path from 'node:path';
import {
  downloadAndExtractGitHubRepo,
  fetchGitHubRepoMetadata,
  parseGitHubUrl,
} from './github.ts';
import { analyzeRepositoryFiles, type AnalysisResult } from './analyzer.ts';
import { buildKnowledgeGraph } from './graph.ts';
import { generateAllDiagrams, generateWalkthrough } from './diagrams.ts';
import type {
  AnalysisStage,
  DiagramPayload,
  DiagramType,
  KnowledgeGraph,
  RepositoryRecord,
} from '../src/types/codebase.ts';

export const PONYTAIL_REPO_URL = 'https://github.com/DietrichGebert/ponytail';
export const PONYTAIL_REPO_ID = 'dietrichgebert__ponytail';

export interface AnalyzedRepoData {
  record: RepositoryRecord;
  analysis: AnalysisResult;
  graph: KnowledgeGraph;
  diagrams: Record<DiagramType, DiagramPayload>;
}

const CACHE_DIR = path.resolve(process.cwd(), '.codebase-tutor-cache');
const repoStore = new Map<string, AnalyzedRepoData>();
const recordStore = new Map<string, RepositoryRecord>();
const inFlightJobs = new Map<string, Promise<RepositoryRecord>>();

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

function makeRepoId(owner: string, name: string): string {
  return `${owner.toLowerCase()}__${name.toLowerCase()}`;
}

function getCacheFilePath(repoId: string, commitSha: string): string {
  const safeId = repoId.replace(/[^a-z0-9_.-]/gi, '_');
  const safeSha = commitSha.replace(/[^a-z0-9_.-]/gi, '_');
  return path.resolve(CACHE_DIR, `${safeId}__${safeSha}.json`);
}

function loadFromDiskCache(repoId: string, commitSha: string): AnalyzedRepoData | null {
  try {
    const filePath = getCacheFilePath(repoId, commitSha);
    if (!filePath.startsWith(CACHE_DIR + path.sep)) return null;
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as AnalyzedRepoData;
    parsed.record.fromCache = true;
    return parsed;
  } catch {
    return null;
  }
}

function saveToDiskCache(data: AnalyzedRepoData): void {
  try {
    ensureCacheDir();
    const filePath = getCacheFilePath(data.record.id, data.record.commitSha);
    if (!filePath.startsWith(CACHE_DIR + path.sep)) return;
    fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
  } catch {
    // Non-fatal cache write failure
  }
}

function updateStage(id: string, stage: AnalysisStage, progress: number, stageMessage: string, extra?: Partial<RepositoryRecord>): void {
  const current = recordStore.get(id);
  if (!current) return;
  recordStore.set(id, {
    ...current,
    ...extra,
    stage,
    progress,
    stageMessage,
  });
}

export async function startRepositoryAnalysis(
  rawUrl: string,
  options?: { forceRefresh?: boolean; githubToken?: string }
): Promise<RepositoryRecord> {
  const parsed = parseGitHubUrl(rawUrl);
  const id = makeRepoId(parsed.owner, parsed.name);
  const isFeaturedDemo = id === PONYTAIL_REPO_ID;

  // Return existing in-flight job if already running
  const running = inFlightJobs.get(id);
  if (running && !options?.forceRefresh) {
    return recordStore.get(id)!;
  }

  // Initialize record immediately
  const initialRecord: RepositoryRecord = {
    id,
    owner: parsed.owner,
    name: parsed.name,
    fullName: parsed.fullName,
    url: parsed.canonicalUrl,
    description: recordStore.get(id)?.description ?? '',
    defaultBranch: recordStore.get(id)?.defaultBranch ?? 'main',
    commitSha: recordStore.get(id)?.commitSha ?? '',
    stars: recordStore.get(id)?.stars,
    isFeaturedDemo,
    stage: 'validating',
    progress: 8,
    stageMessage: 'Validating GitHub repository URL...',
  };
  recordStore.set(id, initialRecord);

  const jobPromise = (async (): Promise<RepositoryRecord> => {
    try {
      updateStage(id, 'fetching', 18, `Fetching metadata for ${parsed.fullName} from GitHub...`);
      const meta = await fetchGitHubRepoMetadata(parsed, options?.githubToken);

      updateStage(id, 'fetching', 25, `Resolved commit ${meta.commitSha.slice(0, 7)} on branch ${meta.defaultBranch}`, {
        description: meta.description,
        defaultBranch: meta.defaultBranch,
        commitSha: meta.commitSha,
        stars: meta.stars,
      });

      // Check commit-SHA cache unless forceRefresh or private repository
      if (!options?.forceRefresh && !meta.isPrivate) {
        const memExisting = repoStore.get(id);
        if (memExisting && memExisting.record.commitSha === meta.commitSha && memExisting.record.stage === 'ready') {
          const cachedRec = { ...memExisting.record, fromCache: true };
          recordStore.set(id, cachedRec);
          return cachedRec;
        }
        const diskCached = loadFromDiskCache(id, meta.commitSha);
        if (diskCached) {
          repoStore.set(id, diskCached);
          recordStore.set(id, diskCached.record);
          return diskCached.record;
        }
      }

      updateStage(id, 'reading_tree', 38, 'Downloading repository archive and reading file structure...');
      const { files, truncatedByLimit } = await downloadAndExtractGitHubRepo(meta, options?.githubToken);

      updateStage(id, 'detecting_stack', 54, `Detecting languages and frameworks across ${files.length} files...`);
      await new Promise((r) => setTimeout(r, 40));

      updateStage(id, 'detecting_entrypoints', 66, 'Identifying entry points and extracting functions & classes...');
      const analysis = analyzeRepositoryFiles(files, meta.name, meta.description, truncatedByLimit);

      updateStage(id, 'extracting_symbols', 78, `Indexed ${analysis.symbols.length} functions, classes, and routes...`);
      await new Promise((r) => setTimeout(r, 30));

      updateStage(id, 'building_graph', 88, 'Building unified repository knowledge graph...');
      const { graph, majorModules, importantFolders, fileToModuleId } = buildKnowledgeGraph(
        id,
        meta.fullName,
        meta.commitSha,
        analysis
      );

      updateStage(id, 'generating_diagrams', 95, 'Generating architecture, flow, sequence, CI/CD, and class diagrams...');
      const diagrams = generateAllDiagrams(id, analysis, graph, majorModules, fileToModuleId);
      const walkthrough = generateWalkthrough(analysis, diagrams);

      const finalRecord: RepositoryRecord = {
        id,
        owner: meta.owner,
        name: meta.name,
        fullName: meta.fullName,
        url: meta.url,
        description: meta.description || analysis.readmeSummary,
        defaultBranch: meta.defaultBranch,
        commitSha: meta.commitSha,
        stars: meta.stars,
        isFeaturedDemo,
        stage: 'ready',
        progress: 100,
        stageMessage: 'Repository analysis complete.',
        analyzedAt: new Date().toISOString(),
        fromCache: false,
        overview: {
          summary: analysis.readmeSummary,
          purposeEvidence: meta.description
            ? 'Sourced from GitHub repository description and README.md.'
            : 'Extracted from repository README.md and package manifests.',
          languages: analysis.languages,
          frameworks: analysis.frameworks,
          packageManagers: analysis.packageManagers,
          testFrameworks: analysis.testFrameworks,
          infrastructureTools: analysis.infrastructureTools,
          entryPoints: analysis.entryPoints,
          importantFolders,
          majorModules,
          coverageNotes: analysis.coverageNotes,
          walkthrough,
        },
      };

      const fullData: AnalyzedRepoData = {
        record: finalRecord,
        analysis,
        graph,
        diagrams,
      };

      repoStore.set(id, fullData);
      recordStore.set(id, finalRecord);
      if (!meta.isPrivate) {
        saveToDiskCache(fullData);
      }
      return finalRecord;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Repository analysis failed unexpectedly.';
      updateStage(id, 'error', 0, msg, { error: msg });
      return recordStore.get(id)!;
    } finally {
      inFlightJobs.delete(id);
    }
  })();

  inFlightJobs.set(id, jobPromise);
  return recordStore.get(id)!;
}

export function listRepositories(): RepositoryRecord[] {
  const list = Array.from(recordStore.values());
  // Ensure Ponytail featured demo is always first
  return list.sort((a, b) => {
    if (a.isFeaturedDemo !== b.isFeaturedDemo) return a.isFeaturedDemo ? -1 : 1;
    return (b.analyzedAt ?? '').localeCompare(a.analyzedAt ?? '');
  });
}

export function getRepositoryRecord(id: string): RepositoryRecord | undefined {
  return recordStore.get(id);
}

export function getAnalyzedRepo(id: string): AnalyzedRepoData | undefined {
  return repoStore.get(id);
}

export function clearRepositoryCache(): number {
  let cleared = 0;
  if (fs.existsSync(CACHE_DIR)) {
    for (const file of fs.readdirSync(CACHE_DIR)) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
        cleared++;
      }
    }
  }
  return cleared;
}

export function initializeFeaturedDemo(): void {
  // Restore any previously cached snapshots from disk so imported repos survive server restarts
  try {
    if (fs.existsSync(CACHE_DIR)) {
      for (const file of fs.readdirSync(CACHE_DIR)) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = fs.readFileSync(path.join(CACHE_DIR, file), 'utf8');
          const parsed = JSON.parse(raw) as AnalyzedRepoData;
          if (parsed?.record?.id && parsed.record.stage === 'ready') {
            parsed.record.fromCache = true;
            repoStore.set(parsed.record.id, parsed);
            recordStore.set(parsed.record.id, parsed.record);
          }
        } catch {
          // ignore corrupted cache entry
        }
      }
    }
  } catch {
    // ignore cache dir read errors
  }

  // Check if any cached snapshot exists for ponytail first for instant availability,
  // and always trigger generic pipeline check/run so it stays fresh with commit SHA.
  if (!recordStore.has(PONYTAIL_REPO_ID)) {
    recordStore.set(PONYTAIL_REPO_ID, {
      id: PONYTAIL_REPO_ID,
      owner: 'DietrichGebert',
      name: 'ponytail',
      fullName: 'DietrichGebert/ponytail',
      url: PONYTAIL_REPO_URL,
      description: '',
      defaultBranch: 'main',
      commitSha: '',
      isFeaturedDemo: true,
      stage: 'queued',
      progress: 0,
      stageMessage: 'Ready to analyze via Codebase Tutor pipeline...',
    });
  }
  // Pre-warm Ponytail through the exact same generic pipeline
  void startRepositoryAnalysis(PONYTAIL_REPO_URL);
}

export type AnalysisStage =
  | 'queued'
  | 'validating'
  | 'fetching'
  | 'reading_tree'
  | 'detecting_stack'
  | 'detecting_entrypoints'
  | 'extracting_symbols'
  | 'building_graph'
  | 'generating_diagrams'
  | 'ready'
  | 'error';

export type ConfidenceLevel = 'verified' | 'inferred' | 'uncertain';

export type FileRole =
  | 'entry_point'
  | 'frontend'
  | 'backend'
  | 'api_route'
  | 'component'
  | 'service'
  | 'model'
  | 'database'
  | 'config'
  | 'tests'
  | 'infrastructure'
  | 'documentation'
  | 'script'
  | 'plugin_or_skill'
  | 'asset'
  | 'other';

export interface EvidenceRef {
  file_path: string;
  start_line: number;
  end_line: number;
  snippet?: string;
}

export interface FileTreeNode {
  path: string;
  name: string;
  type: 'tree' | 'blob';
  size?: number;
  language?: string;
  role?: FileRole;
  summary?: string;
  isEntryPoint?: boolean;
  entryPointReason?: string;
  symbolCount?: number;
  children?: FileTreeNode[];
}

export interface AnalyzedFileMeta {
  path: string;
  name: string;
  size: number;
  language: string;
  role: FileRole;
  summary: string;
  lineCount: number;
  isEntryPoint: boolean;
  entryPointReason?: string;
  imports: ImportInfo[];
  exports: string[];
  symbolIds: string[];
}

export interface ImportInfo {
  source: string;
  resolvedPath?: string;
  specifiers: string[];
  line: number;
}

export interface ExtractedSymbol {
  id: string;
  kind: 'function' | 'class' | 'method' | 'api_route' | 'workflow_job' | 'config_block';
  name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  language: string;
  signature?: string;
  parameters?: string[];
  return_type?: string;
  parent_class?: string;
  extends_name?: string;
  implements_names?: string[];
  methods?: string[];
  attributes?: string[];
  calls: string[];
  description: string;
  confidence: ConfidenceLevel;
}

export type GraphNodeType =
  | 'repository'
  | 'directory'
  | 'file'
  | 'module'
  | 'function'
  | 'class'
  | 'api'
  | 'service'
  | 'database'
  | 'workflow'
  | 'container'
  | 'external';

export type GraphEdgeType =
  | 'imports'
  | 'calls'
  | 'inherits'
  | 'implements'
  | 'uses'
  | 'sends_data_to'
  | 'reads_from'
  | 'writes_to'
  | 'depends_on'
  | 'triggers'
  | 'deploys_to'
  | 'contains';

export interface GraphNode {
  id: string;
  type: GraphNodeType;
  name: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  language?: string;
  role?: FileRole;
  description: string;
  metadata?: Record<string, unknown>;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  relationship: GraphEdgeType;
  label?: string;
  evidence?: EvidenceRef;
  confidence: ConfidenceLevel;
  analysis_method: 'ast' | 'regex_parser' | 'config_parser' | 'heuristic';
}

export interface KnowledgeGraph {
  repositoryId: string;
  commitSha: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: {
    totalFiles: number;
    analyzedFiles: number;
    totalFunctions: number;
    totalClasses: number;
    totalEdges: number;
  };
}

export type DiagramType =
  | 'system_architecture'
  | 'data_flow'
  | 'sequence'
  | 'cicd_pipeline'
  | 'deployment'
  | 'class_diagram';

export interface DiagramVisualNode {
  id: string;
  graphNodeId: string;
  label: string;
  sublabel?: string;
  category: GraphNodeType;
  layer: number;
  x: number;
  y: number;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  description: string;
  confidence: ConfidenceLevel;
  childSymbolIds?: string[];
  associatedFiles?: string[];
  metadata?: Record<string, unknown>;
}

export interface DiagramVisualEdge {
  id: string;
  graphEdgeId?: string;
  source: string;
  target: string;
  relationship: GraphEdgeType;
  label: string;
  confidence: ConfidenceLevel;
  evidence?: EvidenceRef;
  explanation?: string;
}

export interface SequenceStep {
  id: string;
  order: number;
  from: string;
  to: string;
  message: string;
  type: 'call' | 'return' | 'branch' | 'error_path';
  condition?: string;
  file_path?: string;
  start_line?: number;
  end_line?: number;
  confidence: ConfidenceLevel;
}

export interface SequenceScenario {
  id: string;
  title: string;
  description: string;
  participants: string[];
  steps: SequenceStep[];
  mermaidCode: string;
}

export interface DiagramPayload {
  id: string;
  repositoryId: string;
  type: DiagramType;
  title: string;
  subtitle: string;
  available: boolean;
  availabilityNote?: string;
  summary: string;
  coverageNotes: string[];
  nodes: DiagramVisualNode[];
  edges: DiagramVisualEdge[];
  mermaidCode?: string;
  scenarios?: SequenceScenario[];
}

export interface EntryPointInfo {
  file_path: string;
  reason: string;
  confidence: ConfidenceLevel;
  role: FileRole;
}

export interface WalkthroughStep {
  id: string;
  title: string;
  summary: string;
  file_path: string;
  start_line?: number;
  end_line?: number;
  symbol_id?: string;
  diagram_type?: DiagramType;
}

export interface RepositoryOverview {
  summary: string;
  purposeEvidence: string;
  languages: { name: string; files: number; percentage: number }[];
  frameworks: string[];
  packageManagers: string[];
  testFrameworks: string[];
  infrastructureTools: string[];
  entryPoints: EntryPointInfo[];
  importantFolders: { path: string; fileCount: number; role: string }[];
  majorModules: { id: string; name: string; fileCount: number; description: string }[];
  coverageNotes: string[];
  walkthrough: WalkthroughStep[];
}

export interface RepositoryRecord {
  id: string;
  owner: string;
  name: string;
  fullName: string;
  url: string;
  description: string;
  defaultBranch: string;
  commitSha: string;
  stars?: number;
  isFeaturedDemo: boolean;
  stage: AnalysisStage;
  progress: number;
  stageMessage: string;
  error?: string;
  analyzedAt?: string;
  fromCache?: boolean;
  overview?: RepositoryOverview;
}

export interface FileContentResponse {
  file: AnalyzedFileMeta;
  content: string;
  symbols: ExtractedSymbol[];
  incomingDependencies: { file_path: string; relationship: GraphEdgeType; line?: number }[];
  outgoingDependencies: { file_path: string; relationship: GraphEdgeType; line?: number }[];
}

export interface CodeAttachment {
  file_path: string;
  start_line: number;
  end_line: number;
  code: string;
  symbol_name?: string;
}

export interface ChatContext {
  selectedFilePath?: string;
  selectedSymbolId?: string;
  selectedSymbolName?: string;
  selectedCodeRange?: { start_line: number; end_line: number };
  selectedDiagramType?: DiagramType;
  selectedNodeId?: string;
  selectedNodeName?: string;
  selectedEdgeId?: string;
  attachedCode?: CodeAttachment;
}

export interface ChatCitation {
  file_path: string;
  start_line: number;
  end_line: number;
  label: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  contextLabel?: string;
  citations?: ChatCitation[];
  confidenceSummary?: 'verified' | 'partial' | 'unknown';
  error?: string;
}

export interface UserProfile {
  id: string;
  name: string;
  email: string;
  role: string;
}

import { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import {
  Search,
  Code2,
  MessageSquarePlus,
  GitBranch,
  AlertCircle,
  CheckCircle2,
  HelpCircle,
  ChevronRight,
  Route,
  GripVertical,
  Info,
  Download,
} from 'lucide-react';
import type {
  DiagramPayload,
  DiagramType,
  DiagramVisualEdge,
  DiagramVisualNode,
  ExtractedSymbol,
} from '../types/codebase';
import { safeJson } from '../utils/api';
import { MermaidDiagram } from './MermaidDiagram';

interface DiagramExplorerPanelProps {
  repositoryId: string;
  activeDiagramType: DiagramType;
  onChangeDiagramType: (type: DiagramType) => void;
  selectedGraphNodeId: string | null;
  onSelectGraphNode: (node: DiagramVisualNode) => void;
  onOpenCodeLocation: (filePath: string, startLine?: number, endLine?: number, symbolId?: string) => void;
  onAskAboutDiagramItem: (question: string, node?: DiagramVisualNode, edge?: DiagramVisualEdge) => void;
}

const DIAGRAM_TABS: { id: DiagramType; label: string }[] = [
  { id: 'system_architecture', label: 'System Architecture' },
  { id: 'data_flow', label: 'Data Flow' },
  { id: 'sequence', label: 'Sequence Diagrams' },
  { id: 'cicd_pipeline', label: 'CI/CD Pipeline' },
  { id: 'deployment', label: 'Deployment' },
  { id: 'class_diagram', label: 'Class Diagrams' },
];

interface CustomNodeData extends Record<string, unknown> {
  visual: DiagramVisualNode;
  isSelected: boolean;
  isPathHighlighted: boolean;
  isDimmed: boolean;
}

function ArchitectureNode({ data }: NodeProps<Node<CustomNodeData>>) {
  const { visual, isSelected, isPathHighlighted, isDimmed } = data;

  const categoryColor =
    visual.category === 'file'
      ? 'text-sky-400'
      : visual.category === 'module'
        ? 'text-indigo-300'
        : visual.category === 'api'
          ? 'text-emerald-400'
          : visual.category === 'workflow'
            ? 'text-amber-400'
            : visual.category === 'class'
              ? 'text-violet-300'
              : 'text-[#9CA3AF]';

  return (
    <div
      title={visual.description}
      className={`min-w-[200px] max-w-[240px] rounded-lg border px-3 py-2.5 transition-all ${
        isSelected
          ? 'border-sky-400 bg-[#142030] shadow-[0_0_0_1px_rgba(56,189,248,0.4)]'
          : isPathHighlighted
            ? 'border-sky-500/70 bg-[#131B26]'
            : 'border-[#262C38] bg-[#141820] hover:border-[#3A4354]'
      } ${isDimmed ? 'opacity-35' : 'opacity-100'}`}
    >
      <Handle type="target" position={Position.Top} className="!h-2 !w-2 !border-[#232832] !bg-sky-400" />
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className={`text-[10px] font-medium uppercase tracking-wider ${categoryColor}`}>
          {visual.category}
        </span>
        {visual.confidence !== 'verified' && (
          <span className="text-[10px] text-amber-400">{visual.confidence}</span>
        )}
      </div>
      <div className="truncate text-xs font-semibold text-[#F3F4F6]">{visual.label}</div>
      {visual.sublabel && (
        <div className="mt-0.5 truncate text-[11px] text-[#9CA3AF]">{visual.sublabel}</div>
      )}
      <Handle type="source" position={Position.Bottom} className="!h-2 !w-2 !border-[#232832] !bg-sky-400" />
    </div>
  );
}

const nodeTypes = {
  archNode: ArchitectureNode,
};

function ConfidenceLabel({ level }: { level: 'verified' | 'inferred' | 'uncertain' }) {
  if (level === 'verified') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
        <CheckCircle2 className="h-3 w-3" /> Verified
      </span>
    );
  }
  if (level === 'inferred') {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
        <HelpCircle className="h-3 w-3" /> Inferred
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[11px] text-[#9CA3AF]">
      <AlertCircle className="h-3 w-3" /> Uncertain
    </span>
  );
}

export function DiagramExplorerPanel({
  repositoryId,
  activeDiagramType,
  onChangeDiagramType,
  selectedGraphNodeId,
  onSelectGraphNode,
  onOpenCodeLocation,
  onAskAboutDiagramItem,
}: DiagramExplorerPanelProps) {
  const [diagram, setDiagram] = useState<DiagramPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedNode, setSelectedNode] = useState<DiagramVisualNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<DiagramVisualEdge | null>(null);
  const [expandedNodeDetails, setExpandedNodeDetails] = useState<{
    symbols: ExtractedSymbol[];
    incoming: DiagramVisualEdge[];
    outgoing: DiagramVisualEdge[];
  } | null>(null);
  const [diagramSearch, setDiagramSearch] = useState('');
  const [viewMode, setViewMode] = useState<'interactive' | 'mermaid'>('interactive');
  const [activeScenarioIdx, setActiveScenarioIdx] = useState(0);
  const [showGraphHelp, setShowGraphHelp] = useState(false);
  const [showExportMenu, setShowExportMenu] = useState(false);

  const handleExportPng = () => {
    setShowExportMenu(false);
    const svgEl = document.querySelector('.react-flow__renderer svg, .w-full.overflow-auto svg, svg') as SVGElement | null;
    if (!svgEl) {
      alert('Diagram SVG is not currently rendered in view.');
      return;
    }
    const clone = svgEl.cloneNode(true) as SVGElement;
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    const rect = svgEl.getBoundingClientRect();
    const width = rect.width || 1200;
    const height = rect.height || 800;
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));

    const svgData = new XMLSerializer().serializeToString(clone);
    const svg64 = btoa(unescape(encodeURIComponent(svgData)));
    const imageSrc = `data:image/svg+xml;base64,${svg64}`;

    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = width * 2;
      canvas.height = height * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.fillStyle = '#0F1217';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.scale(2, 2);
      ctx.drawImage(img, 0, 0, width, height);

      const pngUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      link.href = pngUrl;
      link.download = `${activeDiagramType}-${repositoryId}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };
    img.src = imageSrc;
  };

  const handleExportSvg = () => {
    setShowExportMenu(false);
    const svgEl = document.querySelector('.react-flow__renderer svg, .w-full.overflow-auto svg, svg') as SVGElement | null;
    if (!svgEl) {
      alert('Diagram SVG is not currently rendered in view.');
      return;
    }
    const clone = svgEl.cloneNode(true) as SVGElement;
    if (!clone.getAttribute('xmlns')) {
      clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    }
    const svgData = new XMLSerializer().serializeToString(clone);
    const blob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeDiagramType}-${repositoryId}.svg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleExportJson = () => {
    setShowExportMenu(false);
    if (!diagram) return;
    const blob = new Blob([JSON.stringify(diagram, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeDiagramType}-${repositoryId}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    let cancelled = false;
    async function loadDiagram() {
      setLoading(true);
      setError(null);
      setSelectedEdge(null);
      setExpandedNodeDetails(null);
      setActiveScenarioIdx(0);
      try {
        const res = await fetch(`/api/repositories/${encodeURIComponent(repositoryId)}/diagrams/${activeDiagramType}`);
        const json = await safeJson<{ diagram?: DiagramPayload; error?: string }>(res);
        if (!res.ok || !json.diagram) {
          throw new Error(json.error || 'Failed to load diagram.');
        }
        if (!cancelled) {
          setDiagram(json.diagram);
          // Cross-diagram sync: match selectedGraphNodeId if present in this diagram
          if (selectedGraphNodeId) {
            const match = json.diagram.nodes.find(
              (n) => n.graphNodeId === selectedGraphNodeId || n.id === selectedGraphNodeId
            );
            setSelectedNode(match ?? null);
          } else {
            setSelectedNode(null);
          }
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Unable to load diagram.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void loadDiagram();
    return () => {
      cancelled = true;
    };
  }, [repositoryId, activeDiagramType, selectedGraphNodeId]);

  const handleSelectNode = async (visualNode: DiagramVisualNode) => {
    setSelectedNode(visualNode);
    setSelectedEdge(null);
    onSelectGraphNode(visualNode);

    try {
      const res = await fetch(
        `/api/repositories/${encodeURIComponent(repositoryId)}/diagrams/${activeDiagramType}/nodes/${encodeURIComponent(visualNode.id)}`
      );
      if (res.ok) {
        const details = await safeJson<{
          symbols: ExtractedSymbol[];
          incoming: DiagramVisualEdge[];
          outgoing: DiagramVisualEdge[];
        }>(res);
        setExpandedNodeDetails(details);
      }
    } catch {
      // ignore inspector fetch error
    }
  };

  // Compute connected path node IDs automatically when any node is selected
  const connectedNodeIds = useMemo(() => {
    if (!selectedNode || !diagram) return null;
    const set = new Set<string>([selectedNode.id]);
    for (const e of diagram.edges) {
      if (e.source === selectedNode.id) set.add(e.target);
      if (e.target === selectedNode.id) set.add(e.source);
    }
    return set;
  }, [selectedNode, diagram]);

  const rfNodes: Node<CustomNodeData>[] = useMemo(() => {
    if (!diagram) return [];
    const q = diagramSearch.trim().toLowerCase();
    return diagram.nodes.map((n) => {
      const isSelected = selectedNode?.id === n.id || (selectedGraphNodeId !== null && n.graphNodeId === selectedGraphNodeId);
      const matchesSearch = !q || n.label.toLowerCase().includes(q) || (n.file_path ?? '').toLowerCase().includes(q);
      const inPath = !connectedNodeIds || connectedNodeIds.has(n.id);
      return {
        id: n.id,
        type: 'archNode',
        position: { x: n.x, y: n.y },
        data: {
          visual: n,
          isSelected,
          isPathHighlighted: Boolean(connectedNodeIds && connectedNodeIds.has(n.id)),
          isDimmed: !matchesSearch || (connectedNodeIds !== null && !connectedNodeIds.has(n.id)),
        },
      };
    });
  }, [diagram, selectedNode, selectedGraphNodeId, diagramSearch, connectedNodeIds]);

  const rfEdges: Edge[] = useMemo(() => {
    if (!diagram) return [];
    return diagram.edges.map((e) => {
      const isSelected = selectedEdge?.id === e.id;
      const isConnectedToSelected = selectedNode && (e.source === selectedNode.id || e.target === selectedNode.id);
      const inPath = !connectedNodeIds || (connectedNodeIds.has(e.source) && connectedNodeIds.has(e.target));
      const popUp = isSelected || isConnectedToSelected;
      return {
        id: e.id,
        source: e.source,
        target: e.target,
        label: e.label,
        type: 'smoothstep',
        animated: Boolean(popUp),
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: popUp ? '#38BDF8' : e.confidence === 'inferred' ? '#F59E0B' : '#64748B',
        },
        style: {
          stroke: popUp ? '#38BDF8' : e.confidence === 'inferred' ? '#D97706' : '#475569',
          strokeWidth: popUp ? 3 : 1.5,
          strokeDasharray: e.confidence === 'inferred' && !popUp ? '5 4' : undefined,
          opacity: inPath ? 1 : 0.15,
        },
        labelStyle: {
          fill: popUp ? '#E6E9EF' : '#9CA3AF',
          fontSize: popUp ? 11 : 10,
          fontFamily: 'JetBrains Mono, monospace',
          fontWeight: popUp ? 600 : 400,
        },
        labelBgStyle: {
          fill: '#0B0D10',
          fillOpacity: 0.9,
        },
      };
    });
  }, [diagram, selectedEdge, selectedNode, connectedNodeIds]);

  const activeScenario = diagram?.scenarios?.[activeScenarioIdx];

  return (
    <div className="flex h-full flex-col bg-[#0B0D10]">
      {/* Diagram Category Switcher + Controls */}
      <div className="border-b border-[#232832] bg-[#111419] px-4 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1 overflow-x-auto">
            {DIAGRAM_TABS.map((tab) => {
              const active = activeDiagramType === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => onChangeDiagramType(tab.id)}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-medium whitespace-nowrap shrink-0 transition-colors cursor-pointer ${
                    active
                      ? 'bg-sky-500/15 text-sky-300'
                      : 'text-[#9CA3AF] hover:bg-[#1A1F28] hover:text-[#E6E9EF]'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <div className="relative w-44">
              <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#6B7280]" />
              <input
                type="text"
                value={diagramSearch}
                onChange={(e) => setDiagramSearch(e.target.value)}
                placeholder="Find node or file..."
                className="w-full rounded border border-[#232832] bg-[#0B0D10] py-1 pl-7 pr-2 text-[11px] text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500/60 focus:outline-none"
              />
            </div>



            {diagram?.mermaidCode && (
              <div className="flex items-center rounded border border-[#232832] bg-[#0B0D10] p-0.5">
                <button
                  type="button"
                  onClick={() => setViewMode('interactive')}
                  className={`rounded px-2 py-0.5 text-[11px] cursor-pointer ${
                    viewMode === 'interactive' ? 'bg-[#1A1F28] text-[#E6E9EF]' : 'text-[#6B7280]'
                  }`}
                >
                  Interactive
                </button>
                <button
                  type="button"
                  onClick={() => setViewMode('mermaid')}
                  className={`rounded px-2 py-0.5 text-[11px] cursor-pointer ${
                    viewMode === 'mermaid' ? 'bg-[#1A1F28] text-[#E6E9EF]' : 'text-[#6B7280]'
                  }`}
                >
                  Mermaid
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowGraphHelp((p) => !p)}
              className={`flex items-center gap-1 rounded border px-2.5 py-1 text-[11px] whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                showGraphHelp
                  ? 'border-sky-500/60 bg-sky-500/15 text-sky-300'
                  : 'border-[#232832] text-[#9CA3AF] hover:text-[#E6E9EF]'
              }`}
              title="Learn what lines, nodes, and confidence levels mean"
            >
              <Info className="h-3 w-3" />
              <span>How to Read Graphs</span>
            </button>

            {diagram && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setShowExportMenu((p) => !p)}
                  className="flex items-center gap-1 rounded border border-[#232832] bg-[#141820] px-2.5 py-1 text-[11px] font-medium text-[#E6E9EF] hover:border-sky-500/50 cursor-pointer"
                  title="Export diagram data or mermaid markup"
                >
                  <Download className="h-3 w-3 text-sky-400" />
                  <span>Export</span>
                </button>

                {showExportMenu && (
                  <div className="absolute right-0 top-full mt-1 w-48 rounded-lg border border-[#232832] bg-[#111419] p-1 shadow-xl z-50 space-y-1">
                    <button
                      type="button"
                      onClick={handleExportPng}
                      className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs text-[#D1D5DB] hover:bg-[#1A1F28] hover:text-[#F3F4F6] cursor-pointer"
                    >
                      <span>PNG Image (.png)</span>
                      <span className="font-mono text-[10px] text-[#6B7280]">Raster</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportSvg}
                      className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs text-[#D1D5DB] hover:bg-[#1A1F28] hover:text-[#F3F4F6] cursor-pointer"
                    >
                      <span>SVG Vector (.svg)</span>
                      <span className="font-mono text-[10px] text-[#6B7280]">Vector</span>
                    </button>
                    <button
                      type="button"
                      onClick={handleExportJson}
                      className="flex w-full items-center justify-between rounded px-2.5 py-1.5 text-left text-xs text-[#D1D5DB] hover:bg-[#1A1F28] hover:text-[#F3F4F6] cursor-pointer"
                    >
                      <span>Graph Data (.json)</span>
                      <span className="font-mono text-[10px] text-[#6B7280]">Schema</span>
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {diagram && (
          <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px] text-[#9CA3AF]">
            <span>{diagram.subtitle}</span>
            <span className="font-mono tabular-nums text-[#6B7280]">
              {diagram.nodes.length} nodes · {diagram.edges.length} edges
            </span>
          </div>
        )}
      </div>

      {showGraphHelp && (
        <div className="border-b border-[#232832] bg-[#0D1015] px-4 py-3 text-xs text-[#D1D5DB] space-y-2 shrink-0">
          <div className="flex items-center justify-between font-semibold text-[#F3F4F6]">
            <span>Knowledge Graph & Diagram Legend Guide</span>
            <button
              type="button"
              onClick={() => setShowGraphHelp(false)}
              className="text-[11px] text-[#9CA3AF] hover:text-white cursor-pointer"
            >
              Close Guide
            </button>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-1">
            <div className="space-y-1.5 rounded border border-[#232832] bg-[#111419] p-2.5">
              <div className="font-medium text-sky-300">Edge Lines (Connections)</div>
              <ul className="space-y-1 text-[11px] text-[#9CA3AF] list-disc list-inside">
                <li><strong className="text-[#E6E9EF]">Solid Lines:</strong> Direct, verified dependencies, imports, or direct function calls parsed from AST.</li>
                <li><strong className="text-[#E6E9EF]">Dotted Lines:</strong> Inferred relationships, indirect data flows, asynchronous triggers, or heuristic connections.</li>
              </ul>
            </div>
            <div className="space-y-1.5 rounded border border-[#232832] bg-[#111419] p-2.5">
              <div className="font-medium text-sky-300">Confidence & Interaction</div>
              <ul className="space-y-1 text-[11px] text-[#9CA3AF] list-disc list-inside">
                <li><strong className="text-emerald-400">Verified (Green):</strong> Extracted directly from code AST / config.</li>
                <li><strong className="text-amber-400">Inferred (Amber):</strong> Deduced via naming conventions or data patterns.</li>
                <li><strong className="text-[#E6E9EF]">Actions:</strong> Click any node for details & functions; double-click to jump to source code.</li>
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* Main Diagram Area + Inspector Drawer */}
      <div className="relative flex flex-1 min-h-0">
        {/* Visual Layer */}
        <div className="flex-1 min-w-0 h-full overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center text-xs text-[#9CA3AF]">
              Generating {activeDiagramType.replace(/_/g, ' ')} view from repository knowledge graph...
            </div>
          ) : error ? (
            <div className="flex h-full items-center justify-center p-6 text-xs text-rose-400">
              {error}
            </div>
          ) : !diagram?.available ? (
            <div className="flex h-full flex-col items-center justify-center p-8 text-center">
              <GitBranch className="h-8 w-8 text-[#4B5563] mb-3" />
              <h3 className="text-sm font-semibold text-[#E6E9EF] mb-1">
                {diagram?.title ?? 'Diagram'} not present in repository
              </h3>
              <p className="max-w-md text-xs leading-relaxed text-[#9CA3AF] mb-4">
                {diagram?.availabilityNote || 'No supporting files or symbols were detected for this diagram category.'}
              </p>
              <button
                type="button"
                onClick={() => onChangeDiagramType('system_architecture')}
                className="rounded-md border border-[#232832] bg-[#141820] px-3 py-1.5 text-xs font-medium text-[#E6E9EF] hover:border-sky-500/50 cursor-pointer"
              >
                Return to System Architecture
              </button>
            </div>
          ) : activeDiagramType === 'sequence' && diagram.scenarios && diagram.scenarios.length > 0 ? (
            <div className="flex h-full flex-col overflow-y-auto p-4 space-y-4">
              {/* Scenario selector */}
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-1.5">
                  {diagram.scenarios.map((sc, idx) => (
                    <button
                      key={sc.id}
                      type="button"
                      onClick={() => setActiveScenarioIdx(idx)}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors cursor-pointer ${
                        activeScenarioIdx === idx
                          ? 'border-sky-500/60 bg-sky-500/15 text-sky-200'
                          : 'border-[#232832] bg-[#111419] text-[#9CA3AF] hover:text-[#E6E9EF]'
                      }`}
                    >
                      {sc.title}
                    </button>
                  ))}
                </div>
              </div>

              {activeScenario && (
                <>
                  <div className="rounded-lg border border-[#232832] bg-[#111419] p-3 text-xs text-[#9CA3AF]">
                    {activeScenario.description}
                  </div>

                  {viewMode === 'mermaid' ? (
                    <MermaidDiagram code={activeScenario.mermaidCode} />
                  ) : (
                    <div className="space-y-2">
                      {activeScenario.steps.map((step) => (
                        <div
                          key={step.id}
                          onClick={() => {
                            if (step.file_path) {
                              onOpenCodeLocation(step.file_path, step.start_line, step.end_line);
                            }
                          }}
                          className="flex items-center justify-between gap-3 rounded-lg border border-[#232832] bg-[#111419] px-3.5 py-2.5 hover:border-sky-500/50 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="font-mono text-xs tabular-nums text-[#6B7280] w-5 shrink-0">
                              {step.order}.
                            </span>
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5 text-xs font-medium text-[#E6E9EF]">
                                <span className="font-mono text-sky-300">{step.from}</span>
                                <ChevronRight className="h-3.5 w-3.5 text-[#6B7280]" />
                                <span className="font-mono text-indigo-300">{step.to}</span>
                              </div>
                              <div className="mt-0.5 font-mono text-[11px] text-[#9CA3AF] truncate">
                                {step.message}
                              </div>
                            </div>
                          </div>

                          <div className="flex items-center gap-3 shrink-0">
                            <ConfidenceLabel level={step.confidence} />
                            {step.file_path && (
                              <span className="font-mono text-[11px] text-sky-400">
                                {step.file_path}:{step.start_line ?? 1}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </div>
          ) : viewMode === 'mermaid' && diagram.mermaidCode ? (
            <div className="h-full overflow-auto p-4">
              <MermaidDiagram code={diagram.mermaidCode} />
            </div>
          ) : (
            <ReactFlow
              nodes={rfNodes}
              edges={rfEdges}
              nodeTypes={nodeTypes}
              fitView
              fitViewOptions={{ padding: 0.25 }}
              panOnScroll={true}
              panOnDrag={[1, 2, 0]}
              selectionOnDrag={false}
              zoomOnScroll={true}
              zoomOnPinch={true}
              preventScrolling={false}
              onNodeClick={(_evt, node) => {
                const visual = (node.data as CustomNodeData).visual;
                void handleSelectNode(visual);
              }}
              onNodeDoubleClick={(_evt, node) => {
                const visual = (node.data as CustomNodeData).visual;
                if (visual.file_path) {
                  onOpenCodeLocation(visual.file_path, visual.start_line, visual.end_line);
                }
              }}
              onEdgeClick={(_evt, edge) => {
                const ve = diagram.edges.find((de) => de.id === edge.id);
                if (ve) {
                  setSelectedEdge(ve);
                  setSelectedNode(null);
                }
              }}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#1E2430" gap={20} size={1} />
              <Controls />
              <MiniMap nodeColor="#1E293B" maskColor="rgba(11, 13, 16, 0.75)" />
            </ReactFlow>
          )}
        </div>

        {/* Explanation & Code Layer Inspector Drawer */}
        {(selectedNode || selectedEdge) && (
          <aside className="w-80 shrink-0 overflow-y-auto border-l border-[#232832] bg-[#111419] p-4">
            {selectedNode && (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-sky-400">
                      {selectedNode.category}
                    </span>
                    <ConfidenceLabel level={selectedNode.confidence} />
                  </div>
                  <h3 className="text-sm font-semibold text-[#F3F4F6] break-words">
                    {selectedNode.label}
                  </h3>
                  {selectedNode.sublabel && (
                    <p className="text-xs text-[#9CA3AF] mt-0.5">{selectedNode.sublabel}</p>
                  )}
                </div>

                <p className="text-xs leading-relaxed text-[#D1D5DB]">
                  {selectedNode.description}
                </p>

                {/* Primary Actions */}
                <div className="flex flex-col gap-2">
                  {selectedNode.file_path && (
                    <button
                      type="button"
                      onClick={() =>
                        onOpenCodeLocation(
                          selectedNode.file_path!,
                          selectedNode.start_line,
                          selectedNode.end_line
                        )
                      }
                      className="flex items-center justify-center gap-1.5 rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 transition-colors cursor-pointer"
                    >
                      <Code2 className="h-3.5 w-3.5" />
                      <span>Open Source Code</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() =>
                      onAskAboutDiagramItem(
                        `Explain the "${selectedNode.label}" ${selectedNode.category} in this diagram, its role, and its connections.`,
                        selectedNode
                      )
                    }
                    className="flex items-center justify-center gap-1.5 rounded-md border border-[#232832] bg-[#161A21] px-3 py-1.5 text-xs font-medium text-[#E6E9EF] hover:border-sky-500/50 transition-colors cursor-pointer"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5 text-sky-400" />
                    <span>Ask Tutor about this node</span>
                  </button>
                </div>

                {/* Associated Files */}
                {selectedNode.associatedFiles && selectedNode.associatedFiles.length > 0 && (
                  <div className="border-t border-[#232832] pt-3">
                    <h4 className="text-[11px] font-semibold text-[#9CA3AF] mb-1.5">
                      Associated Files ({selectedNode.associatedFiles.length})
                    </h4>
                    <div className="space-y-1">
                      {selectedNode.associatedFiles.map((fp) => (
                        <button
                          key={fp}
                          type="button"
                          onClick={() => onOpenCodeLocation(fp, 1, 30)}
                          className="block w-full truncate text-left font-mono text-[11px] text-sky-400 hover:text-sky-300 cursor-pointer"
                        >
                          {fp}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* Extracted Functions & Classes */}
                {expandedNodeDetails && expandedNodeDetails.symbols.length > 0 && (
                  <div className="border-t border-[#232832] pt-3">
                    <h4 className="text-[11px] font-semibold text-[#9CA3AF] mb-1.5">
                      Functions & Classes ({expandedNodeDetails.symbols.length})
                    </h4>
                    <div className="space-y-1">
                      {expandedNodeDetails.symbols.map((sym) => (
                        <div
                          key={sym.id}
                          role="button"
                          tabIndex={0}
                          draggable
                          onClick={() =>
                            onOpenCodeLocation(sym.file_path, sym.start_line, sym.end_line, sym.id)
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault();
                              onOpenCodeLocation(sym.file_path, sym.start_line, sym.end_line, sym.id);
                            }
                          }}
                          onDragStart={(e) => {
                            const att = {
                              file_path: sym.file_path,
                              start_line: sym.start_line,
                              end_line: sym.end_line,
                              code: sym.description || `${sym.kind} ${sym.name}`,
                              symbol_name: sym.name,
                            };
                            e.dataTransfer.setData('application/x-codebase-tutor-snippet', JSON.stringify(att));
                            e.dataTransfer.setData(
                              'text/plain',
                              `${sym.name} (${sym.file_path}:L${sym.start_line}-${sym.end_line})`
                            );
                            e.dataTransfer.effectAllowed = 'copy';
                          }}
                          title="Click to inspect source, or drag into Tutor Chat"
                          className="group flex w-full items-center justify-between gap-2 rounded border border-[#232832] bg-[#0B0D10] px-2 py-1 text-left hover:border-sky-500/50 cursor-grab active:cursor-grabbing select-none"
                        >
                          <div className="flex items-center gap-1.5 min-w-0">
                            <GripVertical className="h-3 w-3 text-[#6B7280] group-hover:text-sky-400 shrink-0" />
                            <span className="truncate font-mono text-[11px] text-[#E6E9EF]">
                              {sym.name}
                            </span>
                          </div>
                          <span className="font-mono text-[10px] tabular-nums text-[#6B7280] shrink-0">
                            L{sym.start_line}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Incoming / Outgoing Edges */}
                {expandedNodeDetails &&
                  (expandedNodeDetails.incoming.length > 0 || expandedNodeDetails.outgoing.length > 0) && (
                    <div className="border-t border-[#232832] pt-3 space-y-2.5 text-[11px]">
                      {expandedNodeDetails.incoming.length > 0 && (
                        <div>
                          <h4 className="font-semibold text-[#9CA3AF] mb-1">
                            Incoming Connections ({expandedNodeDetails.incoming.length})
                          </h4>
                          {expandedNodeDetails.incoming.map((e) => (
                            <div key={e.id} className="truncate text-[#D1D5DB]">
                              {e.source.replace(/^(mod:|sys_ep:|ext:|file:)/, '')} · {e.label}
                            </div>
                          ))}
                        </div>
                      )}
                      {expandedNodeDetails.outgoing.length > 0 && (
                        <div>
                          <h4 className="font-semibold text-[#9CA3AF] mb-1">
                            Outgoing Connections ({expandedNodeDetails.outgoing.length})
                          </h4>
                          {expandedNodeDetails.outgoing.map((e) => (
                            <div key={e.id} className="truncate text-[#D1D5DB]">
                              {e.label} → {e.target.replace(/^(mod:|sys_ep:|ext:|file:)/, '')}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
              </div>
            )}

            {selectedEdge && (
              <div className="space-y-4">
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="text-[11px] font-medium uppercase tracking-wider text-sky-400">
                      Relationship
                    </span>
                    <ConfidenceLabel level={selectedEdge.confidence} />
                  </div>
                  <h3 className="text-sm font-semibold text-[#F3F4F6]">{selectedEdge.label}</h3>
                  <p className="mt-1 font-mono text-[11px] text-[#9CA3AF] break-all">
                    {selectedEdge.source} → {selectedEdge.target}
                  </p>
                </div>

                {selectedEdge.explanation && (
                  <p className="text-xs leading-relaxed text-[#D1D5DB]">
                    {selectedEdge.explanation}
                  </p>
                )}

                {selectedEdge.evidence && (
                  <button
                    type="button"
                    onClick={() =>
                      onOpenCodeLocation(
                        selectedEdge.evidence!.file_path,
                        selectedEdge.evidence!.start_line,
                        selectedEdge.evidence!.end_line
                      )
                    }
                    className="flex w-full items-center justify-center gap-1.5 rounded-md bg-sky-500 px-3 py-1.5 text-xs font-semibold text-[#0B0D10] hover:bg-sky-400 transition-colors cursor-pointer"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    <span>
                      Inspect Evidence ({selectedEdge.evidence.file_path}:L{selectedEdge.evidence.start_line})
                    </span>
                  </button>
                )}

                <button
                  type="button"
                  onClick={() =>
                    onAskAboutDiagramItem(
                      `Why does ${selectedEdge.source} have a "${selectedEdge.relationship}" relationship to ${selectedEdge.target}?`,
                      undefined,
                      selectedEdge
                    )
                  }
                  className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[#232832] bg-[#161A21] px-3 py-1.5 text-xs font-medium text-[#E6E9EF] hover:border-sky-500/50 cursor-pointer"
                >
                  <MessageSquarePlus className="h-3.5 w-3.5 text-sky-400" />
                  <span>Ask Tutor about connection</span>
                </button>
              </div>
            )}
          </aside>
        )}
      </div>
    </div>
  );
}

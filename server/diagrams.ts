import type { AnalysisResult } from './analyzer.ts';
import type {
  DiagramPayload,
  DiagramType,
  DiagramVisualEdge,
  DiagramVisualNode,
  KnowledgeGraph,
  SequenceScenario,
  SequenceStep,
  WalkthroughStep,
} from '../src/types/codebase.ts';

function layoutRow(count: number, index: number, y: number, spacingX = 270): { x: number; y: number } {
  const totalWidth = (count - 1) * spacingX;
  return {
    x: Math.round(index * spacingX - totalWidth / 2 + 420),
    y,
  };
}

function buildSystemArchitectureDiagram(
  repositoryId: string,
  analysis: AnalysisResult,
  graph: KnowledgeGraph,
  majorModules: { id: string; name: string; fileCount: number; description: string }[],
  fileToModuleId: Map<string, string>
): DiagramPayload {
  const nodes: DiagramVisualNode[] = [];
  const edges: DiagramVisualEdge[] = [];
  const addedNodeIds = new Set<string>();

  // Layer 0: Entry Points (top up to 4)
  const entryFiles = analysis.entryPoints.slice(0, 4);
  entryFiles.forEach((ep, idx) => {
    const fileMeta = analysis.filesMeta.find((f) => f.path === ep.file_path);
    const pos = layoutRow(entryFiles.length, idx, 40, 260);
    const id = `sys_ep:${ep.file_path}`;
    addedNodeIds.add(id);
    nodes.push({
      id,
      graphNodeId: `file:${ep.file_path}`,
      label: ep.file_path.split('/').pop() ?? ep.file_path,
      sublabel: `Entry Point · ${fileMeta?.language ?? 'Source'}`,
      category: 'file',
      layer: 0,
      x: pos.x,
      y: pos.y,
      file_path: ep.file_path,
      start_line: 1,
      end_line: Math.min(40, fileMeta?.lineCount ?? 40),
      description: ep.reason,
      confidence: ep.confidence,
      childSymbolIds: fileMeta?.symbolIds ?? [],
      associatedFiles: [ep.file_path],
    });
  });

  // Layer 1: Major Logical Modules (up to 6 non-entry modules)
  const nonEntryMods = majorModules
    .filter((m) => m.id !== 'mod:entry_points')
    .slice(0, 6);

  nonEntryMods.forEach((mod, idx) => {
    const pos = layoutRow(nonEntryMods.length, idx, 210, 250);
    const modFiles = analysis.filesMeta.filter((f) => fileToModuleId.get(f.path) === mod.id);
    const firstFile = modFiles[0];
    const childSymbols = modFiles.flatMap((f) => f.symbolIds).slice(0, 12);
    addedNodeIds.add(mod.id);
    nodes.push({
      id: mod.id,
      graphNodeId: mod.id,
      label: mod.name,
      sublabel: `${mod.fileCount} file${mod.fileCount === 1 ? '' : 's'}`,
      category: 'module',
      layer: 1,
      x: pos.x,
      y: pos.y,
      file_path: firstFile?.path,
      start_line: 1,
      end_line: 25,
      description: mod.description,
      confidence: 'verified',
      childSymbolIds: childSymbols,
      associatedFiles: modFiles.map((f) => f.path).slice(0, 15),
    });
  });

  // Layer 2: API routes or External Dependencies (up to 5)
  const apiNodes = graph.nodes.filter((n) => n.type === 'api').slice(0, 3);
  const extNodes = graph.nodes.filter((n) => n.type === 'external').slice(0, Math.max(2, 5 - apiNodes.length));
  const layer2Items = [...apiNodes, ...extNodes].slice(0, 5);

  layer2Items.forEach((gn, idx) => {
    const pos = layoutRow(layer2Items.length, idx, 390, 240);
    addedNodeIds.add(gn.id);
    nodes.push({
      id: gn.id,
      graphNodeId: gn.id,
      label: gn.name,
      sublabel: gn.type === 'api' ? 'API Endpoint' : 'External Package',
      category: gn.type,
      layer: 2,
      x: pos.x,
      y: pos.y,
      file_path: gn.file_path,
      start_line: gn.start_line,
      end_line: gn.end_line,
      description: gn.description,
      confidence: 'verified',
    });
  });

  // Connect entry points -> modules based on actual imports or manifest references
  const edgeSig = new Set<string>();
  const pushEdge = (e: DiagramVisualEdge): void => {
    const key = `${e.source}->${e.target}:${e.relationship}`;
    if (!edgeSig.has(key) && addedNodeIds.has(e.source) && addedNodeIds.has(e.target) && e.source !== e.target) {
      edgeSig.add(key);
      edges.push(e);
    }
  };

  for (const ep of entryFiles) {
    const epFile = analysis.filesMeta.find((f) => f.path === ep.file_path);
    const srcId = `sys_ep:${ep.file_path}`;
    let connected = false;

    for (const imp of epFile?.imports ?? []) {
      if (imp.resolvedPath) {
        const targetMod = fileToModuleId.get(imp.resolvedPath);
        if (targetMod && addedNodeIds.has(targetMod)) {
          connected = true;
          pushEdge({
            id: `de:${srcId}->${targetMod}`,
            source: srcId,
            target: targetMod,
            relationship: 'imports',
            label: 'imports',
            confidence: 'verified',
            evidence: { file_path: ep.file_path, start_line: imp.line, end_line: imp.line },
            explanation: `${ep.file_path} imports ${imp.resolvedPath} at line ${imp.line}.`,
          });
        }
      } else {
        const pkg = imp.source.startsWith('@') ? imp.source.split('/').slice(0, 2).join('/') : imp.source.split('/')[0];
        if (addedNodeIds.has(`ext:${pkg}`)) {
          pushEdge({
            id: `de:${srcId}->ext:${pkg}`,
            source: srcId,
            target: `ext:${pkg}`,
            relationship: 'uses',
            label: 'uses',
            confidence: 'verified',
            evidence: { file_path: ep.file_path, start_line: imp.line, end_line: imp.line },
            explanation: `${ep.file_path} imports external dependency "${pkg}" at line ${imp.line}.`,
          });
        }
      }
    }

    if (!connected && nonEntryMods[0]) {
      pushEdge({
        id: `de:inferred_${srcId}->${nonEntryMods[0].id}`,
        source: srcId,
        target: nonEntryMods[0].id,
        relationship: 'uses',
        label: 'coordinates (inferred)',
        confidence: 'inferred',
        evidence: { file_path: ep.file_path, start_line: 1, end_line: 10 },
        explanation: `${ep.file_path} acts as an entry point interacting with ${nonEntryMods[0].name}.`,
      });
    }
  }

  // Module-to-module dependencies from Knowledge Graph
  for (const ge of graph.edges) {
    if (ge.relationship === 'depends_on' && addedNodeIds.has(ge.source) && addedNodeIds.has(ge.target)) {
      pushEdge({
        id: `de:${ge.id}`,
        graphEdgeId: ge.id,
        source: ge.source,
        target: ge.target,
        relationship: ge.relationship,
        label: ge.label ?? 'depends on',
        confidence: ge.confidence,
        evidence: ge.evidence,
        explanation: ge.evidence
          ? `Verified import in ${ge.evidence.file_path}:${ge.evidence.start_line}`
          : 'Module dependency derived from file imports.',
      });
    }
    if (ge.relationship === 'uses' && ge.target.startsWith('ext:') && addedNodeIds.has(ge.target)) {
      const srcFile = ge.source.replace(/^file:/, '');
      const srcMod = fileToModuleId.get(srcFile);
      if (srcMod && addedNodeIds.has(srcMod)) {
        pushEdge({
          id: `de:${srcMod}->${ge.target}`,
          graphEdgeId: ge.id,
          source: srcMod,
          target: ge.target,
          relationship: 'uses',
          label: 'uses',
          confidence: ge.confidence,
          evidence: ge.evidence,
          explanation: `Files inside ${srcMod} import ${ge.target.replace('ext:', '')}.`,
        });
      }
    }
  }

  return {
    id: `diag:${repositoryId}:system_architecture`,
    repositoryId,
    type: 'system_architecture',
    title: 'System Architecture',
    subtitle: 'Entry points, logical modules, and external dependencies derived from repository structure and imports.',
    available: nodes.length > 0,
    summary: `Maps ${entryFiles.length} entry point(s), ${nonEntryMods.length} logical module(s), and ${layer2Items.length} external/API integration(s).`,
    coverageNotes: analysis.coverageNotes,
    nodes,
    edges,
  };
}

function buildDataFlowDiagram(
  repositoryId: string,
  analysis: AnalysisResult,
  graph: KnowledgeGraph
): DiagramPayload {
  const nodes: DiagramVisualNode[] = [];
  const edges: DiagramVisualEdge[] = [];
  const added = new Set<string>();

  // Find verified call chains in the Knowledge Graph
  const callEdges = graph.edges.filter((e) => e.relationship === 'calls');
  const importEdges = graph.edges.filter((e) => e.relationship === 'imports');

  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  if (callEdges.length > 0) {
    // Pick up to 6 connected call relationships
    const selectedCalls = callEdges.slice(0, 7);
    const involvedIds = new Set<string>();
    for (const ce of selectedCalls) {
      involvedIds.add(ce.source);
      involvedIds.add(ce.target);
    }

    const involvedNodes = Array.from(involvedIds)
      .map((id) => nodeById.get(id))
      .filter((n): n is NonNullable<typeof n> => Boolean(n));

    // Compute simple topological depth
    const inDegree = new Map<string, number>();
    involvedNodes.forEach((n) => inDegree.set(n.id, 0));
    selectedCalls.forEach((e) => inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1));

    const layerBuckets: [typeof involvedNodes, typeof involvedNodes, typeof involvedNodes] = [[], [], []];
    for (const n of involvedNodes) {
      const deg = inDegree.get(n.id) ?? 0;
      const out = selectedCalls.some((e) => e.source === n.id);
      if (deg === 0) layerBuckets[0].push(n);
      else if (out) layerBuckets[1].push(n);
      else layerBuckets[2].push(n);
    }

    layerBuckets.forEach((bucket, layerIdx) => {
      bucket.forEach((gn, idx) => {
        const pos = layoutRow(bucket.length, idx, 60 + layerIdx * 170, 260);
        added.add(gn.id);
        const params = (gn.metadata?.parameters as string[] | undefined) ?? [];
        nodes.push({
          id: gn.id,
          graphNodeId: gn.id,
          label: gn.name,
          sublabel: params.length > 0 ? `(${params.join(', ')})` : gn.file_path?.split('/').pop(),
          category: gn.type,
          layer: layerIdx,
          x: pos.x,
          y: pos.y,
          file_path: gn.file_path,
          start_line: gn.start_line,
          end_line: gn.end_line,
          description: gn.description,
          confidence: 'verified',
        });
      });
    });

    for (const ce of selectedCalls) {
      if (added.has(ce.source) && added.has(ce.target)) {
        const targetNode = nodeById.get(ce.target);
        const params = (targetNode?.metadata?.parameters as string[] | undefined) ?? [];
        edges.push({
          id: `df:${ce.id}`,
          graphEdgeId: ce.id,
          source: ce.source,
          target: ce.target,
          relationship: 'sends_data_to',
          label: params.length > 0 ? `passes (${params.slice(0, 2).join(', ')})` : ce.label ?? 'calls',
          confidence: ce.confidence,
          evidence: ce.evidence,
          explanation: `Caller invokes ${targetNode?.name ?? ce.target}${params.length > 0 ? ` with parameters (${params.join(', ')})` : ''}.`,
        });
      }
    }
  } else if (importEdges.length > 0) {
    // Fallback to file-level data/dependency flow
    const selected = importEdges.slice(0, 6);
    const involvedIds = new Set<string>();
    selected.forEach((e) => {
      involvedIds.add(e.source);
      involvedIds.add(e.target);
    });
    const list = Array.from(involvedIds).map((id) => nodeById.get(id)).filter((n): n is NonNullable<typeof n> => Boolean(n));
    list.forEach((gn, idx) => {
      const row = Math.floor(idx / 3);
      const col = idx % 3;
      const pos = layoutRow(Math.min(3, list.length - row * 3), col, 60 + row * 170, 260);
      added.add(gn.id);
      nodes.push({
        id: gn.id,
        graphNodeId: gn.id,
        label: gn.name,
        sublabel: gn.file_path,
        category: gn.type,
        layer: row,
        x: pos.x,
        y: pos.y,
        file_path: gn.file_path,
        start_line: gn.start_line,
        end_line: gn.end_line,
        description: gn.description,
        confidence: 'verified',
      });
    });
    for (const ie of selected) {
      if (added.has(ie.source) && added.has(ie.target)) {
        edges.push({
          id: `df:${ie.id}`,
          graphEdgeId: ie.id,
          source: ie.source,
          target: ie.target,
          relationship: 'sends_data_to',
          label: ie.label ?? 'imports',
          confidence: 'inferred',
          evidence: ie.evidence,
          explanation: 'Data/control dependency inferred from module import statement.',
        });
      }
    }
  }

  return {
    id: `diag:${repositoryId}:data_flow`,
    repositoryId,
    type: 'data_flow',
    title: 'Data Flow',
    subtitle: 'How parameters, function calls, and module inputs move across components.',
    available: nodes.length > 0,
    availabilityNote: nodes.length === 0 ? 'No inter-function call chains or module imports were detected to trace data flow.' : undefined,
    summary:
      nodes.length > 0
        ? `Traces ${nodes.length} connected functions/modules and ${edges.length} data/control transitions.`
        : 'Insufficient static call/import edges to construct a data flow diagram.',
    coverageNotes: [
      ...analysis.coverageNotes,
      'Static analysis traces parameter signatures and direct call edges; dynamic runtime payloads are marked as inferred.',
    ],
    nodes,
    edges,
  };
}

export function buildSequenceDiagram(
  repositoryId: string,
  analysis: AnalysisResult,
  graph: KnowledgeGraph
): DiagramPayload {
  const scenarios: SequenceScenario[] = [];
  const callEdges = graph.edges.filter((e) => e.relationship === 'calls');
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  // Find root callers (symbols that call other symbols)
  const callersMap = new Map<string, typeof callEdges>();
  for (const ce of callEdges) {
    const arr = callersMap.get(ce.source) ?? [];
    arr.push(ce);
    callersMap.set(ce.source, arr);
  }

  // Sort callers by number of outgoing calls and entry-point priority
  const entrySet = new Set(analysis.entryPoints.map((e) => e.file_path));
  const sortedCallers = Array.from(callersMap.entries())
    .sort((a, b) => {
      const aNode = nodeById.get(a[0]);
      const bNode = nodeById.get(b[0]);
      const aEntry = aNode?.file_path && entrySet.has(aNode.file_path) ? 10 : 0;
      const bEntry = bNode?.file_path && entrySet.has(bNode.file_path) ? 10 : 0;
      return (bEntry + b[1].length) - (aEntry + a[1].length);
    })
    .slice(0, 3);

  sortedCallers.forEach(([callerId, edges], sIdx) => {
    const callerNode = nodeById.get(callerId);
    if (!callerNode) return;

    const steps: SequenceStep[] = [];
    const participants = new Set<string>(['Caller', callerNode.name]);
    let order = 1;

    steps.push({
      id: `seq_${sIdx}_0`,
      order: order++,
      from: 'Caller',
      to: callerNode.name,
      message: `invoke ${callerNode.name}()`,
      type: 'call',
      file_path: callerNode.file_path,
      start_line: callerNode.start_line,
      end_line: callerNode.end_line,
      confidence: 'verified',
    });

    for (const ce of edges.slice(0, 6)) {
      const targetNode = nodeById.get(ce.target);
      if (!targetNode) continue;
      participants.add(targetNode.name);
      steps.push({
        id: `seq_${sIdx}_${order}`,
        order: order++,
        from: callerNode.name,
        to: targetNode.name,
        message: `${targetNode.name}()`,
        type: 'call',
        file_path: ce.evidence?.file_path ?? callerNode.file_path,
        start_line: ce.evidence?.start_line ?? callerNode.start_line,
        end_line: ce.evidence?.end_line ?? callerNode.end_line,
        confidence: ce.confidence,
      });

      // Check 2nd-hop calls
      const secondHop = callersMap.get(targetNode.id)?.[0];
      if (secondHop) {
        const hopTarget = nodeById.get(secondHop.target);
        if (hopTarget) {
          participants.add(hopTarget.name);
          steps.push({
            id: `seq_${sIdx}_${order}`,
            order: order++,
            from: targetNode.name,
            to: hopTarget.name,
            message: `${hopTarget.name}()`,
            type: 'call',
            file_path: secondHop.evidence?.file_path ?? targetNode.file_path,
            start_line: secondHop.evidence?.start_line ?? targetNode.start_line,
            end_line: secondHop.evidence?.end_line ?? targetNode.end_line,
            confidence: secondHop.confidence,
          });
        }
      }
    }

    steps.push({
      id: `seq_${sIdx}_ret`,
      order: order++,
      from: callerNode.name,
      to: 'Caller',
      message: 'return result',
      type: 'return',
      file_path: callerNode.file_path,
      start_line: callerNode.end_line,
      end_line: callerNode.end_line,
      confidence: 'inferred',
    });

    const participantIds = new Map<string, string>();
    Array.from(participants).forEach((participant, index) => {
      participantIds.set(participant, `participant_${index}`);
    });
    const getParticipantId = (participant: string) => {
      const id = participantIds.get(participant);
      if (!id) throw new Error(`Missing sequence participant: ${participant}`);
      return id;
    };
    const mermaidLines = ['sequenceDiagram'];
    for (const p of participants) {
      mermaidLines.push(`  participant ${getParticipantId(p)} as ${p}`);
    }
    for (const st of steps) {
      const arrow = st.type === 'return' ? '-->>' : '->>';
      mermaidLines.push(`  ${getParticipantId(st.from)}${arrow}${getParticipantId(st.to)}: ${st.message}`);
    }

    scenarios.push({
      id: `scenario_${sIdx}`,
      title: `${callerNode.name} Execution Trace`,
      description: `Verified static call sequence starting at ${callerNode.name} in ${callerNode.file_path}.`,
      participants: Array.from(participants),
      steps,
      mermaidCode: mermaidLines.join('\n'),
    });
  });

  // Also synthesize React Flow visual nodes/edges for the primary scenario so cross-diagram selection works
  const primary = scenarios[0];
  const nodes: DiagramVisualNode[] = [];
  const edges: DiagramVisualEdge[] = [];
  if (primary) {
    primary.participants.forEach((p, idx) => {
      const sym = analysis.symbols.find((s) => s.name === p);
      nodes.push({
        id: `seq_p:${p}`,
        graphNodeId: sym?.id ?? `seq_p:${p}`,
        label: p,
        sublabel: sym ? `${sym.file_path}:${sym.start_line}` : 'External Caller',
        category: sym ? 'function' : 'external',
        layer: 0,
        x: 120 + idx * 240,
        y: 120,
        file_path: sym?.file_path,
        start_line: sym?.start_line,
        end_line: sym?.end_line,
        description: sym?.description ?? 'Initiating caller',
        confidence: sym ? 'verified' : 'inferred',
      });
    });
    primary.steps.forEach((st) => {
      edges.push({
        id: st.id,
        source: `seq_p:${st.from}`,
        target: `seq_p:${st.to}`,
        relationship: 'calls',
        label: `${st.order}. ${st.message}`,
        confidence: st.confidence,
        evidence: st.file_path
          ? { file_path: st.file_path, start_line: st.start_line ?? 1, end_line: st.end_line ?? 1 }
          : undefined,
      });
    });
  }

  return {
    id: `diag:${repositoryId}:sequence`,
    repositoryId,
    type: 'sequence',
    title: 'Sequence Diagrams',
    subtitle: 'Step-by-step call sequences extracted from verified function call graphs.',
    available: scenarios.length > 0,
    availabilityNote:
      scenarios.length === 0
        ? 'No multi-step function call chains were resolved in this repository.'
        : undefined,
    summary:
      scenarios.length > 0
        ? `Generated ${scenarios.length} verified execution scenario(s) from static call analysis.`
        : 'No sequence scenarios available.',
    coverageNotes: [
      'Each sequence diagram reflects the specific analyzed call chain and does not claim to cover all dynamic runtime branches.',
    ],
    nodes,
    edges,
    mermaidCode: primary?.mermaidCode,
    scenarios,
  };
}

function buildCicdDiagram(repositoryId: string, analysis: AnalysisResult): DiagramPayload {
  const nodes: DiagramVisualNode[] = [];
  const edges: DiagramVisualEdge[] = [];

  if (analysis.workflowJobs.length === 0) {
    return {
      id: `diag:${repositoryId}:cicd_pipeline`,
      repositoryId,
      type: 'cicd_pipeline',
      title: 'CI/CD Pipeline',
      subtitle: 'Automated build, test, and release workflows parsed from repository CI configs.',
      available: false,
      availabilityNote: 'No CI/CD workflow definitions (.github/workflows/*.yml, .gitlab-ci.yml, or Jenkinsfile) were found in this repository.',
      summary: 'No CI/CD pipeline configuration detected.',
      coverageNotes: ['Codebase Tutor does not invent pipeline stages when no workflow configuration exists.'],
      nodes: [],
      edges: [],
    };
  }

  // Unique triggers
  const triggerSet = new Set<string>();
  analysis.workflowJobs.forEach((j) => j.triggers.forEach((t) => triggerSet.add(t)));
  const triggers = Array.from(triggerSet);

  triggers.forEach((trig, idx) => {
    const pos = layoutRow(triggers.length, idx, 40, 220);
    nodes.push({
      id: `wf_trig:${trig}`,
      graphNodeId: `wf_trig:${trig}`,
      label: `Trigger: ${trig}`,
      sublabel: 'GitHub Event',
      category: 'workflow',
      layer: 0,
      x: pos.x,
      y: pos.y,
      file_path: analysis.workflowJobs[0]?.workflowFile,
      start_line: 1,
      end_line: 10,
      description: `Workflow event trigger "${trig}"`,
      confidence: 'verified',
    });
  });

  // Jobs
  analysis.workflowJobs.forEach((job, idx) => {
    const pos = layoutRow(analysis.workflowJobs.length, idx, 210, 280);
    const jobId = `wf:${job.workflowFile}:${job.jobId}`;
    const stepSummary = job.steps.map((s) => s.name).slice(0, 4).join(' → ');
    nodes.push({
      id: jobId,
      graphNodeId: jobId,
      label: `${job.workflowName}: ${job.jobName}`,
      sublabel: `${job.runsOn} · ${job.steps.length} step(s)`,
      category: 'workflow',
      layer: 1,
      x: pos.x,
      y: pos.y,
      file_path: job.workflowFile,
      start_line: job.start_line,
      end_line: job.end_line,
      description: stepSummary ? `Steps: ${stepSummary}` : `Job ${job.jobId}`,
      confidence: 'verified',
      metadata: { steps: job.steps, runsOn: job.runsOn, triggers: job.triggers },
    });

    if (job.needs.length === 0) {
      for (const trig of job.triggers) {
        edges.push({
          id: `wf_e:${trig}->${jobId}`,
          source: `wf_trig:${trig}`,
          target: jobId,
          relationship: 'triggers',
          label: 'triggers',
          confidence: 'verified',
          evidence: { file_path: job.workflowFile, start_line: job.start_line, end_line: job.end_line },
        });
      }
    } else {
      for (const dep of job.needs) {
        edges.push({
          id: `wf_dep:${dep}->${jobId}`,
          source: `wf:${job.workflowFile}:${dep}`,
          target: jobId,
          relationship: 'triggers',
          label: 'needs',
          confidence: 'verified',
          evidence: { file_path: job.workflowFile, start_line: job.start_line, end_line: job.end_line },
        });
      }
    }
  });

  // Mermaid representation
  const mLines = ['flowchart TD'];
  for (const e of edges) {
    const s = e.source.replace(/[^A-Za-z0-9_]/g, '_');
    const t = e.target.replace(/[^A-Za-z0-9_]/g, '_');
    const sn = nodes.find((n) => n.id === e.source)?.label ?? e.source;
    const tn = nodes.find((n) => n.id === e.target)?.label ?? e.target;
    mLines.push(`  ${s}["${sn.replace(/"/g, "'")}"] -->|${e.label}| ${t}["${tn.replace(/"/g, "'")}"]`);
  }

  return {
    id: `diag:${repositoryId}:cicd_pipeline`,
    repositoryId,
    type: 'cicd_pipeline',
    title: 'CI/CD Pipeline',
    subtitle: 'Triggers, jobs, dependencies, and commands extracted from workflow YAML manifests.',
    available: true,
    summary: `Parsed ${analysis.workflowJobs.length} CI/CD job(s) across ${new Set(analysis.workflowJobs.map((j) => j.workflowFile)).size} workflow file(s).`,
    coverageNotes: ['Extracted directly from repository workflow YAML files using js-yaml.'],
    nodes,
    edges,
    mermaidCode: mLines.join('\n'),
  };
}

function buildDeploymentDiagram(repositoryId: string, analysis: AnalysisResult): DiagramPayload {
  if (analysis.deploymentUnits.length === 0) {
    return {
      id: `diag:${repositoryId}:deployment`,
      repositoryId,
      type: 'deployment',
      title: 'Deployment Architecture',
      subtitle: 'Intended container, service, and infrastructure topology from repo manifests.',
      available: false,
      availabilityNote: 'No Dockerfile, Docker Compose, Kubernetes, or Terraform manifests were found in this repository.',
      summary: 'No deployment configuration files detected.',
      coverageNotes: [
        'Repository configuration describes intended deployment only; no infrastructure manifests were found.',
      ],
      nodes: [],
      edges: [],
    };
  }

  const nodes: DiagramVisualNode[] = [];
  const edges: DiagramVisualEdge[] = [];

  analysis.deploymentUnits.forEach((unit, idx) => {
    const pos = layoutRow(analysis.deploymentUnits.length, idx, 140, 260);
    const id = `deploy:${unit.sourceFile}:${unit.name}`;
    nodes.push({
      id,
      graphNodeId: id,
      label: unit.name,
      sublabel: unit.imageOrBase ?? unit.kind,
      category: unit.kind === 'database' ? 'database' : 'container',
      layer: unit.kind === 'proxy' ? 0 : unit.kind === 'database' ? 2 : 1,
      x: pos.x,
      y: pos.y,
      file_path: unit.sourceFile,
      start_line: unit.start_line,
      end_line: unit.end_line,
      description: `Intended ${unit.kind} defined in ${unit.sourceFile}${unit.ports.length ? ` (ports: ${unit.ports.join(', ')})` : ''}`,
      confidence: 'verified',
      metadata: { ports: unit.ports, commands: unit.commands },
    });

    for (const dep of unit.dependsOn) {
      edges.push({
        id: `dep:${id}->${dep}`,
        source: id,
        target: `deploy:${unit.sourceFile}:${dep}`,
        relationship: 'depends_on',
        label: 'depends_on',
        confidence: 'verified',
        evidence: { file_path: unit.sourceFile, start_line: unit.start_line, end_line: unit.end_line },
      });
    }
  });

  return {
    id: `diag:${repositoryId}:deployment`,
    repositoryId,
    type: 'deployment',
    title: 'Deployment Architecture',
    subtitle: 'Intended container & service topology from repository infrastructure files (not live production state).',
    available: true,
    summary: `Found ${analysis.deploymentUnits.length} intended container/service definition(s).`,
    coverageNotes: [
      'Note: Deployment diagrams reflect intended configuration defined in repository files and do not verify live running infrastructure.',
    ],
    nodes,
    edges,
  };
}

function buildClassDiagram(
  repositoryId: string,
  analysis: AnalysisResult,
  graph: KnowledgeGraph
): DiagramPayload {
  const classSymbols = analysis.symbols.filter((s) => s.kind === 'class');

  if (classSymbols.length === 0) {
    return {
      id: `diag:${repositoryId}:class_diagram`,
      repositoryId,
      type: 'class_diagram',
      title: 'Class Diagrams',
      subtitle: 'Extracted classes, attributes, methods, and inheritance relationships.',
      available: false,
      availabilityNote: 'No class declarations were found in this repository (it appears to use functional modules, hooks, or scripts).',
      summary: 'No classes detected in repository source files.',
      coverageNotes: ['Static AST and Python parsers scanned all supported files for class definitions.'],
      nodes: [],
      edges: [],
    };
  }

  const nodes: DiagramVisualNode[] = [];
  const edges: DiagramVisualEdge[] = [];
  const shown = classSymbols.slice(0, 14);

  shown.forEach((cls, idx) => {
    const row = Math.floor(idx / 3);
    const col = idx % 3;
    const pos = layoutRow(Math.min(3, shown.length - row * 3), col, 50 + row * 200, 280);
    nodes.push({
      id: cls.id,
      graphNodeId: cls.id,
      label: cls.name,
      sublabel: `${cls.methods?.length ?? 0} methods · ${cls.attributes?.length ?? 0} fields`,
      category: 'class',
      layer: row,
      x: pos.x,
      y: pos.y,
      file_path: cls.file_path,
      start_line: cls.start_line,
      end_line: cls.end_line,
      description: cls.description,
      confidence: 'verified',
      metadata: {
        methods: cls.methods,
        attributes: cls.attributes,
        extends_name: cls.extends_name,
        implements_names: cls.implements_names,
      },
    });
  });

  const shownIds = new Set(shown.map((c) => c.id));
  for (const ge of graph.edges) {
    if ((ge.relationship === 'inherits' || ge.relationship === 'implements') && shownIds.has(ge.source) && shownIds.has(ge.target)) {
      edges.push({
        id: `cls_e:${ge.id}`,
        graphEdgeId: ge.id,
        source: ge.source,
        target: ge.target,
        relationship: ge.relationship,
        label: ge.relationship,
        confidence: ge.confidence,
        evidence: ge.evidence,
      });
    }
  }

  const safeId = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_');
  const mLines = ['classDiagram'];
  for (const cls of shown) {
    const clsName = safeId(cls.name);
    mLines.push(`  class ${clsName} {`);
    for (const attr of (cls.attributes ?? []).slice(0, 5)) {
      mLines.push(`    +${safeId(attr)}`);
    }
    for (const m of (cls.methods ?? []).slice(0, 6)) {
      mLines.push(`    +${safeId(m)}()`);
    }
    mLines.push(`  }`);
    if (cls.extends_name) {
      mLines.push(`  ${safeId(cls.extends_name)} <|-- ${clsName}`);
    }
  }

  return {
    id: `diag:${repositoryId}:class_diagram`,
    repositoryId,
    type: 'class_diagram',
    title: 'Class Diagrams',
    subtitle: 'Classes, methods, attributes, and inheritance hierarchies extracted from source AST.',
    available: true,
    summary: `Extracted ${classSymbols.length} class definition(s) across repository files.`,
    coverageNotes: analysis.coverageNotes,
    nodes,
    edges,
    mermaidCode: mLines.join('\n'),
  };
}

export function generateAllDiagrams(
  repositoryId: string,
  analysis: AnalysisResult,
  graph: KnowledgeGraph,
  majorModules: { id: string; name: string; fileCount: number; description: string }[],
  fileToModuleId: Map<string, string>
): Record<DiagramType, DiagramPayload> {
  return {
    system_architecture: buildSystemArchitectureDiagram(repositoryId, analysis, graph, majorModules, fileToModuleId),
    data_flow: buildDataFlowDiagram(repositoryId, analysis, graph),
    sequence: buildSequenceDiagram(repositoryId, analysis, graph),
    cicd_pipeline: buildCicdDiagram(repositoryId, analysis),
    deployment: buildDeploymentDiagram(repositoryId, analysis),
    class_diagram: buildClassDiagram(repositoryId, analysis, graph),
  };
}

export function generateWalkthrough(
  analysis: AnalysisResult,
  diagrams: Record<DiagramType, DiagramPayload>
): WalkthroughStep[] {
  const steps: WalkthroughStep[] = [];

  const readme = analysis.filesMeta.find((f) => f.path.toLowerCase() === 'readme.md');
  if (readme) {
    steps.push({
      id: 'walk_readme',
      title: '1. Start here: Understand the project',
      summary: analysis.readmeSummary,
      file_path: readme.path,
      start_line: 1,
      end_line: Math.min(40, readme.lineCount),
      diagram_type: 'system_architecture',
    });
  }

  const primaryEp = analysis.entryPoints[0];
  if (primaryEp) {
    steps.push({
      id: 'walk_entrypoint',
      title: '2. Follow the application entry point',
      summary: `${primaryEp.file_path} — ${primaryEp.reason}`,
      file_path: primaryEp.file_path,
      start_line: 1,
      end_line: 35,
      diagram_type: 'system_architecture',
    });
  }

  if (diagrams.system_architecture.available) {
    const firstModFile = diagrams.system_architecture.nodes.find((n) => n.category === 'module' && n.file_path);
    if (firstModFile?.file_path) {
      steps.push({
        id: 'walk_arch',
        title: '3. Explore the main module structure',
        summary: `${firstModFile.label}: ${firstModFile.description}`,
        file_path: firstModFile.file_path,
        start_line: 1,
        end_line: 30,
        diagram_type: 'system_architecture',
      });
    }
  }

  if (diagrams.sequence.available && diagrams.sequence.scenarios?.[0]?.steps[0]) {
    const st = diagrams.sequence.scenarios[0].steps[0];
    if (st.file_path) {
      steps.push({
        id: 'walk_seq',
        title: '4. Trace an execution flow',
        summary: diagrams.sequence.scenarios[0].description,
        file_path: st.file_path,
        start_line: st.start_line,
        end_line: st.end_line,
        diagram_type: 'sequence',
      });
    }
  }

  if (diagrams.cicd_pipeline.available && analysis.workflowJobs[0]) {
    const job = analysis.workflowJobs[0];
    steps.push({
      id: 'walk_cicd',
      title: '5. Inspect automated testing & CI workflows',
      summary: `${job.workflowName} runs ${job.steps.length} step(s) on ${job.triggers.join(', ') || 'workflow trigger'}.`,
      file_path: job.workflowFile,
      start_line: job.start_line,
      end_line: job.end_line,
      diagram_type: 'cicd_pipeline',
    });
  }

  return steps;
}

import type { AnalysisResult } from './analyzer.ts';
import type {
  AnalyzedFileMeta,
  ExtractedSymbol,
  GraphEdge,
  GraphNode,
  KnowledgeGraph,
} from '../src/types/codebase.ts';

function resolveLogicalModule(file: AnalyzedFileMeta): { id: string; name: string; description: string } {
  const topFolder = file.path.includes('/') ? file.path.split('/')[0] : 'root';

  if (file.isEntryPoint || file.role === 'entry_point') {
    return {
      id: 'mod:entry_points',
      name: 'Entry Points & Runtime Bootstrap',
      description: 'Primary entry scripts, CLI commands, and server/application initialization files.',
    };
  }
  if (file.role === 'infrastructure') {
    return {
      id: 'mod:infrastructure',
      name: 'CI/CD & Infrastructure',
      description: 'Workflow automation, container definitions, and deployment configuration.',
    };
  }
  if (file.role === 'tests') {
    return {
      id: 'mod:tests',
      name: 'Test Suite',
      description: 'Automated unit, integration, and behavior verification tests.',
    };
  }
  if (file.role === 'api_route' || file.role === 'backend') {
    return {
      id: 'mod:backend_api',
      name: 'Backend & API Routes',
      description: 'Server request handlers, route endpoints, and backend services.',
    };
  }
  if (file.role === 'frontend' || file.role === 'component') {
    return {
      id: 'mod:frontend_ui',
      name: 'Frontend & UI Components',
      description: 'Interactive user interface views, components, and client state.',
    };
  }
  if (file.role === 'database' || file.role === 'model') {
    return {
      id: 'mod:data_models',
      name: 'Data Models & Storage',
      description: 'Schemas, entity models, and database access modules.',
    };
  }
  if (file.role === 'plugin_or_skill') {
    return {
      id: 'mod:plugins_skills',
      name: 'Plugins, Rules & Commands',
      description: 'Editor/agent integration manifests, command definitions, and rule bundles.',
    };
  }
  if (file.role === 'documentation') {
    return {
      id: 'mod:documentation',
      name: 'Documentation & Examples',
      description: 'Project guides, architectural docs, and example references.',
    };
  }
  if (topFolder !== 'root' && topFolder !== 'src') {
    const cleanName = topFolder.replace(/^[._]/, '').replace(/[-_]/g, ' ');
    const title = cleanName.charAt(0).toUpperCase() + cleanName.slice(1);
    return {
      id: `mod:dir_${topFolder}`,
      name: `${title} Module`,
      description: `Source files and utilities organized under ${topFolder}/`,
    };
  }
  if (file.role === 'config') {
    return {
      id: 'mod:configuration',
      name: 'Project Configuration',
      description: 'Package manifests, compiler settings, and environment templates.',
    };
  }
  return {
    id: 'mod:core_services',
    name: 'Core Modules & Scripts',
    description: 'Core application logic, helpers, and utility modules.',
  };
}

export function buildKnowledgeGraph(
  repositoryId: string,
  repoFullName: string,
  commitSha: string,
  analysis: AnalysisResult
): {
  graph: KnowledgeGraph;
  majorModules: { id: string; name: string; fileCount: number; description: string }[];
  importantFolders: { path: string; fileCount: number; role: string }[];
  fileToModuleId: Map<string, string>;
} {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const nodeMap = new Map<string, GraphNode>();
  const edgeSet = new Set<string>();

  const addNode = (node: GraphNode): void => {
    if (!nodeMap.has(node.id)) {
      nodeMap.set(node.id, node);
      nodes.push(node);
    }
  };

  const addEdge = (edge: GraphEdge): void => {
    const sig = `${edge.source}->${edge.target}:${edge.relationship}`;
    if (!edgeSet.has(sig)) {
      edgeSet.add(sig);
      edges.push(edge);
    }
  };

  // Root repository node
  addNode({
    id: `repo:${repositoryId}`,
    type: 'repository',
    name: repoFullName,
    description: analysis.readmeSummary,
    metadata: { commitSha },
  });

  // Track modules and folders
  const moduleCounts = new Map<string, { id: string; name: string; description: string; fileCount: number }>();
  const folderCounts = new Map<string, { count: number; roles: Map<string, number> }>();
  const fileToModuleId = new Map<string, string>();

  // 1. Add Module & File nodes
  for (const file of analysis.filesMeta) {
    if (file.role === 'asset') continue;

    const topFolder = file.path.includes('/') ? file.path.split('/')[0] : '(root)';
    const fc = folderCounts.get(topFolder) ?? { count: 0, roles: new Map() };
    fc.count++;
    fc.roles.set(file.role, (fc.roles.get(file.role) ?? 0) + 1);
    folderCounts.set(topFolder, fc);

    const mod = resolveLogicalModule(file);
    fileToModuleId.set(file.path, mod.id);

    const existingMod = moduleCounts.get(mod.id);
    if (existingMod) {
      existingMod.fileCount++;
    } else {
      moduleCounts.set(mod.id, { ...mod, fileCount: 1 });
      addNode({
        id: mod.id,
        type: 'module',
        name: mod.name,
        description: mod.description,
      });
      addEdge({
        id: `edge:repo_mod_${mod.id}`,
        source: `repo:${repositoryId}`,
        target: mod.id,
        relationship: 'contains',
        label: 'contains module',
        confidence: 'verified',
        analysis_method: 'config_parser',
      });
    }

    const fileNodeId = `file:${file.path}`;
    addNode({
      id: fileNodeId,
      type: 'file',
      name: file.name,
      file_path: file.path,
      start_line: 1,
      end_line: file.lineCount,
      language: file.language,
      role: file.role,
      description: file.summary,
      metadata: {
        isEntryPoint: file.isEntryPoint,
        entryPointReason: file.entryPointReason,
        exports: file.exports,
      },
    });

    addEdge({
      id: `edge:mod_file_${mod.id}_${file.path}`,
      source: mod.id,
      target: fileNodeId,
      relationship: 'contains',
      label: 'includes',
      evidence: { file_path: file.path, start_line: 1, end_line: Math.min(10, file.lineCount) },
      confidence: 'verified',
      analysis_method: 'config_parser',
    });
  }

  // 2. Add Symbol nodes (functions, classes, api routes)
  const symbolsByName = new Map<string, ExtractedSymbol[]>();
  for (const sym of analysis.symbols) {
    const cleanName = sym.name.includes('.') ? sym.name.split('.').pop()! : sym.name;
    const list = symbolsByName.get(cleanName) ?? [];
    list.push(sym);
    symbolsByName.set(cleanName, list);

    const nodeType =
      sym.kind === 'class'
        ? 'class'
        : sym.kind === 'api_route'
          ? 'api'
          : 'function';

    addNode({
      id: sym.id,
      type: nodeType,
      name: sym.name,
      file_path: sym.file_path,
      start_line: sym.start_line,
      end_line: sym.end_line,
      language: sym.language,
      description: sym.description,
      metadata: {
        kind: sym.kind,
        signature: sym.signature,
        parameters: sym.parameters,
        return_type: sym.return_type,
        extends_name: sym.extends_name,
        implements_names: sym.implements_names,
        methods: sym.methods,
        attributes: sym.attributes,
      },
    });

    addEdge({
      id: `edge:file_sym_${sym.id}`,
      source: `file:${sym.file_path}`,
      target: sym.id,
      relationship: 'contains',
      label: sym.kind,
      evidence: { file_path: sym.file_path, start_line: sym.start_line, end_line: sym.end_line },
      confidence: 'verified',
      analysis_method: 'ast',
    });
  }

  // 3. Add File Import & Module Dependency edges
  const externalPackages = new Set<string>();
  for (const file of analysis.filesMeta) {
    if (file.role === 'asset') continue;
    const sourceModId = fileToModuleId.get(file.path);

    for (const imp of file.imports) {
      if (imp.resolvedPath) {
        addEdge({
          id: `edge:imp_${file.path}_${imp.resolvedPath}_${imp.line}`,
          source: `file:${file.path}`,
          target: `file:${imp.resolvedPath}`,
          relationship: 'imports',
          label: imp.specifiers.length > 0 ? `imports ${imp.specifiers.slice(0, 2).join(', ')}` : 'imports',
          evidence: { file_path: file.path, start_line: imp.line, end_line: imp.line },
          confidence: 'verified',
          analysis_method: 'ast',
        });

        const targetModId = fileToModuleId.get(imp.resolvedPath);
        if (sourceModId && targetModId && sourceModId !== targetModId) {
          addEdge({
            id: `edge:mod_dep_${sourceModId}_${targetModId}`,
            source: sourceModId,
            target: targetModId,
            relationship: 'depends_on',
            label: 'imports from',
            evidence: { file_path: file.path, start_line: imp.line, end_line: imp.line },
            confidence: 'verified',
            analysis_method: 'ast',
          });
        }
      } else if (!imp.source.startsWith('.') && !imp.source.startsWith('node:')) {
        const pkgName = imp.source.startsWith('@')
          ? imp.source.split('/').slice(0, 2).join('/')
          : imp.source.split('/')[0];
        if (pkgName && pkgName.length > 1) {
          externalPackages.add(pkgName);
          const extId = `ext:${pkgName}`;
          addNode({
            id: extId,
            type: 'external',
            name: pkgName,
            description: `External dependency "${pkgName}" imported by repository code.`,
          });
          addEdge({
            id: `edge:ext_${file.path}_${pkgName}_${imp.line}`,
            source: `file:${file.path}`,
            target: extId,
            relationship: 'uses',
            label: 'uses package',
            evidence: { file_path: file.path, start_line: imp.line, end_line: imp.line },
            confidence: 'verified',
            analysis_method: 'ast',
          });
        }
      }
    }
  }

  // 4. Add Function Call & Class Inheritance edges
  const classNodesByName = new Map<string, GraphNode>();
  for (const n of nodes) {
    if (n.type === 'class') classNodesByName.set(n.name, n);
  }

  for (const sym of analysis.symbols) {
    // Inheritance / implements
    if (sym.kind === 'class') {
      if (sym.extends_name) {
        const baseNode = classNodesByName.get(sym.extends_name);
        if (baseNode) {
          addEdge({
            id: `edge:inh_${sym.id}_${baseNode.id}`,
            source: sym.id,
            target: baseNode.id,
            relationship: 'inherits',
            label: 'extends',
            evidence: { file_path: sym.file_path, start_line: sym.start_line, end_line: sym.start_line + 1 },
            confidence: 'verified',
            analysis_method: 'ast',
          });
        }
      }
      for (const impl of sym.implements_names ?? []) {
        const ifaceNode = classNodesByName.get(impl);
        if (ifaceNode) {
          addEdge({
            id: `edge:impl_${sym.id}_${ifaceNode.id}`,
            source: sym.id,
            target: ifaceNode.id,
            relationship: 'implements',
            label: 'implements',
            evidence: { file_path: sym.file_path, start_line: sym.start_line, end_line: sym.start_line + 1 },
            confidence: 'verified',
            analysis_method: 'ast',
          });
        }
      }
    }

    // Calls between known symbols
    const callerFileMeta = analysis.filesMeta.find((f) => f.path === sym.file_path);
    const importedPaths = new Set(
      (callerFileMeta?.imports ?? []).map((i) => i.resolvedPath).filter(Boolean) as string[]
    );

    for (const callName of sym.calls) {
      const bareName = callName.includes('.') ? callName.split('.').pop()! : callName;
      const candidates = symbolsByName.get(bareName);
      if (!candidates || candidates.length === 0) continue;

      // Prefer same-file or imported-file match for verified confidence
      const sameFileMatch = candidates.find((c) => c.file_path === sym.file_path && c.id !== sym.id);
      const importedFileMatch = candidates.find((c) => importedPaths.has(c.file_path) && c.id !== sym.id);
      const uniqueGlobalMatch = candidates.length === 1 && candidates[0].id !== sym.id ? candidates[0] : undefined;

      const target = sameFileMatch ?? importedFileMatch ?? uniqueGlobalMatch;
      if (target) {
        addEdge({
          id: `edge:call_${sym.id}_${target.id}`,
          source: sym.id,
          target: target.id,
          relationship: 'calls',
          label: `calls ${bareName}()`,
          evidence: { file_path: sym.file_path, start_line: sym.start_line, end_line: sym.end_line },
          confidence: sameFileMatch || importedFileMatch ? 'verified' : 'inferred',
          analysis_method: sameFileMatch || importedFileMatch ? 'ast' : 'heuristic',
        });
      }
    }
  }

  // 5. Add CI/CD Workflow nodes & edges
  for (const job of analysis.workflowJobs) {
    const wfId = `wf:${job.workflowFile}:${job.jobId}`;
    addNode({
      id: wfId,
      type: 'workflow',
      name: `${job.workflowName} / ${job.jobName}`,
      file_path: job.workflowFile,
      start_line: job.start_line,
      end_line: job.end_line,
      description: `CI/CD job "${job.jobId}" triggered on ${job.triggers.join(', ') || 'manual'}`,
      metadata: {
        triggers: job.triggers,
        runsOn: job.runsOn,
        steps: job.steps,
        needs: job.needs,
      },
    });
    for (const dep of job.needs) {
      addEdge({
        id: `edge:wf_need_${wfId}_${dep}`,
        source: `wf:${job.workflowFile}:${dep}`,
        target: wfId,
        relationship: 'triggers',
        label: 'needs -> triggers',
        evidence: { file_path: job.workflowFile, start_line: job.start_line, end_line: job.end_line },
        confidence: 'verified',
        analysis_method: 'config_parser',
      });
    }
  }

  // 6. Add Deployment Container/Service nodes
  for (const unit of analysis.deploymentUnits) {
    const unitId = `deploy:${unit.sourceFile}:${unit.name}`;
    addNode({
      id: unitId,
      type: unit.kind === 'database' ? 'database' : 'container',
      name: unit.name,
      file_path: unit.sourceFile,
      start_line: unit.start_line,
      end_line: unit.end_line,
      description: `Intended ${unit.kind} defined in ${unit.sourceFile}${unit.imageOrBase ? ` (${unit.imageOrBase})` : ''}`,
      metadata: {
        ports: unit.ports,
        commands: unit.commands,
        imageOrBase: unit.imageOrBase,
      },
    });
    for (const dep of unit.dependsOn) {
      addEdge({
        id: `edge:dep_${unitId}_${dep}`,
        source: unitId,
        target: `deploy:${unit.sourceFile}:${dep}`,
        relationship: 'depends_on',
        label: 'depends_on',
        evidence: { file_path: unit.sourceFile, start_line: unit.start_line, end_line: unit.end_line },
        confidence: 'verified',
        analysis_method: 'config_parser',
      });
    }
  }

  const majorModules = Array.from(moduleCounts.values()).sort((a, b) => b.fileCount - a.fileCount);
  const importantFolders = Array.from(folderCounts.entries())
    .map(([path, info]) => {
      const topRole = Array.from(info.roles.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
      return { path, fileCount: info.count, role: topRole.replace(/_/g, ' ') };
    })
    .sort((a, b) => b.fileCount - a.fileCount)
    .slice(0, 10);

  const graph: KnowledgeGraph = {
    repositoryId,
    commitSha,
    nodes,
    edges,
    stats: {
      totalFiles: analysis.filesMeta.length,
      analyzedFiles: analysis.filesMeta.filter((f) => f.role !== 'asset').length,
      totalFunctions: analysis.symbols.filter((s) => s.kind === 'function' || s.kind === 'method').length,
      totalClasses: analysis.symbols.filter((s) => s.kind === 'class').length,
      totalEdges: edges.length,
    },
  };

  return { graph, majorModules, importantFolders, fileToModuleId };
}

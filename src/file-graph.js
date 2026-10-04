import ForceGraph2D from 'force-graph';
import { fetchGitHubJson, parseRepositoryUrl } from './github.js';
import './style.css';

const tabs = document.querySelectorAll('[role="tab"]');
const form = document.getElementById('file-graph-form');
const repositoryUrlInput = document.getElementById('file-graph-repository-url');
const submitButton = document.getElementById('file-graph-submit');
const status = document.getElementById('file-graph-status');
const results = document.getElementById('file-graph-results');
const repositoryName = document.getElementById('file-graph-repository-name');
const repositoryLink = document.getElementById('file-graph-repository-link');
const graphElement = document.getElementById('file-graph-canvas');
const maximumSourceFiles = 400;
const requestConcurrency = 8;
const sourceExtensions = new Map([
  ['.js', 'javascript'],
  ['.jsx', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.ts', 'javascript'],
  ['.tsx', 'javascript'],
  ['.mts', 'javascript'],
  ['.cts', 'javascript'],
  ['.py', 'python'],
  ['.go', 'go'],
  ['.rs', 'rust'],
]);
const ignoredDirectories = new Set([
  '.git',
  '.next',
  '.nuxt',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
  'venv',
]);
const languageColors = {
  javascript: '#78e5c0',
  python: '#ffd080',
  go: '#83d8ff',
  rust: '#c3a5ff',
};

let graph;
let graph2D;
let graph3D;
let graph2DElement;
let graph3DElement;
let graphDimension = '2d';
let graphDimensionRequest = 0;
let graph3DInitialization;
let fileGraph3DFitPending = false;
let fileGraph3DWasInteractedWith = false;
let currentNodes = [];
let currentLinks = [];
let activeRepositoryInfo;
let activeBranch;
let fitFrame = 0;
let fitTimeout;

for (const tab of tabs) {
  tab.addEventListener('click', () => {
    if (tab.id === 'file-graph-tab' && graph) {
      requestAnimationFrame(resizeGraph);
    }
  });
}

window.addEventListener('graph-dimension-change', async (event) => {
  const nextDimension = event.detail?.dimension === '3d' ? '3d' : '2d';
  const previousDimension = graphDimension;
  const request = ++graphDimensionRequest;
  graphDimension = nextDimension;
  if (graph) {
    try {
      await showFileGraphDimension(request);
    } catch (error) {
      if (request === graphDimensionRequest) {
        graphDimension = previousDimension;
      }
      status.textContent =
        error instanceof Error ? error.message : 'Could not switch graph dimensions.';
    }
  }
});

function getLanguage(path) {
  const basename = path.split('/').at(-1);
  const extension = basename.slice(basename.lastIndexOf('.')).toLocaleLowerCase();
  return sourceExtensions.get(extension);
}

function isIgnoredPath(path) {
  return path.split('/').some((part) => ignoredDirectories.has(part.toLocaleLowerCase()));
}

function normalizePath(path) {
  const parts = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join('/');
}

function getJavaScriptImports(source) {
  const imports = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:[^'";\n]*?\s+from\s*)?['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const [, specifier] of source.matchAll(pattern)) {
      imports.add(specifier);
    }
  }
  return [...imports];
}

function getPythonImports(source) {
  const imports = [];
  for (const line of source.split(/\r?\n/)) {
    const fromMatch = line.match(/^\s*from\s+([.\w]+)\s+import\s+(.+?)(?:\s+#.*)?$/);
    if (fromMatch) {
      imports.push({ kind: 'from', module: fromMatch[1], names: fromMatch[2] });
      continue;
    }
    const importMatch = line.match(/^\s*import\s+(.+?)(?:\s+#.*)?$/);
    if (importMatch) {
      for (const imported of importMatch[1].split(',')) {
        const module = imported.trim().split(/\s+as\s+/)[0];
        if (module) {
          imports.push({ kind: 'import', module });
        }
      }
    }
  }
  return imports;
}

function getGoImports(source) {
  const imports = [];
  const pattern = /\bimport\s*(?:\(\s*([\s\S]*?)\s*\)|"([^"]+)")/g;
  for (const [, block = '', single] of source.matchAll(pattern)) {
    if (single) {
      imports.push(single);
      continue;
    }
    for (const [, importPath] of block.matchAll(/"([^"]+)"/g)) {
      imports.push(importPath);
    }
  }
  return imports;
}

function getRustImports(source) {
  const imports = [];
  for (const [, moduleName] of source.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/gm)) {
    imports.push({ kind: 'mod', module: moduleName });
  }
  for (const [, usePath] of source.matchAll(/^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/gm)) {
    imports.push({ kind: 'use', module: usePath.trim() });
  }
  return imports;
}

function resolveJavaScriptImport(importer, specifier, filesByPath) {
  if (!specifier.startsWith('.')) {
    return [];
  }
  const base = normalizePath(`${importer.split('/').slice(0, -1).join('/')}/${specifier}`);
  const candidates = [
    base,
    ...['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'].map(
      (extension) => `${base}${extension}`
    ),
    ...['index.js', 'index.jsx', 'index.mjs', 'index.ts', 'index.tsx'].map(
      (filename) => `${base}/${filename}`
    ),
  ];
  return candidates
    .map((candidate) => filesByPath.get(candidate)?.path)
    .filter(Boolean);
}

function moduleFileCandidates(modulePath) {
  const base = modulePath.replaceAll('.', '/');
  return [`${base}.py`, `${base}/__init__.py`];
}

function resolvePythonImports(importer, imports, filesByPath) {
  const targets = new Set();
  const importerDirectory = importer.split('/').slice(0, -1);

  for (const item of imports) {
    const module = item.module;
    let modulePath;
    if (module.startsWith('.')) {
      const level = module.match(/^\.+/)[0].length;
      const rest = module.slice(level).replaceAll('.', '/');
      const parentDirectory = [...importerDirectory];
      const levelsUp = Math.max(0, level - 1);
      for (let index = 0; index < levelsUp; index += 1) {
        parentDirectory.pop();
      }
      modulePath = normalizePath([...parentDirectory, rest].filter(Boolean).join('/'));
    } else {
      modulePath = module.replaceAll('.', '/');
    }

    for (const candidate of moduleFileCandidates(modulePath)) {
      if (filesByPath.has(candidate)) {
        targets.add(candidate);
      }
    }

    if (item.kind === 'from') {
      for (const importedName of item.names.split(',')) {
        const name = importedName.trim().split(/\s+as\s+/)[0];
        if (!/^[A-Za-z_]\w*$/.test(name) || name === '*') {
          continue;
        }
        for (const candidate of moduleFileCandidates(normalizePath(`${modulePath}/${name}`))) {
          if (filesByPath.has(candidate)) {
            targets.add(candidate);
          }
        }
      }
    }
  }
  return [...targets];
}

function getDirectoryFiles(directory, filesByPath) {
  const prefix = directory ? `${directory}/` : '';
  return [...filesByPath.values()].filter(
    (file) =>
      file.language === 'go' &&
      file.path.startsWith(prefix) &&
      !file.path.slice(prefix.length).includes('/') &&
      !file.path.endsWith('_test.go')
  );
}

function resolveGoImports(importer, imports, modulePath, filesByPath) {
  const targets = new Set();
  for (const importPath of imports) {
    if (!modulePath || !importPath.startsWith(`${modulePath}/`)) {
      continue;
    }
    const directory = importPath.slice(modulePath.length + 1);
    for (const file of getDirectoryFiles(directory, filesByPath)) {
      if (file.path !== importer) {
        targets.add(file.path);
      }
    }
  }
  return [...targets];
}

function resolveRustModule(importer, module, filesByPath, moduleRoot) {
  const pathParts = importer.split('/');
  const filename = pathParts.at(-1);
  const currentDirectory =
    filename === 'mod.rs' || filename === 'lib.rs' || filename === 'main.rs'
      ? pathParts.slice(0, -1)
      : [...pathParts.slice(0, -1), filename.replace(/\.rs$/i, '')];
  const targetDirectory = normalizePath([...currentDirectory, module].join('/'));
  const candidates = [`${targetDirectory}.rs`, `${targetDirectory}/mod.rs`];
  if (!currentDirectory.length && moduleRoot) {
    candidates.push(`${moduleRoot}/${module}.rs`, `${moduleRoot}/${module}/mod.rs`);
  }
  return candidates.filter((candidate) => filesByPath.has(candidate));
}

function resolveRustUse(importer, usePath, filesByPath, moduleRoot) {
  const normalizedPath = usePath.replace(/^\(|\)$/g, '').replace(/\{.*$/, '').trim();
  const parts = normalizedPath.split('::').filter(Boolean);
  if (parts.length < 2 || !['crate', 'self', 'super'].includes(parts[0])) {
    return [];
  }
  let base;
  if (parts[0] === 'crate') {
    base = moduleRoot ? [moduleRoot] : [];
  } else {
    const filename = importer.split('/').at(-1);
    base =
      filename === 'mod.rs' || filename === 'lib.rs' || filename === 'main.rs'
        ? importer.split('/').slice(0, -1)
        : [...importer.split('/').slice(0, -1), filename.replace(/\.rs$/i, '')];
    if (parts[0] === 'super') {
      base.pop();
    }
  }
  const modules = parts.slice(1).filter((part) => /^[A-Za-z_]\w*$/.test(part));
  if (!modules.length) {
    return [];
  }
  const candidates = [];
  for (let length = modules.length; length > 0; length -= 1) {
    const modulePath = normalizePath([...base, ...modules.slice(0, length)].join('/'));
    candidates.push(`${modulePath}.rs`, `${modulePath}/mod.rs`);
    if (length === 1 && moduleRoot) {
      candidates.push(`${moduleRoot}/${modules[0]}.rs`, `${moduleRoot}/${modules[0]}/mod.rs`);
    }
  }
  return [...new Set(candidates.filter((candidate) => filesByPath.has(candidate)))];
}

function resolveImports(file, filesByPath, goModulePath, rustModuleRoot) {
  switch (file.language) {
    case 'javascript':
      return getJavaScriptImports(file.content).flatMap((specifier) =>
        resolveJavaScriptImport(file.path, specifier, filesByPath)
      );
    case 'python':
      return resolvePythonImports(file.path, getPythonImports(file.content), filesByPath);
    case 'go':
      return resolveGoImports(
        file.path,
        getGoImports(file.content),
        goModulePath,
        filesByPath
      );
    case 'rust':
      return getRustImports(file.content).flatMap((item) =>
        item.kind === 'mod'
          ? resolveRustModule(file.path, item.module, filesByPath, rustModuleRoot)
          : resolveRustUse(file.path, item.module, filesByPath, rustModuleRoot)
      );
    default:
      return [];
  }
}

async function fetchRawFile(owner, repository, branch, path) {
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  const filePath = path.split('/').map(encodeURIComponent).join('/');
  const url =
    `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/` +
    `${branchPath}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch ${path} (HTTP ${response.status}).`);
  }
  const content = await response.text();
  if (content.length > 1_000_000) {
    throw new Error(`${path} is too large to analyze.`);
  }
  return content.replace(/^\uFEFF/, '');
}

async function mapConcurrent(items, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(requestConcurrency, items.length) },
    async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { value: await callback(items[index]) };
        } catch (error) {
          results[index] = { error };
        }
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function getLanguageName(language) {
  return language === 'javascript' ? 'JavaScript / TypeScript' : language;
}

function getFileGraphData() {
  return {
    nodes: currentNodes.map((node) => ({ ...node })),
    links: currentLinks.map((link) => ({ ...link })),
  };
}

function createFileGraph2D(element) {
  return new ForceGraph2D(element)
    .nodeLabel((node) => node.path)
    .nodeCanvasObjectMode(() => 'replace')
    .nodeCanvasObject((node, context, globalScale) => {
      const fontSize = Math.max(5, 8 / globalScale);
      const color = languageColors[node.language];
      context.save();
      context.beginPath();
      context.arc(node.x, node.y, 2.5, 0, 2 * Math.PI);
      context.fillStyle = color;
      context.fill();
      context.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'bottom';
      context.lineJoin = 'round';
      context.lineWidth = 2 / globalScale;
      context.strokeStyle = '#0a1120';
      context.strokeText(node.label, node.x, node.y - 4 / globalScale);
      context.fillStyle = color;
      context.fillText(node.label, node.x, node.y - 4 / globalScale);
      context.restore();
    })
    .nodePointerAreaPaint((node, color, context, globalScale) => {
      const fontSize = Math.max(5, 8 / globalScale);
      context.font = `${fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'bottom';
      context.fillStyle = color;
      const textWidth = context.measureText(node.label).width;
      context.fillRect(
        node.x - textWidth / 2 - 5 / globalScale,
        node.y - 4 / globalScale - fontSize - 5 / globalScale,
        textWidth + 10 / globalScale,
        fontSize + 10 / globalScale
      );
    })
    .nodeColor((node) => languageColors[node.language])
    .linkColor(() => '#7286a6')
    .linkWidth(1)
    .linkDirectionalArrowLength(4)
    .linkDirectionalArrowRelPos(1)
    .backgroundColor('#0a1120')
    .cooldownTicks(240)
    .onEngineStop(() => {
      if (graphDimension === '2d') {
        scheduleGraphFit(450);
      }
    })
    .onNodeClick(openFileFromGraph)
    .graphData({ nodes: [], links: [] });
}

async function createFileGraph3D(element) {
  const [{ default: ForceGraph3D }, { default: SpriteText }, THREE] = await Promise.all([
    import('3d-force-graph'),
    import('three-spritetext'),
    import('three'),
  ]);
  const graphInstance = new ForceGraph3D(element, { controlType: 'orbit' })
    .nodeLabel((node) => node.path)
    .showNavInfo(false)
    .nodeColor((node) => languageColors[node.language])
    .nodeThreeObject((node) => {
      const group = new THREE.Group();
      const sphere = new THREE.Mesh(
        new THREE.SphereGeometry(2.5, 16, 12),
        new THREE.MeshBasicMaterial({ color: languageColors[node.language] })
      );
      const label = new SpriteText(node.label, 2.4, languageColors[node.language]);
      label.fontFace = 'Inter, ui-sans-serif, system-ui, sans-serif';
      label.fontSize = 64;
      label.strokeWidth = 0.25;
      label.strokeColor = '#0a1120';
      group.add(sphere, label);
      return group;
    })
    .nodeThreeObjectExtend(false)
    .linkColor(() => '#7286a6')
    .linkOpacity(0.75)
    .linkWidth(0.5)
    .linkDirectionalArrowLength(2.5)
    .linkDirectionalArrowRelPos(1)
    .backgroundColor('#0a1120')
    .enableNodeDrag(false)
    .enableNavigationControls(true)
    .cooldownTicks(240)
    .onEngineStop(() => {
      if (graphDimension === '3d' && fileGraph3DFitPending) {
        scheduleGraphFit(450);
      }
    })
    .onNodeClick(openFileFromGraph)
    .graphData({ nodes: [], links: [] });
  graphInstance.controls().addEventListener('start', () => {
    fileGraph3DWasInteractedWith = true;
    fileGraph3DFitPending = false;
    window.clearTimeout(fitTimeout);
    cancelAnimationFrame(fitFrame);
  });
  return graphInstance;
}

function openFileFromGraph(node) {
  const path = node.path.split('/').map(encodeURIComponent).join('/');
  const branchPath = activeBranch.split('/').map(encodeURIComponent).join('/');
  window.open(
    `${activeRepositoryInfo.html_url}/blob/${branchPath}/${path}`,
    '_blank',
    'noopener,noreferrer'
  );
}

async function showFileGraphDimension(request = ++graphDimensionRequest) {
  if (graphDimension === '3d') {
    if (!graph3D && !graph3DInitialization) {
      graph3DElement = document.createElement('div');
      graph3DElement.className = 'graph-renderer';
      graph3DElement.hidden = true;
      graphElement.append(graph3DElement);
      graph3DInitialization = createFileGraph3D(graph3DElement)
        .then((nextGraph) => {
          nextGraph.graphData(getFileGraphData());
          graph3D = nextGraph;
        })
        .catch((error) => {
          graph3DElement.remove();
          graph3DElement = undefined;
          graph3DInitialization = undefined;
          throw error;
        });
    }
    if (graph3DInitialization) {
      await graph3DInitialization;
    }
    if (request !== graphDimensionRequest) {
      return;
    }
    graph2D?.pauseAnimation();
    if (graph2DElement) {
      graph2DElement.hidden = true;
    }
    graph3DElement.hidden = false;
    graph = graph3D;
  } else {
    graph3D?.pauseAnimation();
    if (graph3DElement) {
      graph3DElement.hidden = true;
    }
    graph2DElement.hidden = false;
    graph = graph2D;
  }

  graph
    .width(graphElement.clientWidth)
    .height(graphElement.clientHeight)
    .resumeAnimation();
  if (graphDimension === '3d') {
    graph3D.enableNavigationControls(true);
  }
  if (graphDimension === '3d' && fileGraph3DFitPending) {
    scheduleGraphFit(450);
  }
}

async function createFileGraph(nodes, links) {
  currentNodes = nodes;
  currentLinks = links;
  fileGraph3DFitPending = true;
  fileGraph3DWasInteractedWith = false;
  if (!graph2D) {
    graph2DElement = document.createElement('div');
    graph2DElement.className = 'graph-renderer';
    graph2DElement.hidden = true;
    graphElement.append(graph2DElement);
    graph2D = createFileGraph2D(graph2DElement);
  }
  graph2D.graphData(getFileGraphData());
  if (graph3D) {
    graph3D.graphData(getFileGraphData());
  }
  await showFileGraphDimension();
  if (graphDimension === '2d') {
    scheduleGraphFit(500);
  }
}

function scheduleGraphFit(duration = 250) {
  window.clearTimeout(fitTimeout);
  cancelAnimationFrame(fitFrame);
  fitTimeout = window.setTimeout(() => {
    fitFrame = requestAnimationFrame(() => {
      fitFrame = requestAnimationFrame(() => {
        if (
          graph &&
          graphElement.clientWidth > 0 &&
          graphElement.clientHeight > 0 &&
          !(graphDimension === '3d' && fileGraph3DWasInteractedWith)
        ) {
          graph.zoomToFit(duration, 48);
          if (graphDimension === '3d') {
            fileGraph3DFitPending = false;
          }
        }
      });
    });
  }, 650);
}

function resizeGraph() {
  if (!graph || graphElement.clientWidth === 0 || graphElement.clientHeight === 0) {
    return;
  }
  graph.width(graphElement.clientWidth).height(graphElement.clientHeight);
  if (graphDimension === '2d') {
    scheduleGraphFit();
  }
}

async function buildFileGraph(value) {
  const { owner, repository } = parseRepositoryUrl(value);
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  status.textContent = 'Fetching repository file tree…';
  const repositoryInfo = await fetchGitHubJson(apiBase, 'Repository');
  if (!repositoryInfo.default_branch) {
    throw new Error('GitHub did not provide a default branch for this repository.');
  }

  const treeUrl =
    `${apiBase}/git/trees/${encodeURIComponent(repositoryInfo.default_branch)}?recursive=1`;
  const tree = await fetchGitHubJson(treeUrl, 'Repository file tree');
  const sourcePaths = (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob' && !isIgnoredPath(entry.path) && getLanguage(entry.path))
    .map((entry) => entry.path)
    .sort((left, right) => left.localeCompare(right));
  const selectedPaths = sourcePaths.slice(0, maximumSourceFiles);
  if (selectedPaths.length === 0) {
    throw new Error('No JavaScript, TypeScript, Python, Go, or Rust source files were found.');
  }

  status.textContent = `Reading ${selectedPaths.length} source files…`;
  const fileResults = await mapConcurrent(selectedPaths, async (path) => ({
    path,
    language: getLanguage(path),
    content: await fetchRawFile(owner, repository, repositoryInfo.default_branch, path),
  }));
  const files = [];
  const fileFailures = [];
  for (const result of fileResults) {
    if (result.error) {
      fileFailures.push(result.error.message);
    } else {
      files.push(result.value);
    }
  }
  if (files.length === 0) {
    throw new Error(`Could not read any source files. ${fileFailures.slice(0, 3).join(' ')}`);
  }

  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const goModuleFile = tree.tree?.find(
    (entry) => entry.type === 'blob' && entry.path.toLocaleLowerCase() === 'go.mod'
  );
  let goModulePath;
  if (goModuleFile) {
    try {
      const goModule = await fetchRawFile(
        owner,
        repository,
        repositoryInfo.default_branch,
        goModuleFile.path
      );
      goModulePath = goModule.match(/^\s*module\s+(\S+)/m)?.[1];
    } catch (error) {
      fileFailures.push(error.message);
    }
  }

  const rustRoot = filesByPath.has('src/lib.rs') || filesByPath.has('src/main.rs') ? 'src' : '';
  const linksByPair = new Map();
  for (const file of files) {
    for (const targetPath of new Set(
      resolveImports(file, filesByPath, goModulePath, rustRoot)
    )) {
      if (targetPath === file.path) {
        continue;
      }
      const pair = `${file.path}\0${targetPath}`;
      linksByPair.set(pair, { source: file.path, target: targetPath });
    }
  }

  const nodes = files.map((file) => ({
    id: file.path,
    path: file.path,
    label: file.path,
    language: file.language,
  }));
  const links = [...linksByPair.values()];
  results.hidden = false;
  activeRepositoryInfo = repositoryInfo;
  activeBranch = repositoryInfo.default_branch;
  repositoryName.textContent = repositoryInfo.full_name;
  repositoryLink.href = repositoryInfo.html_url;
  await createFileGraph(nodes, links);

  const notices = [];
  if (sourcePaths.length > maximumSourceFiles) {
    notices.push(`Only the first ${maximumSourceFiles} of ${sourcePaths.length} source files were analyzed.`);
  }
  if (tree.truncated) {
    notices.push('GitHub truncated the file listing; some files may be missing.');
  }
  if (fileFailures.length) {
    notices.push(`${fileFailures.length} source file${fileFailures.length === 1 ? '' : 's'} could not be read.`);
  }
  const languageCount = new Set(files.map((file) => file.language)).size;
  status.textContent =
    `Mapped ${files.length} files and ${links.length} in-repository import${links.length === 1 ? '' : 's'} across ` +
    `${languageCount} language${languageCount === 1 ? '' : 's'}.` +
    (notices.length ? ` ${notices.join(' ')}` : '');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  submitButton.disabled = true;
  status.textContent = '';
  results.hidden = true;

  try {
    await buildFileGraph(repositoryUrlInput.value.trim());
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : 'Could not build a file dependency graph.';
  } finally {
    submitButton.disabled = false;
  }
});

new ResizeObserver(resizeGraph).observe(graphElement);
window.addEventListener('resize', resizeGraph);

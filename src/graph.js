import ForceGraph2D from 'force-graph';
import { summarizeReadme } from '../embeddings/gemini.js';
import { fetchGitHubJson, parseRepositoryUrl } from './github.js';
import './style.css';

const graphElement = document.getElementById('graph');
const graphInteractionHelp = document.getElementById('graph-interaction-help');
const settingsForm = document.getElementById('graph-settings-form');
const readmeEmbeddingModeInputs = document.querySelectorAll('input[name="readmeEmbeddingMode"]');
const geminiApiKeySetting = document.getElementById('gemini-api-key-setting');
const geminiApiKeyInput = document.getElementById('gemini-api-key');
const nodeLimitInput = document.getElementById('node-limit');
const nodeLimitNumberInput = document.getElementById('node-limit-number');
const neighborLimitInput = document.getElementById('neighbor-limit');
const linkOpacityInput = document.getElementById('link-opacity');
const linkOpacityValue = document.getElementById('link-opacity-value');
const textOpacityInput = document.getElementById('text-opacity');
const textOpacityValue = document.getElementById('text-opacity-value');
const settingsStatus = document.getElementById('settings-status');
const neighborhoodHighlightingInput = document.getElementById('neighborhood-highlighting');
const graphDimensionInputs = document.querySelectorAll('input[name="graphDimension"]');
const searchForm = document.getElementById('repo-search-form');
const searchInput = document.getElementById('repo-search');
const searchStatus = document.getElementById('repo-search-status');
const repositoryOptions = document.getElementById('repository-options');
const repositoryLinksPanel = document.getElementById('repository-links-panel');
const repositoryLinksList = document.getElementById('repository-links-list');
const addRepositoryForm = document.getElementById('add-repository-form');
const repositoryUrlInput = document.getElementById('repository-url');
const addRepositoryButton = document.getElementById('add-repository-button');
const addRepositoryStatus = document.getElementById('add-repository-status');
const customReadmeForm = document.getElementById('custom-readme-form');
const customRepositoryTitleInput = document.getElementById('custom-repository-title');
const readmeSourceInputs = document.querySelectorAll('input[name="readmeSource"]');
const readmeTextSource = document.getElementById('readme-text-source');
const customReadmeTextInput = document.getElementById('custom-readme-text');
const readmeFileSource = document.getElementById('readme-file-source');
const customReadmeFileInput = document.getElementById('custom-readme-file');
const customReadmeButton = document.getElementById('custom-readme-button');
const customReadmeStatus = document.getElementById('custom-readme-status');

let selectedNode;
let displayedNodes = [];
let displayedLinks = [];
let displayedNeighborsByNode = new Map();
let hoveredNodeId;
let selectedFirstOrderNeighborIds = new Set();
let selectedSecondOrderNeighborIds = new Set();
let firstOrderNeighborIds = new Set();
let secondOrderNeighborIds = new Set();
let neighborhoodHighlightingEnabled = neighborhoodHighlightingInput.checked;
let repositoryNodes = [];
let originalRepositoryCount = 0;
let userRepositories = [];
let displayedRepositoryNodes = [];
let activeReadmeEmbeddingMode = 'original';
let graph;
let graph2D;
let graph3D;
let graph2DElement;
let graph3DElement;
let graphDimension = '2d';
let graphDimensionRequest = 0;
let graph3DInitialization;
let repositoryGraph3DHasFit = false;
let repositoryGraph3DWasInteractedWith = false;
let repositoryNodeLabels = new Map();

window.addEventListener('beforeunload', (event) => {
  if (userRepositories.length > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function canonicalId(fullName) {
  return fullName.toLocaleLowerCase('en-US');
}

async function embedReadme(readmeText, mode, onStatus, existingSummary) {
  let textToEmbed = readmeText;
  let summary = existingSummary;

  if (mode === 'gemini-summary') {
    if (!summary) {
      const apiKey = geminiApiKeyInput.value.trim();
      if (!apiKey) {
        throw new Error('Enter a Gemini API key in the Repository Comparison Mode settings.');
      }
      onStatus('Summarizing README with Gemini…');
      summary = await summarizeReadme(readmeText, apiKey);
    }
    textToEmbed = summary;
  }

  onStatus('Embedding README. The model may need to download first…');
  const { embedText } = await import('../embeddings/word2vec.js');
  return { vector: await embedText(textToEmbed), summary };
}

function prepareNode(node, dimensions) {
  if (
    !node.id ||
    !node.name ||
    !node.fullName ||
    typeof node.url !== 'string' ||
    !Array.isArray(node.vector) ||
    node.vector.length !== dimensions ||
    !node.vector.every(Number.isFinite)
  ) {
    throw new Error(`Invalid repository embedding data for ${node.fullName ?? node.id ?? 'a repository'}.`);
  }

  const vector = Float32Array.from(node.vector);
  let squaredNorm = 0;
  for (const value of vector) {
    squaredNorm += value * value;
  }
  const norm = Math.sqrt(squaredNorm);
  if (norm === 0) {
    throw new Error(`Repository embedding for ${node.fullName} is a zero vector.`);
  }
  for (let index = 0; index < vector.length; index += 1) {
    vector[index] /= norm;
  }

  return { ...node, vector };
}

function getNodeFontSize(globalScale) {
  return Math.max(5, 8 / globalScale);
}

function getRepositoryNodeColor(node) {
  if (node.id === selectedNode?.id) {
    return '#f2f7ff';
  }
  if (node.id === hoveredNodeId) {
    return '#78e5c0';
  }
  if (neighborhoodHighlightingEnabled && firstOrderNeighborIds.has(node.id)) {
    return '#ffd080';
  }
  if (neighborhoodHighlightingEnabled && secondOrderNeighborIds.has(node.id)) {
    return '#c3a5ff';
  }
  return node.isUserProvided ? '#f28fb9' : '#91a4bf';
}

function getRepositoryNodeLabelColor(node) {
  const color = getRepositoryNodeColor(node).slice(1);
  return `#${[0, 2, 4]
    .map((offset) => {
      const channel = Number.parseInt(color.slice(offset, offset + 2), 16);
      return Math.round(channel + (255 - channel) * 0.35)
        .toString(16)
        .padStart(2, '0');
    })
    .join('')}`;
}

function isUnrelatedNode(node) {
  return (
    neighborhoodHighlightingEnabled &&
    (hoveredNodeId || selectedNode?.id) &&
    node.id !== selectedNode?.id &&
    node.id !== hoveredNodeId &&
    !firstOrderNeighborIds.has(node.id) &&
    !secondOrderNeighborIds.has(node.id)
  );
}

function getRepositoryNodeLabelOpacity(node) {
  const opacity = Number(textOpacityInput.value) / 100;
  return opacity * (isUnrelatedNode(node) ? 0.2 : 1);
}

function getRepositoryLinkColor(link) {
  const opacity = Number(linkOpacityInput.value) / 100;
  const sourceId = getGraphEndpointId(link.source);
  const targetId = getGraphEndpointId(link.target);
  if (neighborhoodHighlightingEnabled && (hoveredNodeId || selectedNode?.id)) {
    const isFirstOrderLink =
      sourceId === hoveredNodeId ||
      targetId === hoveredNodeId ||
      sourceId === selectedNode?.id ||
      targetId === selectedNode?.id;
    const isSecondOrderLink =
      (firstOrderNeighborIds.has(sourceId) && secondOrderNeighborIds.has(targetId)) ||
      (firstOrderNeighborIds.has(targetId) && secondOrderNeighborIds.has(sourceId));
    const highlightOpacity = Math.min(1, opacity * 2.4);
    if (isFirstOrderLink) {
      return `rgba(255, 208, 128, ${highlightOpacity})`;
    }
    if (isSecondOrderLink) {
      return `rgba(195, 165, 255, ${highlightOpacity})`;
    }
    return `rgba(82, 101, 130, ${Math.min(opacity, 0.08)})`;
  }
  return `rgba(82, 101, 130, ${opacity})`;
}

function refreshGraphStyle() {
  if (graph2D && graphDimension === '2d') {
    graph2D.zoom(graph2D.zoom());
  }
  if (graph3D) {
    for (const node of graph3D.graphData().nodes) {
      const label = repositoryNodeLabels.get(node.id);
      if (!label) {
        continue;
      }

      const color = getRepositoryNodeLabelColor(node);
      const fontWeight =
        node.id === selectedNode?.id || node.id === hoveredNodeId ? 'bold' : 'normal';
      const opacity = getRepositoryNodeLabelOpacity(node);

      if (label.color !== color) {
        label.color = color;
      }
      if (label.fontWeight !== fontWeight) {
        label.fontWeight = fontWeight;
      }
      if (label.material.opacity !== opacity) {
        label.material.opacity = opacity;
      }
    }
    graph3D.nodeColor(getRepositoryNodeColor);
    graph3D.linkColor(getRepositoryLinkColor);
  }
}

function updateNeighborhood(node) {
  hoveredNodeId = node?.id;
  const hoveredFirstOrderNeighborIds = node
    ? new Set(displayedNeighborsByNode.get(node.id) ?? [])
    : new Set();
  const hoveredSecondOrderNeighborIds = new Set();

  if (node) {
    for (const neighborId of hoveredFirstOrderNeighborIds) {
      for (const secondNeighborId of displayedNeighborsByNode.get(neighborId) ?? []) {
        if (
          secondNeighborId !== node.id &&
          !hoveredFirstOrderNeighborIds.has(secondNeighborId)
        ) {
          hoveredSecondOrderNeighborIds.add(secondNeighborId);
        }
      }
    }
  }

  firstOrderNeighborIds = new Set([
    ...selectedFirstOrderNeighborIds,
    ...hoveredFirstOrderNeighborIds,
  ]);
  secondOrderNeighborIds = new Set([
    ...selectedSecondOrderNeighborIds,
    ...hoveredSecondOrderNeighborIds,
  ]);
  refreshGraphStyle();
}

function getGraphEndpointId(endpoint) {
  return typeof endpoint === 'object' ? endpoint.id : endpoint;
}

function clearRepositoryLinks() {
  repositoryLinksList.replaceChildren();
  repositoryLinksPanel.hidden = true;
}

function findRepository(query, nodes) {
  const normalizedQuery = query.toLocaleLowerCase();
  return nodes.find(
    ({ name, fullName }) =>
      name.toLocaleLowerCase() === normalizedQuery ||
      fullName.toLocaleLowerCase() === normalizedQuery
  ) ?? nodes.find(
    ({ name, fullName }) =>
      name.toLocaleLowerCase().includes(normalizedQuery) ||
      fullName.toLocaleLowerCase().includes(normalizedQuery)
  );
}

function showRepository(node) {
  const graphNode = graph.graphData().nodes.find(({ id }) => id === node.id);
  if (!graphNode) {
    searchStatus.textContent = 'Repository is not displayed. Increase the repository count and try again.';
    return;
  }

  selectedNode = graphNode;
  selectedFirstOrderNeighborIds = new Set(
    displayedNeighborsByNode.get(graphNode.id) ?? []
  );
  selectedSecondOrderNeighborIds = new Set();
  for (const neighborId of selectedFirstOrderNeighborIds) {
    for (const secondNeighborId of displayedNeighborsByNode.get(neighborId) ?? []) {
      if (
        secondNeighborId !== graphNode.id &&
        !selectedFirstOrderNeighborIds.has(secondNeighborId)
      ) {
        selectedSecondOrderNeighborIds.add(secondNeighborId);
      }
    }
  }
  updateNeighborhood(
    hoveredNodeId
      ? graph.graphData().nodes.find(({ id }) => id === hoveredNodeId)
      : undefined
  );
  searchStatus.textContent = `Showing ${node.fullName}.`;
  const linkedRepositories = displayedLinks
    .filter((link) => link.source === node.id || link.target === node.id)
    .map((link) => {
      const linkedId = link.source === node.id ? link.target : link.source;
      return {
        repository: displayedNodes.find(({ id }) => id === linkedId),
        similarity: link.similarity,
      };
    })
    .filter(({ repository }) => repository)
    .sort((a, b) => b.similarity - a.similarity);

  repositoryLinksList.replaceChildren();
  for (const { repository, similarity } of linkedRepositories) {
    const item = document.createElement('li');
    const repositoryLabel = repository.url
      ? document.createElement('a')
      : document.createElement('span');
    repositoryLabel.textContent = repository.fullName;
    if (repository.url) {
      repositoryLabel.href = repository.url;
      repositoryLabel.target = '_blank';
      repositoryLabel.rel = 'noopener noreferrer';
    }

    const score = document.createElement('span');
    score.textContent = ` ${(similarity * 100).toFixed(1)}%`;
    item.append(repositoryLabel, score);
    repositoryLinksList.append(item);
  }
  repositoryLinksPanel.hidden = false;

  if (
    graphDimension === '3d' &&
    Number.isFinite(graphNode.x) &&
    Number.isFinite(graphNode.y) &&
    Number.isFinite(graphNode.z)
  ) {
    graph.cameraPosition(
      { x: graphNode.x, y: graphNode.y, z: graphNode.z + 60 },
      { x: graphNode.x, y: graphNode.y, z: graphNode.z },
      500
    );
  } else if (Number.isFinite(graphNode.x) && Number.isFinite(graphNode.y)) {
    graph.centerAt(graphNode.x, graphNode.y, 500).zoom(Math.max(graph.zoom(), 3), 500);
  } else {
    graph.zoomToFit(500, 40);
  }
}

function compareNeighbors(left, right) {
  return right.similarity - left.similarity || left.id.localeCompare(right.id);
}

function insertNeighbor(neighbors, candidate, limit) {
  let low = 0;
  let high = neighbors.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareNeighbors(candidate, neighbors[middle]) < 0) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  if (low >= limit) {
    return;
  }
  neighbors.splice(low, 0, candidate);
  if (neighbors.length > limit) {
    neighbors.pop();
  }
}

function getNearestNeighborLinks(nodes, neighborLimit) {
  if (neighborLimit === 0) {
    return [];
  }

  const neighborsByNode = nodes.map(() => []);
  for (let sourceIndex = 0; sourceIndex < nodes.length; sourceIndex += 1) {
    const source = nodes[sourceIndex];
    for (let targetIndex = sourceIndex + 1; targetIndex < nodes.length; targetIndex += 1) {
      const target = nodes[targetIndex];
      let similarity = 0;
      for (let dimension = 0; dimension < source.vector.length; dimension += 1) {
        similarity += source.vector[dimension] * target.vector[dimension];
      }

      const link = { source: source.id, target: target.id, similarity };
      insertNeighbor(neighborsByNode[sourceIndex], { id: target.id, similarity, link }, neighborLimit);
      insertNeighbor(neighborsByNode[targetIndex], { id: source.id, similarity, link }, neighborLimit);
    }
  }

  const selectedLinks = new Map();
  for (const neighbors of neighborsByNode) {
    for (const { link } of neighbors) {
      const pair = [link.source, link.target].sort((a, b) => a.localeCompare(b)).join('\0');
      selectedLinks.set(pair, link);
    }
  }
  return [...selectedLinks.values()];
}

function getDisplayedGraphData() {
  return {
    nodes: displayedNodes.map(({ id, name, fullName, url, isUserProvided }) => ({
      id,
      name,
      fullName,
      url,
      isUserProvided,
    })),
    links: displayedLinks.map((link) => ({ ...link })),
  };
}

function applyGraphSettings() {
  const nodeLimit = Number(nodeLimitInput.value);
  const neighborLimit = Number(neighborLimitInput.value);
  const maximumNodes = displayedRepositoryNodes.length;
  const maximumAllowedLinksPerNode =
    Number.isInteger(nodeLimit) && nodeLimit >= 1 && nodeLimit <= maximumNodes
      ? nodeLimit - 1
      : maximumNodes - 1;

  if (
    !Number.isInteger(nodeLimit) ||
    nodeLimit < 1 ||
    nodeLimit > maximumNodes ||
    !Number.isInteger(neighborLimit) ||
    neighborLimit < 0 ||
    neighborLimit > maximumAllowedLinksPerNode
  ) {
    throw new Error(
      `Choose 1-${maximumNodes} repositories and 0-${maximumAllowedLinksPerNode} nearest neighbors.`
    );
  }

  displayedNodes = displayedRepositoryNodes.slice(0, nodeLimit);
  displayedLinks = getNearestNeighborLinks(displayedNodes, neighborLimit);
  displayedNeighborsByNode = new Map(displayedNodes.map(({ id }) => [id, new Set()]));
  for (const link of displayedLinks) {
    displayedNeighborsByNode.get(link.source).add(link.target);
    displayedNeighborsByNode.get(link.target).add(link.source);
  }

  graph2D.graphData(getDisplayedGraphData());
  repositoryNodeLabels.clear();
  if (graph3D) {
    graph3D.graphData(getDisplayedGraphData());
  }
  selectedNode = undefined;
  hoveredNodeId = undefined;
  selectedFirstOrderNeighborIds = new Set();
  selectedSecondOrderNeighborIds = new Set();
  firstOrderNeighborIds = new Set();
  secondOrderNeighborIds = new Set();
  clearRepositoryLinks();

  settingsStatus.textContent =
    `Showing ${displayedNodes.length} repositories with up to ${neighborLimit} nearest neighbors each (${displayedLinks.length} links).`;
  searchStatus.textContent = '';
  repositoryOptions.replaceChildren();
  for (const node of displayedNodes) {
    const option = document.createElement('option');
    option.value = node.fullName;
    repositoryOptions.append(option);
  }

  if (graphDimension === '2d') {
    setTimeout(() => graph.zoomToFit(500, 40), 300);
  }
}

function updateNodeLimitRange() {
  nodeLimitInput.max = String(displayedRepositoryNodes.length);
  nodeLimitNumberInput.max = String(displayedRepositoryNodes.length);
  nodeLimitNumberInput.value = nodeLimitInput.value;
  const maximumNeighbors = Math.max(0, Number(nodeLimitInput.value) - 1);
  neighborLimitInput.max = String(maximumNeighbors);
  if (Number(neighborLimitInput.value) > maximumNeighbors) {
    neighborLimitInput.value = String(maximumNeighbors);
  }
}

async function loadRepositoryNodes(mode) {
  const fileName = mode === 'gemini-summary'
    ? 'repository-summary-embeddings.json'
    : 'repository-embeddings.json';
  const response = await fetch(`${import.meta.env.BASE_URL}${fileName}`);
  if (!response.ok) {
    if (mode === 'gemini-summary' && response.status === 404) {
      throw new Error(
        'The Gemini summary dataset has not been built yet. Run npm run build:summary-vectors ' +
        'with GEMINI_API_KEY set, then npm run build:summary-graph.'
      );
    }
    throw new Error(`Could not load ${fileName} (HTTP ${response.status}).`);
  }
  let data;
  try {
    data = await response.json();
  } catch {
    if (mode === 'gemini-summary') {
      throw new Error(
        'The Gemini summary dataset has not been built yet. Run npm run build:summary-vectors ' +
        'with GEMINI_API_KEY set, then npm run build:summary-graph.'
      );
    }
    throw new Error(`${fileName} is not valid JSON.`);
  }
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
    throw new Error(`${fileName} does not contain any repositories.`);
  }

  const dimensions = data.nodes[0].vector?.length;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error(`${fileName} contains an invalid vector.`);
  }
  const knownIds = new Set();
  const nodes = data.nodes.map((node) => {
    const preparedNode = prepareNode(node, dimensions);
    const id = canonicalId(preparedNode.fullName);
    if (knownIds.has(id)) {
      throw new Error(`Duplicate repository in ${fileName}: ${preparedNode.fullName}.`);
    }
    knownIds.add(id);
    return preparedNode;
  });

  return nodes;
}

async function getRepositoryReadme(owner, repository) {
  const apiPath = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  const repositoryInfo = await fetchGitHubJson(apiPath, 'Repository');
  const readme = await fetchGitHubJson(`${apiPath}/readme`, 'README');
  if (readme.encoding !== 'base64' || !readme.content) {
    throw new Error('GitHub did not provide readable README content for this repository.');
  }

  let readmeText;
  try {
    const bytes = Uint8Array.from(atob(readme.content.replace(/\s/g, '')), (character) =>
      character.charCodeAt(0)
    );
    readmeText = new TextDecoder().decode(bytes);
  } catch {
    throw new Error('Could not decode the README returned by GitHub.');
  }
  if (!readmeText.trim()) {
    throw new Error('This repository has an empty README.');
  }
  return { repositoryInfo, readmeText };
}

function focusExistingRepository(node, totalIndex) {
  const requiredCount = totalIndex + 1;
  nodeLimitInput.value = String(Math.max(Number(nodeLimitInput.value), requiredCount));
  updateNodeLimitRange();
  applyGraphSettings();
  searchInput.value = node.fullName;
  showRepository(node);
}

function createRepositoryGraph2D(element) {
  return new ForceGraph2D(element)
    .width(graphElement.clientWidth)
    .height(graphElement.clientHeight)
    .nodeLabel(() => '')
    .nodeCanvasObjectMode(() => 'replace')
    .nodeCanvasObject((node, context, globalScale) => {
      const fontSize = getNodeFontSize(globalScale);
      const fillStyle = getRepositoryNodeColor(node);
      const isHighlighted =
        node.id === selectedNode?.id ||
        node.id === hoveredNodeId ||
        (neighborhoodHighlightingEnabled &&
          (firstOrderNeighborIds.has(node.id) || secondOrderNeighborIds.has(node.id)));
      context.save();
      context.globalAlpha = getRepositoryNodeLabelOpacity(node);
      context.font = `${isHighlighted ? '700 ' : ''}${fontSize}px ui-sans-serif, system-ui, sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = fillStyle;
      context.lineJoin = 'round';
      context.lineWidth = (isHighlighted ? 3 : 2) / globalScale;
      context.strokeStyle = '#0a1120';
      context.strokeText(node.name, node.x, node.y);
      context.fillText(node.name, node.x, node.y);
      context.restore();
    })
    .nodePointerAreaPaint((node, color, context, globalScale) => {
      const fontSize = getNodeFontSize(globalScale);
      const padding = 8 / globalScale;
      context.font = `${fontSize}px sans-serif`;
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      context.fillStyle = color;
      const textWidth = context.measureText(node.name).width;
      context.fillRect(
        node.x - textWidth / 2 - padding,
        node.y - fontSize / 2 - padding,
        textWidth + padding * 2,
        fontSize + padding * 2
      );
    })
    .backgroundColor('#0a1120')
    .linkColor(getRepositoryLinkColor)
    .linkWidth((link) => Math.max(0.35, 0.35 + 1.15 * link.similarity))
    .onNodeHover(updateNeighborhood)
    .onNodeClick((node) => {
      if (node.url) {
        window.open(node.url, '_blank', 'noopener,noreferrer');
      }
    })
    .graphData({ nodes: [], links: [] });
}

function fitRepositoryGraph3D() {
  if (
    !graph3D ||
    graphDimension !== '3d' ||
    repositoryGraph3DHasFit ||
    repositoryGraph3DWasInteractedWith
  ) {
    return;
  }
  graph3D.zoomToFit(0, 10);
  const cameraPosition = graph3D.cameraPosition();
  const target = graph3D.controls().target;
  const zoomFactor = 0.65;
  graph3D.cameraPosition(
    {
      x: target.x + (cameraPosition.x - target.x) * zoomFactor,
      y: target.y + (cameraPosition.y - target.y) * zoomFactor,
      z: target.z + (cameraPosition.z - target.z) * zoomFactor,
    },
    { x: target.x, y: target.y, z: target.z }
  );
  repositoryGraph3DHasFit = true;
}

async function createRepositoryGraph3D(element) {
  const [{ default: ForceGraph3D }, { default: SpriteText }] = await Promise.all([
    import('3d-force-graph'),
    import('three-spritetext'),
  ]);
  const graphInstance = new ForceGraph3D(element, { controlType: 'orbit' })
    .width(graphElement.clientWidth)
    .height(graphElement.clientHeight)
    .showNavInfo(false)
    .backgroundColor('#0a1120')
    .nodeLabel(() => '')
    .nodeColor(getRepositoryNodeColor)
    .nodeThreeObject((node) => {
      const label = new SpriteText(node.name, 3.5, getRepositoryNodeLabelColor(node));
      label.fontFace = 'Inter, ui-sans-serif, system-ui, sans-serif';
      label.fontSize = 100;
      label.fontWeight = 'normal';
      label.strokeWidth = 0.3;
      label.strokeColor = '#0a1120';
      label.material.transparent = true;
      label.material.opacity = getRepositoryNodeLabelOpacity(node);
      repositoryNodeLabels.set(node.id, label);
      return label;
    })
    .linkColor(getRepositoryLinkColor)
    .linkOpacity(1)
    .linkWidth((link) => 1.15 * link.similarity)//Math.max(0.2, 0.4 + 1.15 * link.similarity))
    .enableNodeDrag(false)
    .enableNavigationControls(true)
    .cooldownTicks(300)
    .onEngineStop(fitRepositoryGraph3D)
    .onNodeHover(updateNeighborhood)
    .onNodeClick((node) => {
      if (node.url) {
        window.open(node.url, '_blank', 'noopener,noreferrer');
      }
    })
    .graphData({ nodes: [], links: [] });
  graphInstance.controls().addEventListener('start', () => {
    repositoryGraph3DWasInteractedWith = true;
  });
  return graphInstance;
}

async function setGraphDimension(dimension, broadcast = true) {
  const request = ++graphDimensionRequest;
  const nextDimension = dimension === '3d' ? '3d' : '2d';
  if (nextDimension === '3d') {
    if (!graph3D && !graph3DInitialization) {
      graph3DElement = document.createElement('div');
      graph3DElement.className = 'graph-renderer';
      graph3DElement.hidden = true;
      graphElement.append(graph3DElement);
      graph3DInitialization = createRepositoryGraph3D(graph3DElement)
        .then((nextGraph) => {
          nextGraph.graphData(getDisplayedGraphData());
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
  }

  graphDimension = nextDimension;
  graphInteractionHelp.textContent =
    graphDimension === '3d'
      ? 'Left-drag to rotate · Scroll to zoom · Right-drag to pan'
      : 'Hover a node to trace nearby ideas · Scroll to zoom · Drag to explore';
  for (const input of graphDimensionInputs) {
    input.checked = input.value === graphDimension;
  }

  if (graphDimension === '3d') {
    graph2D.pauseAnimation();
    graph2DElement.hidden = true;
    graph3DElement.hidden = false;
    graph = graph3D;
    graph3D
      .width(graphElement.clientWidth)
      .height(graphElement.clientHeight)
      .enableNavigationControls(true)
      .resumeAnimation();
    requestAnimationFrame(() => {
      requestAnimationFrame(fitRepositoryGraph3D);
    });
  } else {
    if (graph3D) {
      graph3D.pauseAnimation();
      graph3DElement.hidden = true;
    }
    graph2DElement.hidden = false;
    graph = graph2D;
    graph2D
      .width(graphElement.clientWidth)
      .height(graphElement.clientHeight)
      .resumeAnimation();
  }

  if (graphDimension === '2d') {
    setTimeout(() => graph.zoomToFit(500, 40), 100);
  }
  if (broadcast) {
    window.dispatchEvent(
      new CustomEvent('graph-dimension-change', { detail: { dimension: graphDimension } })
    );
  }
}

graphElement.textContent = 'Loading repository embeddings…';
settingsStatus.textContent = 'Loading repository embeddings…';

async function initializeGraph() {
  repositoryNodes = await loadRepositoryNodes('original');
  originalRepositoryCount = repositoryNodes.length;
  displayedRepositoryNodes = repositoryNodes;

  graphElement.replaceChildren();
  graph2DElement = document.createElement('div');
  graph2DElement.className = 'graph-renderer';
  graphElement.append(graph2DElement);
  graph2D = createRepositoryGraph2D(graph2DElement);
  graph = graph2D;

  graphElement.addEventListener('mouseleave', () => {
    updateNeighborhood(undefined);
  });

  neighborhoodHighlightingInput.addEventListener('change', () => {
    neighborhoodHighlightingEnabled = neighborhoodHighlightingInput.checked;
    refreshGraphStyle();
  });

  async function updateReadmeEmbeddingSettings() {
    const useGeminiSummary =
      document.querySelector('input[name="readmeEmbeddingMode"]:checked').value === 'gemini-summary';
    geminiApiKeySetting.hidden = !useGeminiSummary;

    const requestedMode = useGeminiSummary ? 'gemini-summary' : 'original';
    if (requestedMode === activeReadmeEmbeddingMode) {
      return;
    }

    readmeEmbeddingModeInputs.forEach((input) => {
      input.disabled = true;
    });
    settingsStatus.textContent = `Loading ${useGeminiSummary ? 'Gemini summary' : 'original README'} comparisons…`;
    try {
      const nextRepositoryNodes = await loadRepositoryNodes(requestedMode);
      if (nextRepositoryNodes[0].vector.length !== repositoryNodes[0].vector.length) {
        throw new Error('The selected repository dataset uses an incompatible embedding size.');
      }
      if (
        requestedMode === 'gemini-summary' &&
        nextRepositoryNodes.some((node) =>
          !repositoryNodes.some((originalNode) => canonicalId(originalNode.id) === canonicalId(node.id))
        )
      ) {
        throw new Error('The summary dataset contains repositories missing from the original graph.');
      }

      const nextUserRepositories = [];
      for (let index = 0; index < userRepositories.length; index += 1) {
        const node = userRepositories[index];
        const { vector, summary } = await embedReadme(
          node.readmeText,
          requestedMode,
          (message) => {
            settingsStatus.textContent =
              `Re-embedding added repositories (${index + 1}/${userRepositories.length}): ${message}`;
          },
          node.readmeSummary
        );
        nextUserRepositories.push(prepareNode(
          { ...node, vector, readmeSummary: summary },
          nextRepositoryNodes[0].vector.length
        ));
      }

      repositoryNodes = nextRepositoryNodes;
      userRepositories = nextUserRepositories;
      displayedRepositoryNodes = [...userRepositories, ...repositoryNodes];
      activeReadmeEmbeddingMode = requestedMode;
      nodeLimitInput.max = String(displayedRepositoryNodes.length);
      nodeLimitInput.value = String(Math.min(
        displayedRepositoryNodes.length,
        Number(nodeLimitInput.value)
      ));
      updateNodeLimitRange();
      applyGraphSettings();
      settingsStatus.textContent =
        useGeminiSummary
          ? `Switched to Gemini summary comparisons. ${nextRepositoryNodes.length} of ` +
            `${originalRepositoryCount} repositories have summaries; showing ${displayedNodes.length}.`
          : `Switched to original README comparisons. Showing ${displayedNodes.length} repositories.`;
    } catch (error) {
      readmeEmbeddingModeInputs.forEach((input) => {
        input.checked = input.value === activeReadmeEmbeddingMode;
      });
      geminiApiKeySetting.hidden = activeReadmeEmbeddingMode !== 'gemini-summary';
      settingsStatus.textContent =
        error instanceof Error ? error.message : 'Could not switch repository comparison mode.';
    } finally {
      readmeEmbeddingModeInputs.forEach((input) => {
        input.disabled = false;
      });
    }
  }

  readmeEmbeddingModeInputs.forEach((input) => {
    input.addEventListener('change', updateReadmeEmbeddingSettings);
  });
  updateReadmeEmbeddingSettings();

  for (const input of graphDimensionInputs) {
    input.addEventListener('change', async () => {
      if (!input.checked) {
        return;
      }
      try {
        await setGraphDimension(input.value);
      } catch (error) {
        settingsStatus.textContent =
          error instanceof Error ? error.message : 'Could not switch graph dimensions.';
        graphDimensionInputs.forEach((dimensionInput) => {
          dimensionInput.checked = dimensionInput.value === graphDimension;
        });
      }
    });
  }

  linkOpacityValue.value = `${linkOpacityInput.value}%`;
  linkOpacityInput.addEventListener('input', () => {
    linkOpacityValue.value = `${linkOpacityInput.value}%`;
    refreshGraphStyle();
  });

  textOpacityValue.value = `${textOpacityInput.value}%`;
  textOpacityInput.addEventListener('input', () => {
    textOpacityValue.value = `${textOpacityInput.value}%`;
    if (graphDimension === '2d' && graph2D) {
      graph2D.zoom(graph2D.zoom());
    }
    refreshGraphStyle();
  });

  nodeLimitInput.max = String(repositoryNodes.length);
  nodeLimitInput.value = String(Math.min(100, repositoryNodes.length));
  neighborLimitInput.max = String(repositoryNodes.length - 1);
  neighborLimitInput.value = String(Math.min(5, repositoryNodes.length - 1));
  updateNodeLimitRange();
  applyGraphSettings();

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    try {
      applyGraphSettings();
      searchStatus.textContent = '';
    } catch (error) {
      settingsStatus.textContent = error.message;
    }
  });

  nodeLimitInput.addEventListener('input', updateNodeLimitRange);
  nodeLimitNumberInput.addEventListener('input', () => {
    const nodeLimit = nodeLimitNumberInput.valueAsNumber;
    if (
      !Number.isInteger(nodeLimit) ||
      nodeLimit < 1 ||
      nodeLimit > displayedRepositoryNodes.length
    ) {
      return;
    }

    nodeLimitInput.value = String(nodeLimit);
    updateNodeLimitRange();
  });

  searchInput.addEventListener('input', () => {
    if (searchInput.value.trim()) {
      return;
    }

    selectedNode = undefined;
    selectedFirstOrderNeighborIds = new Set();
    selectedSecondOrderNeighborIds = new Set();
    searchStatus.textContent = '';
    clearRepositoryLinks();
    updateNeighborhood(undefined);
    graph.zoomToFit(500, 40);
  });

  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (!query) {
      searchStatus.textContent = 'Enter a repository name to find it.';
      return;
    }

    const node = findRepository(query, displayedNodes);
    if (!node) {
      clearRepositoryLinks();
      const exists = findRepository(query, displayedRepositoryNodes);
      searchStatus.textContent = exists
        ? 'Repository is not displayed. Increase the repository count and try again.'
        : 'No matching repository found.';
      return;
    }
    showRepository(node);
  });

  addRepositoryForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    addRepositoryStatus.textContent = '';
    addRepositoryButton.disabled = true;

    try {
      const { owner, repository } = parseRepositoryUrl(repositoryUrlInput.value.trim());
      const requestedId = canonicalId(`${owner}/${repository}`);
      const existingIndex = displayedRepositoryNodes.findIndex(
        (node) => canonicalId(node.fullName) === requestedId
      );
      if (existingIndex !== -1) {
        const existingNode = displayedRepositoryNodes[existingIndex];
        focusExistingRepository(existingNode, existingIndex);
        addRepositoryStatus.textContent = `${existingNode.fullName} is already in the graph.`;
        return;
      }

      addRepositoryStatus.textContent = 'Fetching repository README…';
      const { repositoryInfo, readmeText } = await getRepositoryReadme(owner, repository);
      const fullName = repositoryInfo.full_name;
      const fetchedId = canonicalId(fullName);
      const fetchedExistingIndex = displayedRepositoryNodes.findIndex(
        (node) => canonicalId(node.fullName) === fetchedId
      );
      if (fetchedExistingIndex !== -1) {
        const existingNode = displayedRepositoryNodes[fetchedExistingIndex];
        focusExistingRepository(existingNode, fetchedExistingIndex);
        addRepositoryStatus.textContent = `${existingNode.fullName} is already in the graph.`;
        return;
      }

      const { vector, summary } = await embedReadme(readmeText, activeReadmeEmbeddingMode, (message) => {
        addRepositoryStatus.textContent = message;
      });
      const newNode = prepareNode(
        {
          id: fullName,
          name: repositoryInfo.name,
          fullName,
          url: repositoryInfo.html_url,
          vector,
          readmeText,
          readmeSummary: summary,
          isUserProvided: true,
        },
        repositoryNodes[0].vector.length
      );
      userRepositories.push(newNode);
      displayedRepositoryNodes = [...userRepositories, ...repositoryNodes];

      const newNodeCount = displayedRepositoryNodes.length;
      nodeLimitInput.max = String(newNodeCount);
      nodeLimitInput.value = String(Math.min(newNodeCount, Number(nodeLimitInput.value) + 1));
      updateNodeLimitRange();
      applyGraphSettings();
      searchInput.value = fullName;
      showRepository(newNode);
      repositoryUrlInput.value = '';
      addRepositoryStatus.textContent = `Added ${fullName} to the graph.`;
    } catch (error) {
      addRepositoryStatus.textContent =
        error instanceof Error ? error.message : 'Could not add this repository.';
    } finally {
      addRepositoryButton.disabled = false;
    }
  });

  for (const input of readmeSourceInputs) {
    input.addEventListener('change', () => {
      const useFile = document.querySelector('input[name="readmeSource"]:checked').value === 'file';
      readmeTextSource.hidden = useFile;
      customReadmeTextInput.required = !useFile;
      customReadmeTextInput.disabled = useFile;
      readmeFileSource.hidden = !useFile;
      customReadmeFileInput.required = useFile;
      customReadmeFileInput.disabled = !useFile;
    });
  }

  customReadmeForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    customReadmeStatus.textContent = '';
    customReadmeButton.disabled = true;

    try {
      const title = customRepositoryTitleInput.value.trim();
      if (!title) {
        throw new Error('Enter a title for this repository.');
      }

      const source = document.querySelector('input[name="readmeSource"]:checked').value;
      let readmeText;
      if (source === 'file') {
        const file = customReadmeFileInput.files[0];
        if (!file) {
          throw new Error('Choose a README file to upload.');
        }
        readmeText = await file.text();
      } else {
        readmeText = customReadmeTextInput.value;
      }
      if (!readmeText.trim()) {
        throw new Error('README content cannot be empty.');
      }

      const { vector, summary } = await embedReadme(readmeText, activeReadmeEmbeddingMode, (message) => {
        customReadmeStatus.textContent = message;
      });
      const id = `custom:${crypto.randomUUID()}`;
      const customNode = prepareNode(
        {
          id,
          name: title,
          fullName: title,
          url: '',
          vector,
          readmeText,
          readmeSummary: summary,
          isUserProvided: true,
        },
        repositoryNodes[0].vector.length
      );

      userRepositories.push(customNode);
      displayedRepositoryNodes = [...userRepositories, ...repositoryNodes];
      const newNodeCount = displayedRepositoryNodes.length;
      nodeLimitInput.max = String(newNodeCount);
      nodeLimitInput.value = String(Math.min(newNodeCount, Number(nodeLimitInput.value) + 1));
      updateNodeLimitRange();
      applyGraphSettings();
      searchInput.value = title;
      showRepository(customNode);
      customReadmeForm.reset();
      readmeTextSource.hidden = false;
      customReadmeTextInput.required = true;
      customReadmeTextInput.disabled = false;
      readmeFileSource.hidden = true;
      customReadmeFileInput.required = false;
      customReadmeFileInput.disabled = true;
      customReadmeStatus.textContent = `Added "${title}" to the graph.`;
    } catch (error) {
      customReadmeStatus.textContent =
        error instanceof Error ? error.message : 'Could not compare this README.';
    } finally {
      customReadmeButton.disabled = false;
    }
  });

  function resizeGraph() {
    graph.width(graphElement.clientWidth);
    graph.height(graphElement.clientHeight);
  }

  new ResizeObserver(resizeGraph).observe(graphElement);
  window.addEventListener('resize', resizeGraph);
}

initializeGraph().catch((error) => {
  graphElement.textContent = 'Could not load the repository graph.';
  settingsStatus.textContent =
    error instanceof Error ? error.message : 'Could not load repository data.';
});

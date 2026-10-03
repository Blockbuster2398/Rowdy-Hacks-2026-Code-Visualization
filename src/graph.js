import ForceGraph from 'force-graph';
import graphData from '../github-readmes/github-top-repository-links.json';
import './style.css';

const graphElement = document.getElementById('graph');
const settingsForm = document.getElementById('graph-settings-form');
const nodeLimitInput = document.getElementById('node-limit');
const neighborLimitInput = document.getElementById('neighbor-limit');
const settingsStatus = document.getElementById('settings-status');
const neighborhoodHighlightingInput = document.getElementById('neighborhood-highlighting');
const searchForm = document.getElementById('repo-search-form');
const searchInput = document.getElementById('repo-search');
const searchStatus = document.getElementById('repo-search-status');
const repositoryOptions = document.getElementById('repository-options');
let selectedNode;
let displayedNodes = [];
let displayedNeighborsByNode = new Map();
let hoveredNodeId;
let firstOrderNeighborIds = new Set();
let secondOrderNeighborIds = new Set();
let neighborhoodHighlightingEnabled = neighborhoodHighlightingInput.checked;

function getNodeFontSize(globalScale) {
  return Math.max(4, 9 / globalScale);
}

nodeLimitInput.max = String(graphData.nodes.length);
nodeLimitInput.value = String(graphData.nodes.length);
neighborLimitInput.max = String(graphData.nodes.length - 1);
neighborLimitInput.value = String(Math.min(5, graphData.nodes.length - 1));

const graph = new ForceGraph(graphElement)
  .width(graphElement.clientWidth)
  .height(graphElement.clientHeight)
  .nodeLabel(() => '')
  .nodeCanvasObjectMode(() => 'replace')
  .nodeCanvasObject((node, context, globalScale) => {
    const fontSize = getNodeFontSize(globalScale);
    const isSelected = node.id === selectedNode?.id;
    const fillStyle = neighborhoodHighlightingEnabled && node.id === hoveredNodeId
      ? '#2e7d32'
      : neighborhoodHighlightingEnabled && firstOrderNeighborIds.has(node.id)
        ? '#e6a700'
        : neighborhoodHighlightingEnabled && secondOrderNeighborIds.has(node.id)
          ? '#d32f2f'
          : isSelected
            ? '#d1495b'
            : '#222';

    context.save();
    context.font = `${isSelected || node.id === hoveredNodeId ? 'bold ' : ''}${fontSize}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = fillStyle;
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
  .linkWidth((link) => 0.5 + 1.5 * link.similarity)
  .onNodeHover((node) => {
    hoveredNodeId = node?.id;
    firstOrderNeighborIds = node
      ? new Set(displayedNeighborsByNode.get(node.id) ?? [])
      : new Set();
    secondOrderNeighborIds = new Set();

    if (node) {
      for (const neighborId of firstOrderNeighborIds) {
        for (const secondNeighborId of displayedNeighborsByNode.get(neighborId) ?? []) {
          if (secondNeighborId !== node.id && !firstOrderNeighborIds.has(secondNeighborId)) {
            secondOrderNeighborIds.add(secondNeighborId);
          }
        }
      }
    }

    graph.zoom(graph.zoom());
  })
  .onNodeClick((node) => window.open(node.url, '_blank', 'noopener,noreferrer'))
  .graphData({ nodes: [], links: [] });

neighborhoodHighlightingInput.addEventListener('change', () => {
  neighborhoodHighlightingEnabled = neighborhoodHighlightingInput.checked;
  graph.zoom(graph.zoom());
});

function applyGraphSettings() {
  const nodeLimit = Number(nodeLimitInput.value);
  const neighborLimit = Number(neighborLimitInput.value);
  const maximumAllowedLinksPerNode =
    Number.isInteger(nodeLimit) && nodeLimit >= 1 && nodeLimit <= graphData.nodes.length
      ? nodeLimit - 1
      : graphData.nodes.length - 1;

  if (
    !Number.isInteger(nodeLimit) ||
    nodeLimit < 1 ||
    nodeLimit > graphData.nodes.length ||
    !Number.isInteger(neighborLimit) ||
    neighborLimit < 0 ||
    neighborLimit > maximumAllowedLinksPerNode
  ) {
    throw new Error(
      `Choose 1-${graphData.nodes.length} repositories and 0-${maximumAllowedLinksPerNode} nearest neighbors.`
    );
  }

  displayedNodes = graphData.nodes.slice(0, nodeLimit);
  const displayedIds = new Set(displayedNodes.map(({ id }) => id));
  const candidateLinks = graphData.links
    .filter(({ source, target }) => displayedIds.has(source) && displayedIds.has(target))
    .sort((a, b) => b.similarity - a.similarity);
  const neighborsByNode = new Map(displayedNodes.map(({ id }) => [id, []]));

  for (const link of candidateLinks) {
    neighborsByNode.get(link.source).push({
      id: link.target,
      link,
      similarity: link.similarity,
    });
    neighborsByNode.get(link.target).push({
      id: link.source,
      link,
      similarity: link.similarity,
    });
  }

  const linksByPair = new Map();
  for (const neighbors of neighborsByNode.values()) {
    neighbors.sort((a, b) => b.similarity - a.similarity);
    for (const { link } of neighbors.slice(0, neighborLimit)) {
      const pair = [link.source, link.target].sort().join('\0');
      linksByPair.set(pair, link);
    }
  }
  const displayedLinks = [...linksByPair.values()];
  displayedNeighborsByNode = new Map(displayedNodes.map(({ id }) => [id, new Set()]));
  for (const link of displayedLinks) {
    displayedNeighborsByNode.get(link.source).add(link.target);
    displayedNeighborsByNode.get(link.target).add(link.source);
  }

  graph.graphData({
    nodes: displayedNodes.map((node) => ({ ...node })),
    links: displayedLinks.map((link) => ({ ...link })),
  });
  selectedNode = undefined;
  hoveredNodeId = undefined;
  firstOrderNeighborIds = new Set();
  secondOrderNeighborIds = new Set();

  const renderedLinks = displayedLinks.length;
  settingsStatus.textContent =
    `Showing ${displayedNodes.length} repositories with up to ${neighborLimit} nearest neighbors each (${renderedLinks} links).`;
  searchStatus.textContent = '';

  repositoryOptions.replaceChildren();
  for (const node of displayedNodes) {
    const option = document.createElement('option');
    option.value = node.fullName;
    repositoryOptions.append(option);
  }

  setTimeout(() => graph.zoomToFit(500, 40), 300);
}

settingsForm.addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    applyGraphSettings();
    searchStatus.textContent = '';
  } catch (error) {
    settingsStatus.textContent = error.message;
  }
});

nodeLimitInput.addEventListener('input', () => {
  const nodeLimit = Number(nodeLimitInput.value);
  if (Number.isInteger(nodeLimit) && nodeLimit >= 1) {
    neighborLimitInput.max = String(nodeLimit - 1);
    if (Number(neighborLimitInput.value) > nodeLimit - 1) {
      neighborLimitInput.value = String(nodeLimit - 1);
    }
  }
});

applyGraphSettings();

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim().toLocaleLowerCase();
  if (!query) {
    searchStatus.textContent = 'Enter a repository name to find it.';
    return;
  }

  const node = displayedNodes.find(
    ({ name, fullName }) =>
      name.toLocaleLowerCase() === query ||
      fullName.toLocaleLowerCase() === query
  ) ?? displayedNodes.find(
    ({ name, fullName }) =>
      name.toLocaleLowerCase().includes(query) ||
      fullName.toLocaleLowerCase().includes(query)
  );

  if (!node) {
    const exists = graphData.nodes.some(
      ({ name, fullName }) =>
        name.toLocaleLowerCase() === query ||
        fullName.toLocaleLowerCase() === query ||
        name.toLocaleLowerCase().includes(query) ||
        fullName.toLocaleLowerCase().includes(query)
    );
    searchStatus.textContent = exists
      ? 'Repository is not displayed. Increase the repository count and try again.'
      : 'No matching repository found.';
    return;
  }

  const graphNode = graph.graphData().nodes.find(({ id }) => id === node.id);
  selectedNode = graphNode;
  searchStatus.textContent = `Showing ${node.fullName}.`;
  graph.centerAt(graphNode.x, graphNode.y, 500).zoom(Math.max(graph.zoom(), 3), 500);
});

function resizeGraph() {
  graph.width(graphElement.clientWidth);
  graph.height(graphElement.clientHeight);
}

new ResizeObserver(resizeGraph).observe(graphElement);
window.addEventListener('resize', resizeGraph);
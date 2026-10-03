import ForceGraph from 'force-graph';
import graphData from '../github-readmes/github-top-repository-links.json';

const graphElement = document.getElementById('graph');
const graphSummary = document.getElementById('graph-summary');
const searchForm = document.getElementById('repo-search-form');
const searchInput = document.getElementById('repo-search');
const searchStatus = document.getElementById('repo-search-status');
const repositoryOptions = document.getElementById('repository-options');
let selectedNode;

graphSummary.textContent =
  `${graphData.nodes.length} repositories · ${graphData.links.length} similarity links. Click a repository name to open it on GitHub.`;

for (const node of graphData.nodes) {
  const option = document.createElement('option');
  option.value = node.fullName;
  repositoryOptions.append(option);
}

const graph = new ForceGraph(graphElement)
  .width(graphElement.clientWidth)
  .height(graphElement.clientHeight)
  .nodeLabel(() => '')
  .nodeCanvasObjectMode(() => 'replace')
  .nodeCanvasObject((node, context, globalScale) => {
    const fontSize = Math.max(4, 9 / globalScale);

    context.save();
    context.font = `${node === selectedNode ? 'bold ' : ''}${fontSize}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = node === selectedNode ? '#d1495b' : '#222';
    context.fillText(node.name, node.x, node.y);
    context.restore();
  })
  .nodePointerAreaPaint((node, color, context, globalScale) => {
    context.font = `${Math.max(4, 9 / globalScale)}px sans-serif`;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = color;
    context.fillText(node.name, node.x, node.y);
  })
  .linkWidth((link) => 0.5 + 1.5 * link.similarity)
  .onNodeClick((node) => window.open(node.url, '_blank', 'noopener,noreferrer'))
  .graphData(graphData);

setTimeout(() => graph.zoomToFit(500, 40), 500);

searchForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = searchInput.value.trim().toLocaleLowerCase();
  if (!query) {
    searchStatus.textContent = 'Enter a repository name to find it.';
    return;
  }

  const node = graphData.nodes.find(
    ({ name, fullName }) =>
      name.toLocaleLowerCase() === query ||
      fullName.toLocaleLowerCase() === query
  ) ?? graphData.nodes.find(
    ({ name, fullName }) =>
      name.toLocaleLowerCase().includes(query) ||
      fullName.toLocaleLowerCase().includes(query)
  );

  if (!node) {
    searchStatus.textContent = 'No matching repository found.';
    return;
  }

  selectedNode = node;
  searchStatus.textContent = `Showing ${node.fullName}.`;
  graph.centerAt(node.x, node.y, 500).zoom(Math.max(graph.zoom(), 3), 500);
});

function resizeGraph() {
  graph.width(graphElement.clientWidth);
  graph.height(graphElement.clientHeight);
}

new ResizeObserver(resizeGraph).observe(graphElement);
window.addEventListener('resize', resizeGraph);
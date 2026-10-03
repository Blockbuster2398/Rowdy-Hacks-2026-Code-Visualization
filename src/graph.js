import ForceGraph from 'force-graph';
import './style.css';

const graphElement = document.getElementById('graph');
const settingsForm = document.getElementById('graph-settings-form');
const nodeLimitInput = document.getElementById('node-limit');
const nodeLimitValue = document.getElementById('node-limit-value');
const neighborLimitInput = document.getElementById('neighbor-limit');
const settingsStatus = document.getElementById('settings-status');
const neighborhoodHighlightingInput = document.getElementById('neighborhood-highlighting');
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
let firstOrderNeighborIds = new Set();
let secondOrderNeighborIds = new Set();
let neighborhoodHighlightingEnabled = neighborhoodHighlightingInput.checked;
let repositoryNodes = [];
let userRepositories = [];
let displayedRepositoryNodes = [];
let graph;

window.addEventListener('beforeunload', (event) => {
  if (userRepositories.length > 0) {
    event.preventDefault();
    event.returnValue = '';
  }
});

function canonicalId(fullName) {
  return fullName.toLocaleLowerCase('en-US');
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
  return Math.max(4, 9 / globalScale);
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

  if (Number.isFinite(graphNode.x) && Number.isFinite(graphNode.y)) {
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

  graph.graphData({
    nodes: displayedNodes.map(({ id, name, fullName, url, isUserProvided }) => ({
      id,
      name,
      fullName,
      url,
      isUserProvided,
    })),
    links: displayedLinks.map((link) => ({ ...link })),
  });
  selectedNode = undefined;
  hoveredNodeId = undefined;
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

  setTimeout(() => graph.zoomToFit(500, 40), 300);
}

function updateNodeLimitRange() {
  nodeLimitInput.max = String(displayedRepositoryNodes.length);
  nodeLimitValue.value = nodeLimitInput.value;
  const maximumNeighbors = Math.max(0, Number(nodeLimitInput.value) - 1);
  neighborLimitInput.max = String(maximumNeighbors);
  if (Number(neighborLimitInput.value) > maximumNeighbors) {
    neighborLimitInput.value = String(maximumNeighbors);
  }
}

function parseRepositoryUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('Enter a valid GitHub repository URL.');
  }

  if (url.protocol !== 'https:' || url.hostname.toLocaleLowerCase() !== 'github.com') {
    throw new Error('Use a public repository URL from https://github.com.');
  }

  const pathParts = url.pathname.split('/').filter(Boolean);
  if (pathParts.length !== 2) {
    throw new Error('Use a repository URL in the form https://github.com/owner/repository.');
  }

  const [owner, rawRepository] = pathParts.map(decodeURIComponent);
  const repository = rawRepository.replace(/\.git$/i, '');
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository) ||
    owner === '.' ||
    owner === '..' ||
    repository === '.' ||
    repository === '..'
  ) {
    throw new Error('The repository URL contains an invalid owner or repository name.');
  }
  return { owner, repository };
}

async function fetchGitHubJson(url, resourceDescription) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    if (response.status === 403 || response.status === 429) {
      throw new Error('GitHub API rate limit reached. Please wait before trying again.');
    }
    if (response.status === 404) {
      throw new Error(`${resourceDescription} was not found or is not public.`);
    }
    throw new Error(`Could not fetch ${resourceDescription} (GitHub returned ${response.status}).`);
  }
  return response.json();
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

graphElement.textContent = 'Loading repository embeddings…';
settingsStatus.textContent = 'Loading repository embeddings…';

async function initializeGraph() {
  const response = await fetch(`${import.meta.env.BASE_URL}repository-embeddings.json`);
  if (!response.ok) {
    throw new Error(`Could not load repository embeddings (HTTP ${response.status}).`);
  }
  const data = await response.json();
  if (!Array.isArray(data.nodes) || data.nodes.length === 0) {
    throw new Error('Repository embeddings file does not contain any repositories.');
  }

  const dimensions = data.nodes[0].vector?.length;
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error('Repository embeddings file contains an invalid vector.');
  }
  const knownIds = new Set();
  repositoryNodes = data.nodes.map((node) => {
    const preparedNode = prepareNode(node, dimensions);
    const id = canonicalId(preparedNode.fullName);
    if (knownIds.has(id)) {
      throw new Error(`Duplicate repository in graph data: ${preparedNode.fullName}.`);
    }
    knownIds.add(id);
    return preparedNode;
  });
  displayedRepositoryNodes = repositoryNodes;

  graphElement.replaceChildren();
  graph = new ForceGraph(graphElement)
    .width(graphElement.clientWidth)
    .height(graphElement.clientHeight)
    .nodeLabel(() => '')
    .nodeCanvasObjectMode(() => 'replace')
    .nodeCanvasObject((node, context, globalScale) => {
      const fontSize = getNodeFontSize(globalScale);
      const isSelected = node.id === selectedNode?.id;
      const fillStyle = node.isUserProvided
        ? '#8e24aa'
        : neighborhoodHighlightingEnabled && node.id === hoveredNodeId
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
    .linkWidth((link) => Math.max(0.5, 0.5 + 1.5 * link.similarity))
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
    .onNodeClick((node) => {
      if (node.url) {
        window.open(node.url, '_blank', 'noopener,noreferrer');
      }
    })
    .graphData({ nodes: [], links: [] });

  neighborhoodHighlightingInput.addEventListener('change', () => {
    neighborhoodHighlightingEnabled = neighborhoodHighlightingInput.checked;
    graph.zoom(graph.zoom());
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

      addRepositoryStatus.textContent = 'Embedding README. The model may need to download first…';
      const { embedText } = await import('../embeddings/word2vec.js');
      const vector = await embedText(readmeText);
      const newNode = prepareNode(
        {
          id: fullName,
          name: repositoryInfo.name,
          fullName,
          url: repositoryInfo.html_url,
          vector,
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

      customReadmeStatus.textContent = 'Embedding README. The model may need to download first…';
      const { embedText } = await import('../embeddings/word2vec.js');
      const vector = await embedText(readmeText);
      const id = `custom:${crypto.randomUUID()}`;
      const customNode = prepareNode(
        {
          id,
          name: title,
          fullName: title,
          url: '',
          vector,
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

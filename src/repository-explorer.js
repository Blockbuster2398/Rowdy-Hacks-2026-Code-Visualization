import { fetchGitHubJson, parseRepositoryUrl } from './github.js';

const tabs = [...document.querySelectorAll('[role="tab"]')];
const form = document.getElementById('repository-explorer-form');
const repositoryUrlInput = document.getElementById('explorer-repository-url');
const submitButton = document.getElementById('explorer-submit');
const status = document.getElementById('explorer-status');
const results = document.getElementById('explorer-results');
const repositoryName = document.getElementById('explorer-repository-name');
const repositoryDescription = document.getElementById('explorer-repository-description');
const repositoryLink = document.getElementById('explorer-repository-link');
const readmeList = document.getElementById('readme-repositories-list');
const sourceList = document.getElementById('source-repositories-list');
const readmeCount = document.getElementById('readme-repository-count');
const sourceCount = document.getElementById('source-repository-count');
const readmeEmpty = document.getElementById('readme-repositories-empty');
const sourceEmpty = document.getElementById('source-repositories-empty');
const resultsNote = document.getElementById('explorer-results-note');

const manifestPatterns = [
  /^package\.json$/i,
  /^requirements(?:[-_.][^/]*)?\.txt$/i,
  /^pyproject\.toml$/i,
  /^cargo\.toml$/i,
  /^go\.mod$/i,
];
const ignoredPathParts = new Set([
  '.git',
  'node_modules',
  'vendor',
  '.venv',
  'venv',
  'target',
]);

for (const tab of tabs) {
  tab.addEventListener('click', () => activateTab(tab));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') {
      return;
    }
    event.preventDefault();
    const direction = event.key === 'ArrowRight' ? 1 : -1;
    const nextIndex = (tabs.indexOf(tab) + direction + tabs.length) % tabs.length;
    tabs[nextIndex].focus();
    activateTab(tabs[nextIndex]);
  });
}

function activateTab(activeTab) {
  for (const tab of tabs) {
    const active = tab === activeTab;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    tab.classList.toggle('is-active', active);
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !active;
  }
  if (activeTab.id === 'similarity-tab') {
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  }
}

function normalizeGitHubRepository(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  let candidate = value.trim().replace(/[.,;!?]+$/, '');
  if (!candidate) {
    return undefined;
  }
  if (/^github:/i.test(candidate)) {
    candidate = `https://github.com/${candidate.slice('github:'.length)}`;
  } else if (/^git@github\.com:/i.test(candidate)) {
    candidate = `https://github.com/${candidate.slice('git@github.com:'.length)}`;
  } else {
    candidate = candidate.replace(/^git\+/, '').replace(/^git:\/\//i, 'https://');
    if (!/^[a-z][a-z\d+.-]*:\/\//i.test(candidate)) {
      candidate = `https://${candidate}`;
    }
  }

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return undefined;
  }
  if (
    !['github.com', 'www.github.com'].includes(url.hostname.toLocaleLowerCase()) ||
    !['https:', 'http:', 'ssh:'].includes(url.protocol)
  ) {
    return undefined;
  }

  let parts;
  try {
    parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  } catch {
    return undefined;
  }
  if (parts.length < 2) {
    return undefined;
  }

  const [owner, rawRepository] = parts;
  const repository = rawRepository.replace(/\.git$/i, '');
  if (
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(repository) ||
    owner === '.' ||
    owner === '..' ||
    repository === '.' ||
    repository === '..'
  ) {
    return undefined;
  }

  return {
    fullName: `${owner}/${repository}`,
    url: `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`,
  };
}

function findGitHubRepositoryInText(value) {
  const directRepository = normalizeGitHubRepository(value);
  if (directRepository) {
    return directRepository;
  }
  const match = typeof value === 'string'
    ? value.match(/(?:https?:\/\/|git\+https:\/\/|git:\/\/)?(?:www\.)?github\.com\/[^\s"'`}]+/i)
    : null;
  return match ? normalizeGitHubRepository(match[0]) : undefined;
}

function getReadmeRepositories(readmeText, rootFullName) {
  const repositories = new Map();
  const githubUrlPattern =
    /(?:https?:\/\/)?(?:www\.)?github\.com\/[^\s<>"'`)\]}]+/gi;

  for (const match of readmeText.matchAll(githubUrlPattern)) {
    const repository = normalizeGitHubRepository(match[0]);
    if (repository && repository.fullName.toLocaleLowerCase() !== rootFullName.toLocaleLowerCase()) {
      repositories.set(repository.fullName.toLocaleLowerCase(), repository);
    }
  }
  return [...repositories.values()].sort((left, right) =>
    left.fullName.localeCompare(right.fullName)
  );
}

function decodeBase64(content) {
  const bytes = Uint8Array.from(atob(content.replace(/\s/g, '')), (character) =>
    character.charCodeAt(0)
  );
  return new TextDecoder().decode(bytes);
}

function isManifestPath(path) {
  const parts = path.split('/');
  if (parts.some((part) => ignoredPathParts.has(part.toLocaleLowerCase()))) {
    return false;
  }
  return manifestPatterns.some((pattern) => pattern.test(parts.at(-1)));
}

function parsePackageJson(text, path) {
  const manifest = JSON.parse(text);
  const dependencies = [];
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    const packages = manifest[section];
    if (!packages || typeof packages !== 'object' || Array.isArray(packages)) {
      continue;
    }
    for (const [name, version] of Object.entries(packages)) {
      const directRepository = findGitHubRepositoryInText(version);
      dependencies.push({
        ecosystem: 'npm',
        name,
        path,
        repository: directRepository,
      });
    }
  }
  return dependencies;
}

function parseRequirements(text, path) {
  const dependencies = [];
  for (const line of text.split(/\r?\n/)) {
    const value = line.replace(/\s+#.*$/, '').trim();
    const directRepository = findGitHubRepositoryInText(value);
    if (directRepository) {
      dependencies.push({
        ecosystem: 'pypi',
        name: directRepository.fullName,
        path,
        repository: directRepository,
      });
      continue;
    }
    if (!value || value.startsWith('#') || value.startsWith('-')) {
      continue;
    }
    const match = value.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/);
    if (match) {
      dependencies.push({ ecosystem: 'pypi', name: match[1], path });
    }
  }
  return dependencies;
}

function parsePyProject(text, path) {
  const dependencies = [];
  let section = '';
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      section = sectionMatch[1].toLocaleLowerCase();
      continue;
    }
    const projectDependencyArray =
      (section === 'project' && /^\s*dependencies\s*=\s*\[/.test(line)) ||
      (section.startsWith('project.optional-dependencies') && /=\s*\[/.test(line));
    if (projectDependencyArray) {
      const arrayLines = [line];
      while (
        index + 1 < lines.length &&
        !/\]\s*(?:#.*)?$/.test(arrayLines.at(-1))
      ) {
        arrayLines.push(lines[++index]);
      }
      const arrayText = arrayLines.join('\n');
      for (const [, requirement] of arrayText.matchAll(/["']([^"']+)["']/g)) {
        const directRepository = findGitHubRepositoryInText(requirement);
        if (directRepository) {
          dependencies.push({ ecosystem: 'pypi', name: directRepository.fullName, path, repository: directRepository });
          continue;
        }
        const match = requirement.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/);
        if (match) {
          dependencies.push({ ecosystem: 'pypi', name: match[1], path });
        }
      }
    }
    if (!/^tool\.poetry\.(?:dependencies|group\.[^.]+\.dependencies)$/.test(section)) {
      continue;
    }
    const dependencyMatch = line.match(/^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*=/);
    if (dependencyMatch && dependencyMatch[1].toLocaleLowerCase() !== 'python') {
      dependencies.push({ ecosystem: 'pypi', name: dependencyMatch[1], path });
    }
  }
  return dependencies;
}

function parseCargoManifest(text, path) {
  const dependencies = [];
  let inDependencies = false;
  for (const line of text.split(/\r?\n/)) {
    const sectionMatch = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (sectionMatch) {
      const section = sectionMatch[1].toLocaleLowerCase();
      inDependencies =
        /^(?:workspace\.)?(?:dev-|build-)?dependencies$/.test(section) ||
        /^target\..+\.(?:dev-|build-)?dependencies$/.test(section);
      continue;
    }
    if (!inDependencies) {
      continue;
    }
    const dependencyMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/);
    if (!dependencyMatch) {
      continue;
    }
    const directRepository = findGitHubRepositoryInText(dependencyMatch[2]);
    dependencies.push({
      ecosystem: 'cargo',
      name: dependencyMatch[1],
      path,
      repository: directRepository,
    });
  }
  return dependencies;
}

function parseGoModule(text, path) {
  const dependencies = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\S+\s+\S+\s+\/\/\s*indirect\b/.test(line)) {
      continue;
    }
    const value = line.replace(/\/\/.*$/, '').trim();
    if (!value || value === 'require (' || value === ')' || value.startsWith('module ')) {
      continue;
    }
    const modulePath = value.replace(/^require\s+/, '').split(/\s+/)[0];
    if (!modulePath || modulePath.startsWith('(')) {
      continue;
    }
    const directRepository = normalizeGitHubRepository(modulePath);
    if (directRepository) {
      dependencies.push({ ecosystem: 'go', name: modulePath, path, repository: directRepository });
    }
  }
  return dependencies;
}

function parseManifest(text, path) {
  const filename = path.split('/').at(-1).toLocaleLowerCase();
  if (filename === 'package.json') {
    return parsePackageJson(text, path);
  }
  if (filename.startsWith('requirements')) {
    return parseRequirements(text, path);
  }
  if (filename === 'pyproject.toml') {
    return parsePyProject(text, path);
  }
  if (filename === 'cargo.toml') {
    return parseCargoManifest(text, path);
  }
  if (filename === 'go.mod') {
    return parseGoModule(text, path);
  }
  return [];
}

async function fetchRegistryJson(url, description) {
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
  if (response.status === 404) {
    return null;
  }
  if (!response.ok) {
    throw new Error(`Could not look up ${description} (HTTP ${response.status}).`);
  }
  return response.json();
}

function getRepositoryField(value) {
  return typeof value === 'string' ? value : value?.url;
}

async function findDependencyRepository(dependency) {
  const encodedName = encodeURIComponent(dependency.name);
  let metadata;
  let repositoryUrl;
  if (dependency.ecosystem === 'npm') {
    metadata = await fetchRegistryJson(
      `https://registry.npmjs.org/${encodedName}`,
      `npm package ${dependency.name}`
    );
    repositoryUrl = getRepositoryField(metadata?.repository);
  } else if (dependency.ecosystem === 'pypi') {
    metadata = await fetchRegistryJson(
      `https://pypi.org/pypi/${encodedName}/json`,
      `Python package ${dependency.name}`
    );
    const urls = metadata?.info?.project_urls ?? {};
    repositoryUrl =
      Object.entries(urls).find(([key]) => /source|repository|code/i.test(key))?.[1] ??
      metadata?.info?.home_page;
  } else if (dependency.ecosystem === 'cargo') {
    metadata = await fetchRegistryJson(
      `https://crates.io/api/v1/crates/${encodedName}`,
      `Cargo crate ${dependency.name}`
    );
    repositoryUrl = metadata?.crate?.repository;
  }

  return normalizeGitHubRepository(repositoryUrl);
}

async function mapConcurrent(items, concurrency, callback) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { value: await callback(items[index]) };
      } catch (error) {
        results[index] = { error };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

async function fetchManifestText(owner, repository, branch, path) {
  const branchPath = branch.split('/').map(encodeURIComponent).join('/');
  const filePath = path.split('/').map(encodeURIComponent).join('/');
  const url =
    `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/` +
    `${branchPath}/${filePath}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Could not fetch manifest ${path} (HTTP ${response.status}).`);
  }
  const content = await response.text();
  if (content.length > 1_000_000) {
    throw new Error(`Manifest ${path} is too large to analyze.`);
  }
  return content.replace(/^\uFEFF/, '');
}

function appendRepositoryEntries(list, repositories, kind) {
  list.replaceChildren();
  for (const repository of repositories) {
    const item = document.createElement('li');
    item.className = 'repository-entry';
    const details = document.createElement('span');
    const link = document.createElement('a');
    link.href = repository.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = repository.fullName;

    const reference = document.createElement('small');
    reference.textContent =
      kind === 'readme'
        ? 'Linked in README'
        : repository.dependencies.length === 1
          ? `Dependency: ${repository.dependencies[0]}`
          : `${repository.dependencies.length} dependencies: ${repository.dependencies.join(', ')}`;
    details.append(link, reference);
    item.append(details);
    list.append(item);
  }
}

function clearResults() {
  results.hidden = true;
  readmeList.replaceChildren();
  sourceList.replaceChildren();
  resultsNote.hidden = true;
  resultsNote.textContent = '';
}

async function exploreRepository(value) {
  const { owner, repository } = parseRepositoryUrl(value);
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`;
  status.textContent = 'Fetching repository details…';

  const repositoryInfo = await fetchGitHubJson(apiBase, 'Repository');
  if (!repositoryInfo.default_branch) {
    throw new Error('GitHub did not provide a default branch for this repository.');
  }

  status.textContent = 'Reading README and dependency manifests…';
  const treeUrl = `${apiBase}/git/trees/${encodeURIComponent(repositoryInfo.default_branch)}?recursive=1`;
  const [readme, tree] = await Promise.all([
    fetchGitHubJson(`${apiBase}/readme`, 'README', true),
    fetchGitHubJson(treeUrl, 'Repository file tree'),
  ]);

  let readmeText = '';
  const notes = [];
  if (readme?.encoding === 'base64' && typeof readme.content === 'string') {
    readmeText = decodeBase64(readme.content);
  } else if (readme) {
    notes.push('GitHub did not provide readable README content.');
  } else {
    notes.push('No README was found.');
  }

  const readmeRepositories = getReadmeRepositories(readmeText, repositoryInfo.full_name);
  const manifestPaths = (tree.tree ?? [])
    .filter((entry) => entry.type === 'blob' && isManifestPath(entry.path))
    .map((entry) => entry.path);
  if (tree.truncated) {
    notes.push('GitHub truncated the repository file listing, so some dependency manifests may be missing.');
  }

  const manifestResults = await mapConcurrent(manifestPaths, 6, async (path) => ({
    path,
    dependencies: parseManifest(
      await fetchManifestText(owner, repository, repositoryInfo.default_branch, path),
      path
    ),
  }));
  const dependencies = [];
  const manifestErrors = [];
  for (const result of manifestResults) {
    if (result.error) {
      manifestErrors.push(result.error.message);
    } else {
      dependencies.push(...result.value.dependencies);
    }
  }
  if (manifestErrors.length > 0) {
    notes.push(`Could not process ${manifestErrors.length} dependency manifest${manifestErrors.length === 1 ? '' : 's'}: ${manifestErrors.join(' ')}`);
  }

  const uniqueDependencies = new Map();
  for (const dependency of dependencies) {
    const key = `${dependency.ecosystem}:${dependency.name.toLocaleLowerCase()}`;
    const existing = uniqueDependencies.get(key);
    if (existing) {
      existing.paths.add(dependency.path);
      if (dependency.repository) {
        existing.repository = dependency.repository;
      }
    } else {
      uniqueDependencies.set(key, { ...dependency, paths: new Set([dependency.path]) });
    }
  }

  const dependencyGroups = new Map();
  for (const dependency of uniqueDependencies.values()) {
    if (dependency.repository) {
      addDependencyRepository(dependencyGroups, dependency.repository, dependency.name);
    }
  }

  const registryDependencies = [...uniqueDependencies.values()].filter(
    (dependency) =>
      !dependency.repository &&
      ['npm', 'pypi', 'cargo'].includes(dependency.ecosystem)
  );
  const registryResults = await mapConcurrent(registryDependencies, 6, findDependencyRepository);
  const registryErrors = [];
  for (const [index, result] of registryResults.entries()) {
    if (result.error) {
      registryErrors.push(`${registryDependencies[index].name}: ${result.error.message}`);
      continue;
    }
    if (result.value) {
      addDependencyRepository(
        dependencyGroups,
        result.value,
        registryDependencies[index].name
      );
    }
  }
  if (registryErrors.length > 0) {
    notes.push(`Could not check ${registryErrors.length} package registry entr${registryErrors.length === 1 ? 'y' : 'ies'}: ${registryErrors.join(' ')}`);
  }

  const sourceRepositories = [...dependencyGroups.values()].sort((left, right) =>
    left.fullName.localeCompare(right.fullName)
  );
  repositoryName.textContent = repositoryInfo.full_name;
  repositoryDescription.textContent = repositoryInfo.description ?? 'No repository description provided.';
  repositoryLink.href = repositoryInfo.html_url;
  readmeCount.value = String(readmeRepositories.length);
  sourceCount.value = String(sourceRepositories.length);
  appendRepositoryEntries(readmeList, readmeRepositories, 'readme');
  appendRepositoryEntries(sourceList, sourceRepositories, 'source');
  readmeEmpty.hidden = readmeRepositories.length > 0;
  sourceEmpty.hidden = sourceRepositories.length > 0;
  results.hidden = false;
  resultsNote.textContent = notes.join(' ');
  resultsNote.hidden = notes.length === 0;

  return {
    readmeCount: readmeRepositories.length,
    sourceCount: sourceRepositories.length,
    manifestCount: manifestPaths.length,
    notes,
  };
}

function addDependencyRepository(groups, repository, dependencyName) {
  const key = repository.fullName.toLocaleLowerCase();
  let group = groups.get(key);
  if (!group) {
    group = { ...repository, dependencies: [] };
    groups.set(key, group);
  }
  if (!group.dependencies.includes(dependencyName)) {
    group.dependencies.push(dependencyName);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  clearResults();
  submitButton.disabled = true;
  status.textContent = '';

  try {
    const result = await exploreRepository(repositoryUrlInput.value.trim());
    status.textContent =
      `Found ${result.readmeCount} README links and ${result.sourceCount} GitHub dependency repositories ` +
      `across ${result.manifestCount} manifests.`;
  } catch (error) {
    status.textContent =
      error instanceof Error ? error.message : 'Could not explore this repository.';
  } finally {
    submitButton.disabled = false;
  }
});

export function parseRepositoryUrl(value) {
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

  let owner;
  let rawRepository;
  try {
    [owner, rawRepository] = pathParts.map(decodeURIComponent);
  } catch {
    throw new Error('The repository URL contains invalid encoded characters.');
  }
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

export async function fetchGitHubJson(url, resourceDescription, allowNotFound = false) {
  const response = await fetch(url, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) {
    if (allowNotFound && response.status === 404) {
      return null;
    }
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


const GITHUB_API = "https://api.github.com";

// Get n from the command line.
// Example: node github-readmes.js 25
const n = Number.parseInt(process.argv[2], 10);

if (!Number.isInteger(n) || n < 1 || n > 1000) {
  console.error("Usage: node github-readmes.js <number>");
  console.error("Example: node github-readmes.js 100");
  process.exit(1);
}

// Optional GitHub token.
// Set GITHUB_TOKEN in your environment if you have one.
const token = process.env.GITHUB_TOKEN;

const headers = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2026-03-10",
};

if (token) {
  headers.Authorization = `Bearer ${token}`;
}

async function getTopRepositories(n) {
  const repositories = [];

  for (let page = 1; repositories.length < n; page++) {
    const perPage = Math.min(100, n - repositories.length);

    const url = new URL(`${GITHUB_API}/search/repositories`);

    url.searchParams.set("q", "is:public");
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", perPage);
    url.searchParams.set("page", page);

    const response = await fetch(url, { headers });

    if (!response.ok) {
      throw new Error(
        `GitHub repository search failed: ${response.status} ` +
        response.statusText
      );
    }

    const data = await response.json();

    repositories.push(...data.items);

    if (data.items.length < perPage) {
      break;
    }
  }

  return repositories;
}

async function getReadme(owner, repo) {
  const response = await fetch(
    `${GITHUB_API}/repos/${owner}/${repo}/readme`,
    { headers }
  );

  // Repository doesn't have a README.
  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(
      `Failed to get README for ${owner}/${repo}: ` +
      `${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  // GitHub returns the README as Base64.
  return Buffer.from(data.content, "base64").toString("utf8");
}

async function main() {
  console.log(`Finding the top ${n} public repositories by stars...\n`);

  const repositories = await getTopRepositories(n);

  const results = [];

  for (let i = 0; i < repositories.length; i++) {
    const repo = repositories[i];

    console.log(
      `${i + 1}/${repositories.length}: ${repo.full_name} ` +
      `(${repo.stargazers_count.toLocaleString()} stars)`
    );

    try {
      const readme = await getReadme(
        repo.owner.login,
        repo.name
      );

      results.push({
        rank: i + 1,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        stars: repo.stargazers_count,
        url: repo.html_url,
        description: repo.description,
        language: repo.language,
        readme,
      });
    } catch (error) {
      console.error(`  Error: ${error.message}`);

      results.push({
        rank: i + 1,
        name: repo.name,
        fullName: repo.full_name,
        owner: repo.owner.login,
        stars: repo.stargazers_count,
        url: repo.html_url,
        description: repo.description,
        language: repo.language,
        readme: null,
        error: error.message,
      });
    }
  }

  const fs = await import("node:fs/promises");

  await fs.writeFile(
    "github-top-repositories.json",
    JSON.stringify(results, null, 2),
    "utf8"
  );

  console.log(
    `\nDone! Saved ${results.length} repositories to ` +
    "github-top-repositories.json"
  );
}

main().catch((error) => {
  console.error("\nError:", error.message);
  process.exit(1);
});

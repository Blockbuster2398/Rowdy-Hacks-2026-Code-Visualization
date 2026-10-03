// github-readmes.js
//
// Usage:
//   node github-readmes.js 10
//   node github-readmes.js 100
//
// Before running, set your GitHub token in PowerShell:
//   $env:GITHUB_TOKEN="github_pat_..."
//

const fs = require("node:fs/promises");

const GITHUB_API = "https://api.github.com";
const OUTPUT_FILE = "github-top-repositories.json";

// Conservative pacing to reduce the chance of GitHub secondary rate limits.
// 2500 ms = about 24 requests/minute.
const DELAY_BETWEEN_READMES_MS = 200;

// Maximum number of times to retry a secondary rate-limit response.
const MAX_RATE_LIMIT_RETRIES = 6;

// ------------------------------------------------------------
// Command-line input
// ------------------------------------------------------------

const n = Number.parseInt(process.argv[2], 10);

if (!Number.isInteger(n) || n < 1 || n > 1000) {
  console.error("Usage: node github-readmes.js <number>");
  console.error("Example: node github-readmes.js 100");
  process.exit(1);
}

// ------------------------------------------------------------
// Authentication
// ------------------------------------------------------------

const token = process.env.GITHUB_TOKEN;

if (!token) {
  console.error("GITHUB_TOKEN is not set.");
  console.error("");
  console.error("PowerShell:");
  console.error('$env:GITHUB_TOKEN="github_pat_..."');
  console.error("");
  console.error(`Then run: node github-readmes.js ${n}`);
  process.exit(1);
}

const headers = {
  Accept: "application/vnd.github+json",
  Authorization: `Bearer ${token}`,
  "X-GitHub-Api-Version": "2026-03-10",
  "User-Agent": "github-readme-downloader",
};

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatWait(ms) {
  return `${Math.ceil(ms / 1000)} seconds`;
}

function getRateInfo(response) {
  return {
    remaining: Number.parseInt(
      response.headers.get("x-ratelimit-remaining") ?? "-1",
      10
    ),
    limit: Number.parseInt(
      response.headers.get("x-ratelimit-limit") ?? "-1",
      10
    ),
    reset: Number.parseInt(
      response.headers.get("x-ratelimit-reset") ?? "0",
      10
    ),
    resource: response.headers.get("x-ratelimit-resource") ?? "unknown",
    retryAfter: Number.parseInt(
      response.headers.get("retry-after") ?? "0",
      10
    ),
  };
}

// ------------------------------------------------------------
// Rate-limit-aware GitHub request
// ------------------------------------------------------------

async function githubFetch(url, options = {}) {
  let secondaryRetries = 0;

  while (true) {
    const response = await fetch(url, {
      ...options,
      headers: {
        ...headers,
        ...(options.headers || {}),
      },
    });

    const rate = getRateInfo(response);

    // Successful response.
    if (response.ok) {
      return response;
    }

    // README endpoint legitimately returns 404 when there is no README.
    if (response.status === 404) {
      return response;
    }

    // Primary or secondary rate limit.
    if (response.status === 403 || response.status === 429) {
      const body = await response.text();

      const isPrimaryLimit = rate.remaining === 0;

      if (isPrimaryLimit && rate.reset > 0) {
        const waitMs = Math.max(
          rate.reset * 1000 - Date.now() + 2000,
          1000
        );

        console.log(
          `\nPrimary rate limit reached for ${rate.resource}.`
        );
        console.log(`Waiting ${formatWait(waitMs)} until reset...\n`);

        await sleep(waitMs);
        continue;
      }

      // GitHub says to wait before retrying a secondary limit.
      if (secondaryRetries >= MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          `GitHub secondary rate limit persisted after ` +
          `${MAX_RATE_LIMIT_RETRIES} retries.\n${body}`
        );
      }

      let waitMs;

      if (rate.retryAfter > 0) {
        waitMs = rate.retryAfter * 1000;
      } else {
        // Exponential backoff:
        // 60s, 120s, 240s, 480s, ...
        waitMs = 60_000 * 2 ** secondaryRetries;
      }

      secondaryRetries++;

      console.log(
        `\nGitHub secondary rate limit detected.`
      );
      console.log(
        `Waiting ${formatWait(waitMs)} before retry ` +
        `${secondaryRetries}/${MAX_RATE_LIMIT_RETRIES}...\n`
      );

      await sleep(waitMs);
      continue;
    }

    const body = await response.text();

    throw new Error(
      `GitHub API request failed: ${response.status} ` +
      `${response.statusText}\n${body}`
    );
  }
}

// ------------------------------------------------------------
// Search for the top N public repositories by stars
// ------------------------------------------------------------

async function getTopRepositories(count) {
  const repositories = [];
  let page = 1;

  while (repositories.length < count) {
    const perPage = Math.min(
      100,
      count - repositories.length
    );

    const url = new URL(
      `${GITHUB_API}/search/repositories`
    );

    url.searchParams.set("q", "is:public");
    url.searchParams.set("sort", "stars");
    url.searchParams.set("order", "desc");
    url.searchParams.set("per_page", perPage);
    url.searchParams.set("page", page);

    const response = await githubFetch(url);
    const data = await response.json();

    repositories.push(...data.items);

    if (data.items.length < perPage) {
      break;
    }

    page++;
  }

  return repositories.slice(0, count);
}

// ------------------------------------------------------------
// Get a repository README
// ------------------------------------------------------------

async function getReadme(owner, repo) {
  const url =
    `${GITHUB_API}/repos/${owner}/${repo}/readme`;

  const response = await githubFetch(url);

  if (response.status === 404) {
    return null;
  }

  const data = await response.json();

  if (!data.content) {
    return null;
  }

  // GitHub returns the README body as Base64.
  return Buffer
    .from(data.content, "base64")
    .toString("utf8");
}

// ------------------------------------------------------------
// Save results
// ------------------------------------------------------------

async function saveResults(results) {
  await fs.writeFile(
    OUTPUT_FILE,
    JSON.stringify(results, null, 2),
    "utf8"
  );
}

// ------------------------------------------------------------
// Main
// ------------------------------------------------------------

async function main() {
  console.log(
    `Finding the top ${n} public repositories by stars...`
  );

  const repositories = await getTopRepositories(n);

  console.log(
    `Found ${repositories.length} repositories.\n`
  );

  // Load previous progress if it exists.
  let existingResults = [];

  try {
    const previous = await fs.readFile(
      OUTPUT_FILE,
      "utf8"
    );

    existingResults = JSON.parse(previous);

    if (!Array.isArray(existingResults)) {
      existingResults = [];
    }
  } catch {
    // File doesn't exist yet.
  }

  const existingByRepo = new Map(
    existingResults
      .filter((item) => item && item.fullName)
      .map((item) => [item.fullName, item])
  );

  const results = [];

  for (let i = 0; i < repositories.length; i++) {
    const repo = repositories[i];

    const existing = existingByRepo.get(
      repo.full_name
    );

    // Resume instead of downloading an existing README.
    if (existing && existing.readme !== undefined) {
      const updated = {
        ...existing,
        rank: i + 1,
        stars: repo.stargazers_count,
        description: repo.description,
        language: repo.language,
      };

      results.push(updated);

      console.log(
        `${i + 1}/${repositories.length}: ` +
        `${repo.full_name} — already downloaded`
      );

      continue;
    }

    // Wait between README requests.
    if (results.length > 0) {
      await sleep(DELAY_BETWEEN_READMES_MS);
    }

    console.log(
      `${i + 1}/${repositories.length}: ` +
      `${repo.full_name} ` +
      `(${repo.stargazers_count.toLocaleString()} stars)`
    );

    let readme = null;
    let error = null;

    try {
      readme = await getReadme(
        repo.owner.login,
        repo.name
      );
    } catch (err) {
      error = err.message;

      console.error(
        `  README error: ${error}`
      );
    }

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
      error,
    });

    // Save after EVERY repository.
    await saveResults(results);

    if (readme === null) {
      console.log("  No README found.");
    } else {
      console.log("  README saved.");
    }
  }

  // Final save.
  await saveResults(results);

  console.log("");
  console.log(
    `Done! Saved ${results.length} repositories to:`
  );
  console.log(OUTPUT_FILE);
  console.log("");
  console.log(
    "Run the same command again to resume/reuse " +
    "completed README downloads."
  );
}

main().catch((error) => {
  console.error("");
  console.error("Fatal error:");
  console.error(error.message);
  process.exit(1);
});
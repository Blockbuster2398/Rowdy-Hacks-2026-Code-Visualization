const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIRECTORY = __dirname;
const MODE = process.argv[2] ?? "original";
if (!["original", "summary"].includes(MODE)) {
  throw new Error("Usage: node repository-links.js [original|summary]");
}
const INPUT_FILE = path.join(DATA_DIRECTORY, MODE === "summary"
  ? "github-top-repositories-with-summary-vectors.json"
  : "github-top-repositories-with-vectors.json");
const OUTPUT_FILE = path.join(DATA_DIRECTORY, "..", "public",
  MODE === "summary"
    ? "repository-summary-embeddings.json"
    : "repository-embeddings.json");
const ORIGINAL_OUTPUT_FILE = path.join(
  DATA_DIRECTORY,
  "..",
  "public",
  "repository-embeddings.json"
);

function buildRepositoryGraphData(repositories) {
  const embeddedRepositories = [];
  const repositoriesByName = new Map();

  for (const repository of repositories) {
    if (!Array.isArray(repository.vector)) {
      continue;
    }
    if (!repository.fullName || !repository.name) {
      throw new Error("Every embedded repository needs a name and fullName.");
    }

    const vector = repository.vector;
    if (
      vector.length === 0 ||
      !vector.every((value) => Number.isFinite(value))
    ) {
      throw new Error(`Invalid embedding vector for ${repository.fullName}.`);
    }

    const norm = Math.sqrt(
      vector.reduce((sum, value) => sum + value * value, 0)
    );
    if (norm === 0) {
      throw new Error(`Embedding vector for ${repository.fullName} is zero.`);
    }

    const canonicalId = repository.fullName.toLocaleLowerCase();
    const previous = repositoriesByName.get(canonicalId);
    if (previous) {
      const vectorsMatch =
        previous.vector.length === vector.length &&
        previous.vector.every((value, index) => value === vector[index]);
      if (!vectorsMatch) {
        throw new Error(
          `Duplicate repository ${repository.fullName} has conflicting vectors.`
        );
      }
      continue;
    }

    const embeddedRepository = { repository, vector, norm };
    repositoriesByName.set(canonicalId, embeddedRepository);
    embeddedRepositories.push(embeddedRepository);
  }

  const dimensions = new Set(
    embeddedRepositories.map(({ vector }) => vector.length)
  );
  if (dimensions.size > 1) {
    throw new Error("Repository embedding vectors must all have the same length.");
  }
  if (embeddedRepositories.length === 0) {
    throw new Error("No repositories have valid vectors.");
  }

  const nodes = embeddedRepositories.map(({ repository, vector }) => {
    return {
      id: repository.fullName,
      name: repository.name,
      fullName: repository.fullName,
      url: repository.url,
      vector,
    };
  });

  return { nodes };
}

async function main() {
  const repositories = JSON.parse(await fs.readFile(INPUT_FILE, "utf8"));
  if (!Array.isArray(repositories)) {
    throw new Error(`${path.basename(INPUT_FILE)} must contain a JSON array.`);
  }

  const skippedCount = repositories.filter(
    (repository) => !Array.isArray(repository.vector)
  ).length;
  const graphData = buildRepositoryGraphData(repositories);

  if (MODE === "summary") {
    const originalData = JSON.parse(await fs.readFile(ORIGINAL_OUTPUT_FILE, "utf8"));
    if (!Array.isArray(originalData.nodes)) {
      throw new Error("The original graph dataset does not contain a nodes array.");
    }
    const originalIds = new Set(
      originalData.nodes.map(({ id }) => id.toLocaleLowerCase())
    );
    const unmatchedRepository = graphData.nodes.find(
      ({ id }) => !originalIds.has(id.toLocaleLowerCase())
    );
    if (unmatchedRepository) {
      throw new Error(
        `Summary repository ${unmatchedRepository.id} is not present in the original graph.`
      );
    }
  }

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(graphData, null, 2)}\n`);

  console.log(
    `Saved ${graphData.nodes.length} ${MODE} repositories to ` +
      `${path.basename(OUTPUT_FILE)}.`
  );
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} repositories without vectors.`);
  }
  if (MODE === "summary") {
    console.log(
      `Summary coverage: ${graphData.nodes.length}/${JSON.parse(
        await fs.readFile(ORIGINAL_OUTPUT_FILE, "utf8")
      ).nodes.length} repositories.`
    );
  }
  const duplicateCount =
    repositories.length - skippedCount - graphData.nodes.length;
  if (duplicateCount > 0) {
    console.log(`Skipped ${duplicateCount} duplicate repository entries.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Could not generate repository embeddings: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildRepositoryGraphData };

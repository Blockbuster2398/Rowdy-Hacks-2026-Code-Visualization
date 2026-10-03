const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIRECTORY = __dirname;
const INPUT_FILE = path.join(
  DATA_DIRECTORY,
  "github-top-repositories-with-vectors.json"
);
const OUTPUT_FILE = path.join(
  DATA_DIRECTORY,
  "..",
  "public",
  "repository-embeddings.json"
);

function buildRepositoryGraphData(repositories) {
  const embeddedRepositories = repositories
    .filter((repository) => Array.isArray(repository.vector))
    .map((repository) => {
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

      return { repository, vector, norm };
    });

  const dimensions = new Set(
    embeddedRepositories.map(({ vector }) => vector.length)
  );
  if (dimensions.size > 1) {
    throw new Error("Repository embedding vectors must all have the same length.");
  }

  const nodeIds = new Set();
  const nodes = embeddedRepositories.map(({ repository, vector }) => {
    const canonicalId = repository.fullName.toLocaleLowerCase();
    if (nodeIds.has(canonicalId)) {
      throw new Error(`Duplicate repository: ${repository.fullName}.`);
    }
    nodeIds.add(canonicalId);

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

  await fs.mkdir(path.dirname(OUTPUT_FILE), { recursive: true });
  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(graphData, null, 2)}\n`);

  console.log(
    `Saved ${graphData.nodes.length} repositories to ` +
      `${path.basename(OUTPUT_FILE)}.`
  );
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} repositories without vectors.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Could not generate repository embeddings: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildRepositoryGraphData };

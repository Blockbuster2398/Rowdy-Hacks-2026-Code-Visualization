const fs = require("node:fs/promises");
const path = require("node:path");

const DATA_DIRECTORY = __dirname;
const INPUT_FILE = path.join(
  DATA_DIRECTORY,
  "github-top-repositories-with-vectors.json"
);
const OUTPUT_FILE = path.join(
  DATA_DIRECTORY,
  "github-top-repository-links.json"
);

function buildSimilarityGraph(repositories, neighborCount) {
  if (!Number.isInteger(neighborCount) || neighborCount < 1) {
    throw new Error("Neighbor count must be a positive integer.");
  }

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
  const nodes = embeddedRepositories.map(({ repository }) => {
    if (nodeIds.has(repository.fullName)) {
      throw new Error(`Duplicate repository: ${repository.fullName}.`);
    }
    nodeIds.add(repository.fullName);

    return {
      id: repository.fullName,
      name: repository.name,
      fullName: repository.fullName,
      url: repository.url,
    };
  });

  const linksByPair = new Map();

  for (const source of embeddedRepositories) {
    const nearest = embeddedRepositories
      .filter(({ repository }) => repository.fullName !== source.repository.fullName)
      .map((target) => {
        const dotProduct = source.vector.reduce(
          (sum, value, index) => sum + value * target.vector[index],
          0
        );

        return {
          target,
          similarity: dotProduct / (source.norm * target.norm),
        };
      })
      .sort((a, b) => {
        if (b.similarity !== a.similarity) {
          return b.similarity - a.similarity;
        }
        return a.target.repository.fullName.localeCompare(
          b.target.repository.fullName
        );
      })
      .slice(0, neighborCount);

    for (const { target, similarity } of nearest) {
      const [sourceId, targetId] = [
        source.repository.fullName,
        target.repository.fullName,
      ].sort();
      const key = `${sourceId}\0${targetId}`;

      if (!linksByPair.has(key)) {
        linksByPair.set(key, {
          source: sourceId,
          target: targetId,
          similarity,
        });
      }
    }
  }

  const links = [...linksByPair.values()].sort(
    (a, b) =>
      b.similarity - a.similarity ||
      a.source.localeCompare(b.source) ||
      a.target.localeCompare(b.target)
  );

  return { nodes, links };
}

async function main() {
  const neighborCount = Number(process.argv[2]);
  if (!Number.isInteger(neighborCount) || neighborCount < 1) {
    throw new Error(
      "Usage: node github-readmes/repository-links.js <neighbors-per-repository>"
    );
  }

  const repositories = JSON.parse(await fs.readFile(INPUT_FILE, "utf8"));
  if (!Array.isArray(repositories)) {
    throw new Error(`${path.basename(INPUT_FILE)} must contain a JSON array.`);
  }

  const skippedCount = repositories.filter(
    (repository) => !Array.isArray(repository.vector)
  ).length;
  const graph = buildSimilarityGraph(repositories, neighborCount);

  await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(graph, null, 2)}\n`);

  console.log(
    `Saved ${graph.nodes.length} nodes and ${graph.links.length} links to ` +
      `${path.basename(OUTPUT_FILE)}.`
  );
  if (skippedCount > 0) {
    console.log(`Skipped ${skippedCount} repositories without vectors.`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Could not generate repository links: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { buildSimilarityGraph };

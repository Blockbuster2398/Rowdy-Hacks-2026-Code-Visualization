import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedTexts } from '../embeddings/word2vec.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = path.resolve(
  SCRIPT_DIRECTORY,
  'github-top-repositories.json'
);
const OUTPUT_FILE = path.resolve(
  SCRIPT_DIRECTORY,
  'github-top-repositories-with-vectors.json'
);
const CHUNK_LENGTH = 1500;
const EMBEDDING_BATCH_SIZE = 8;
const CHECKPOINT_INTERVAL = 25;

function splitText(text) {
  const chunks = [];
  let remaining = text.trim();

  while (remaining.length > CHUNK_LENGTH) {
    let splitAt = remaining.lastIndexOf('\n\n', CHUNK_LENGTH);

    if (splitAt < CHUNK_LENGTH / 2) {
      splitAt = remaining.lastIndexOf('\n', CHUNK_LENGTH);
    }

    if (splitAt < CHUNK_LENGTH / 2) {
      splitAt = CHUNK_LENGTH;
    }

    chunks.push(remaining.slice(0, splitAt).trim());
    remaining = remaining.slice(splitAt).trim();
  }

  if (remaining) {
    chunks.push(remaining);
  }

  return chunks;
}

async function readExistingResults() {
  try {
    const contents = await fs.readFile(OUTPUT_FILE, 'utf8');
    const results = JSON.parse(contents);
    return Array.isArray(results) ? results : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }

    throw error;
  }
}

async function createVector(readme, repositoryName) {
  if (typeof readme !== 'string' || !readme.trim()) {
    return null;
  }

  const chunks = splitText(readme);
  const chunkVectors = [];

  for (let index = 0; index < chunks.length; index += EMBEDDING_BATCH_SIZE) {
    const batch = chunks.slice(index, index + EMBEDDING_BATCH_SIZE);
    console.log(
      `  ${repositoryName}: embedding chunks ${index + 1}-${index + batch.length}/${chunks.length}`
    );
    chunkVectors.push(...await embedTexts(batch));
  }

  const meanVector = chunkVectors[0].map((_, dimension) =>
    chunkVectors.reduce((sum, vector) => sum + vector[dimension], 0) /
    chunkVectors.length
  );
  const magnitude = Math.sqrt(
    meanVector.reduce((sum, value) => sum + value * value, 0)
  );

  return meanVector.map((value) => value / magnitude);
}

async function main() {
  const repositories = JSON.parse(await fs.readFile(INPUT_FILE, 'utf8'));

  if (!Array.isArray(repositories)) {
    throw new Error(`Expected an array in ${INPUT_FILE}`);
  }

  const existingResults = await readExistingResults();
  const existingByName = new Map(
    existingResults
      .filter((repository) => repository?.fullName)
      .map((repository) => [repository.fullName, repository])
  );
  const results = [];

  for (let index = 0; index < repositories.length; index++) {
    const repository = repositories[index];
    const existing = existingByName.get(repository.fullName);
    let vector;

    if (
      existing?.readme === repository.readme &&
      Array.isArray(existing.vector)
    ) {
      vector = existing.vector;
      console.log(
        `${index + 1}/${repositories.length}: ${repository.fullName} (reusing vector)`
      );
    } else {
      console.log(`${index + 1}/${repositories.length}: ${repository.fullName}`);
      vector = await createVector(repository.readme, repository.fullName);
    }

    results.push({ ...repository, vector });
    const isCheckpoint = (index + 1) % CHECKPOINT_INTERVAL === 0;
    const isFinalRepository = index + 1 === repositories.length;
    if (isCheckpoint || isFinalRepository) {
      await fs.writeFile(OUTPUT_FILE, JSON.stringify(results, null, 2), 'utf8');
      console.log(`Checkpoint saved: ${results.length}/${repositories.length}`);
    }
  }

  console.log(`Saved ${results.length} repositories to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
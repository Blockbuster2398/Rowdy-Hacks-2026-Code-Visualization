import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { embedText } from '../embeddings/word2vec.js';
import { summarizeReadme } from '../embeddings/gemini.js';

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const INPUT_FILE = path.join(SCRIPT_DIRECTORY, 'github-top-repositories.json');
const OUTPUT_FILE = path.join(
  SCRIPT_DIRECTORY,
  'github-top-repositories-with-summary-vectors.json'
);
const CHECKPOINT_INTERVAL = 10;
const MAX_RETRIES = 5;
const REQUEST_DELAY_MS = Number(process.env.GEMINI_REQUEST_DELAY_MS ?? 50);
const API_KEY = process.env.GEMINI_API_KEY ?? process.env.API_KEY;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getReadmeHash(readme) {
  return createHash('sha256').update(readme).digest('hex');
}

async function readExistingResults() {
  try {
    const contents = await fs.readFile(OUTPUT_FILE, 'utf8');
    const results = JSON.parse(contents);
    if (!Array.isArray(results)) {
      throw new Error(`${path.basename(OUTPUT_FILE)} must contain a JSON array.`);
    }
    return results;
  } catch (error) {
    if (error.code === 'ENOENT') {
      return [];
    }
    throw error;
  }
}

async function summarizeWithRetry(readme, repositoryName) {
  for (let attempt = 0; attempt < MAX_RETRIES; attempt += 1) {
    try {
      return await summarizeReadme(readme, API_KEY);
    } catch (error) {
      const isRetryable =
        error.status === 429 || (error.status >= 500 && error.status <= 599);
      if (!isRetryable || attempt + 1 === MAX_RETRIES) {
        throw new Error(`${repositoryName}: ${error.message}`, { cause: error });
      }

      const retryAfterSeconds = Number(error.retryAfter);
      const waitMs = Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? retryAfterSeconds * 1000
        : Math.min(120_000, 5_000 * 2 ** attempt);
      console.warn(
        `${repositoryName}: Gemini returned HTTP ${error.status}; retrying in ` +
        `${Math.ceil(waitMs / 1000)} seconds (${attempt + 2}/${MAX_RETRIES}).`
      );
      await sleep(waitMs);
    }
  }

  throw new Error(`Could not summarize ${repositoryName}.`);
}

function getOutputRepository(repository, summary, vector, readmeHash) {
  return {
    rank: repository.rank,
    name: repository.name,
    fullName: repository.fullName,
    owner: repository.owner,
    stars: repository.stars,
    url: repository.url,
    description: repository.description,
    language: repository.language,
    readmeHash,
    summary,
    vector,
  };
}

async function main() {
  if (!API_KEY) {
    throw new Error('Set API_KEY or GEMINI_API_KEY before generating the summary dataset.');
  }
  if (!Number.isFinite(REQUEST_DELAY_MS) || REQUEST_DELAY_MS < 0) {
    throw new Error('GEMINI_REQUEST_DELAY_MS must be a non-negative number.');
  }

  const repositories = JSON.parse(await fs.readFile(INPUT_FILE, 'utf8'));
  if (!Array.isArray(repositories)) {
    throw new Error(`Expected an array in ${INPUT_FILE}`);
  }

  const existingResults = await readExistingResults();
  const existingByName = new Map(
    existingResults
      .filter((repository) => repository?.fullName)
      .map((repository) => [repository.fullName.toLocaleLowerCase(), repository])
  );
  const results = [];

  try {
    for (let index = 0; index < repositories.length; index += 1) {
      const repository = repositories[index];
      const name = repository.fullName;
      const canonicalName = name.toLocaleLowerCase();
      const readme = typeof repository.readme === 'string' ? repository.readme.trim() : '';
      const readmeHash = readme ? getReadmeHash(readme) : null;
      const existing = existingByName.get(canonicalName);
      let result;

      if (!readme) {
        console.log(`${index + 1}/${repositories.length}: ${name} (no README; skipping)`);
        result = getOutputRepository(repository, null, null, null);
      } else if (
        existing?.readmeHash === readmeHash &&
        typeof existing.summary === 'string' &&
        Array.isArray(existing.vector)
      ) {
        console.log(`${index + 1}/${repositories.length}: ${name} (reusing summary and vector)`);
        result = getOutputRepository(
          repository,
          existing.summary,
          existing.vector,
          readmeHash
        );
      } else {
        console.log(`${index + 1}/${repositories.length}: ${name} (summarizing README)`);
        const summary = await summarizeWithRetry(readme, name);
        const vector = await embedText(summary);
        if (
          vector.length === 0 ||
          !vector.every(Number.isFinite) ||
          vector.every((value) => value === 0)
        ) {
          throw new Error(`Generated an invalid summary embedding for ${name}.`);
        }
        result = getOutputRepository(repository, summary, vector, readmeHash);
        if (REQUEST_DELAY_MS > 0) {
          await sleep(REQUEST_DELAY_MS);
        }
      }
      results.push(result);
      existingByName.set(canonicalName, result);

      if (
        (index + 1) % CHECKPOINT_INTERVAL === 0 ||
        index + 1 === repositories.length
      ) {
        await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
        console.log(`Checkpoint saved: ${results.length}/${repositories.length}`);
      }
    }
  } catch (error) {
    if (results.length > 0) {
      await fs.writeFile(OUTPUT_FILE, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
      console.log(`Progress saved: ${results.length}/${repositories.length}`);
    }
    throw error;
  }

  console.log(`Saved ${results.length} repositories to ${OUTPUT_FILE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

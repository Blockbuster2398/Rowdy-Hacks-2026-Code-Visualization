// https://www.npmjs.com/package/word2vec

import { pipeline } from '@huggingface/transformers';

let extractorPromise;

function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
      .catch((error) => {
        extractorPromise = undefined;
        throw error;
      });
  }

  return extractorPromise;
}

export async function embedTexts(texts) {
  const extractor = await getExtractor();
  const output = await extractor(texts, { pooling: 'mean', normalize: true });
  return output.tolist();
}

export async function embedText(text) {
  const [vector] = await embedTexts([text]);
  return vector;
}

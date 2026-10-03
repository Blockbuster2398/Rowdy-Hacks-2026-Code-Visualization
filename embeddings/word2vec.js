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

export async function embedText(text) {
  const extractor = await getExtractor();
  const output = await extractor(text, { pooling: 'mean', normalize: true });
  return output.tolist()[0];
}

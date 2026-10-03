// https://www.npmjs.com/package/word2vec

import { pipeline } from '@huggingface/transformers';

const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

export async function embedText(text) {
  const output = await extractor(text, { pooling: 'mean', normalize: true, dtype: "float16" });
  return output.tolist()[0];
}
//Test
//console.log(await(embedText("fjkejjwelkfe")))

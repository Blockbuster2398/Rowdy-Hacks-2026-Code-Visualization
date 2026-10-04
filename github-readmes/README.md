# README summary embeddings

The similarity map can compare repositories using either their original README
text or Gemini-generated README summaries. Summary vectors use the same local
MiniLM model as the original vectors, so both datasets have compatible vector
dimensions while representing different source text.

To build the parallel summary dataset, set a Gemini API key and run:

```powershell
$env:API_KEY="your-gemini-api-key"
npm run build:summary-vectors
npm run build:summary-graph
```

The generator accepts either `API_KEY` or `GEMINI_API_KEY`.

The vector-generation step reads `github-top-repositories.json` and writes
`github-top-repositories-with-summary-vectors.json`. It checkpoints every ten
repositories and reuses summaries and vectors when the source README has not
changed, so it can be rerun after interruptions. If Gemini returns no summary
for an individual README, that repository is logged, saved without a vector,
and skipped so generation can continue; rerunning the script retries it. Other
API errors stop generation after saving progress. Gemini requests are made one
at a time with a default 250 ms delay; set `GEMINI_REQUEST_DELAY_MS` to change it.
The graph-generation step writes
`public/repository-summary-embeddings.json` and verifies that its repository
IDs are a subset of `public/repository-embeddings.json`. The summary comparison
mode works with any non-empty subset of completed summaries; repositories
without summary vectors are omitted until the dataset is regenerated with those
summaries.

Both graph datasets must be deployed for users to switch between comparison
modes. The Gemini API key is only needed for dataset generation and for
summarizing READMEs users add at runtime; it is not included in either output
file.

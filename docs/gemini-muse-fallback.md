# Gemini to Muse fallback

When Meta Muse is configured, a failed Gemini generation request now switches to
Muse regardless of the Gemini error code. Caller cancellation still stops the
request. The existing structured response validation remains in place, so an
invalid Muse answer cannot become a skill or exercise.

Material summaries also switch to Muse after a Gemini failure. Skill duplicate
review uses Muse to identify possible matches if the Gemini embedding request
fails. Muse matches are limited to known skill IDs and remain possible matches
for review; they are never stored as Gemini vectors.

[Meta's Model API](https://dev.meta.ai/docs/overview) does not expose a compatible embedding endpoint.
When Gemini material retrieval produces no semantic matches or some selected
chunks have no embeddings, the planner gives
Muse the text, headings, IDs, and locators for every stored chunk and OCR-ready
page in the structurally selected scope. Muse scores each passage; the server requires one
valid score for every supplied ID before using any result. Requests use groups
of at most 120 chunks or 180,000 source characters, with no more than three
groups in flight. A scope needing more than 24 groups does not trigger an
unbounded scan. If Muse fails or the scope exceeds that budget, lexical
retrieval remains available and the proposed plan warns that source coverage
may be incomplete. Chunks without Gemini embeddings stay unembedded.

This scan covers extracted text and OCR-ready pages in the selected scope. It
cannot recover text that ingestion and page OCR did not extract, and a complete scan does not
guarantee that Muse judged every passage correctly. Existing evidence checks
still require cited chunk IDs and source-grounded skill plans. Unsupported
source media and missing Muse configuration remain explicit failure cases.

The production worker needs `META_API_KEY`, `META_MUSE_MODEL`, and
`META_MUSE_BASE_URL` in its configuration. A merge alone does not update the
running Lambda artifact. Check the deployed artifact and CloudWatch's
`[ai] retrying with fallback provider` and `[ai] meta muse request succeeded`
events after deployment.

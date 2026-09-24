# Gemini to Muse fallback

When Meta Muse is configured, a failed Gemini generation request now switches to
Muse regardless of the Gemini error code. Caller cancellation still stops the
request. The existing structured response validation remains in place, so an
invalid Muse answer cannot become a skill or exercise.

Material summaries also switch to Muse after a Gemini failure. Skill duplicate
review uses Muse to identify possible matches if the Gemini embedding request
fails. Muse matches are limited to known skill IDs and remain possible matches
for review; they are never stored as Gemini vectors.

[Meta's Model API](https://dev.meta.ai/docs/overview) does not expose a compatible embedding endpoint. Material chunk
embedding failures therefore retain the existing lexical retrieval path, and
chunks without embeddings stay unembedded. Generating 768 numbers with Muse
would corrupt similarity results because those numbers would not share Gemini's
vector space. Unsupported source media and missing Muse configuration also
remain explicit failure cases.

The production worker needs `META_API_KEY`, `META_MUSE_MODEL`, and
`META_MUSE_BASE_URL` in its configuration. A merge alone does not update the
running Lambda artifact. Check the deployed artifact and CloudWatch's
`[ai] retrying with fallback provider` and `[ai] meta muse request succeeded`
events after deployment.

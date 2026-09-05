# AI Skill Generation Production Readiness Plan

Status: code-side foundation implemented; human audit, canary, and retention gates remain open.

Last updated: 2026-08-31

## Purpose

LearnRecur should not be a content generator that happens to schedule its output. It
should be a dependable memory system that turns a learner's source material into
well-defined skills, tests those skills with trustworthy retrieval practice, and
uses the resulting evidence to schedule the next review efficiently.

This document covers the full AI-assisted path:

1. Understand the learner's source and requested scope.
2. Propose useful, narrow skills.
3. Turn each accepted skill into an explicit practice specification.
4. Plan a varied exercise inventory.
5. Generate candidate exercises and explanations.
6. Verify correctness, source fidelity, clarity, and learning value.
7. Publish only accepted exercises to the ready queue.
8. Select exercises that produce useful evidence for the scheduled skill.
9. Learn from flags, edits, and aggregate practice outcomes without allowing bad
   items to corrupt the learner's schedule.

The plan covers both source-to-skill generation and skill-to-exercise generation.
It does not propose runtime AI grading. Ordinary answer submission must remain
instant and deterministic.

## Product Standard

A production-ready generated skill must be:

- **Useful:** worth remembering and capable of supporting repeated retrieval.
- **Atomic:** narrow enough that one review result has a clear meaning.
- **Durable:** broader than one memorized question but not a compound course unit.
- **Source-faithful:** grounded in the learner's material when a source exists.
- **Objectively testable:** compatible with a deterministic answer contract.
- **Varied:** capable of producing materially different prompts without changing
  the target skill.
- **Efficient:** tested with the shortest exercise that yields valid memory
  evidence.
- **Explainable:** the learner can see what is being tested and why an answer is
  correct.

A production-ready exercise must be:

- Factually and mathematically correct.
- Internally consistent across prompt, quantities, choices, answer, and
  explanation.
- Supported by the skill specification and source evidence.
- Unambiguous, fair, and answerable from the prompt.
- Deterministically gradable.
- Appropriately difficult for its role in the skill's progression.
- Different enough from recent exercises to test the skill rather than memory of
  an item.
- Free of accidental clues, implausible distractors, and avoidable cognitive
  overhead.

"Verified" must mean that all required gates passed. It must never mean only that
an AI verifier returned the word `verified`.

## Current Foundations To Preserve

The repository already has important pieces of the right architecture:

- Skills, rather than individual exercises, are the FSRS-scheduled unit.
- Skill drafts expose title, objective, rules, examples, constraints, and tags for
  learner review.
- Uploaded source files and material references can travel with generation and
  verification requests.
- Gemini is the primary provider and Meta Muse is the direct fallback.
- Provider calls use structured response schemas.
- Generated outputs receive deterministic shape and answer-spec validation.
- Math display answers are checked against accepted expressions.
- Exact duplicate filtering runs before publication.
- A separate model verification call can reject candidates.
- Only verified, non-retired exercises are eligible for practice.
- Generation jobs are asynchronous, bounded, and recorded with provider, model,
  prompt version, counts, and status.
- Bad exercises can be flagged and retired.
- Practice does not wait for a model call, and answer grading remains
  deterministic.

These are foundations, not proof of production quality. Most current checks are
stronger at workflow and schema integrity than at semantic correctness, source
entailment, learning value, or model-release safety.

## Triggering Incident: Gemini Semantic Inconsistency

The 2026-08-31 live production-shaped smoke test used the actual choice-exercise
generators, strict provider response schemas, a 3,557-character prompt, a
source-backed statistics skill, and existing-exercise context.

- The historical `gemini-3.7-flash` probe returned five structurally valid exercises.
- The historical `muse-spark-1.2` probe returned five structurally valid exercises.
- The current deterministic response validator accepted all ten candidates.
- One Gemini candidate said that 95% of sampled volunteers supported an
  initiative while also giving a confidence interval of `(0.65, 0.75)`. The
  interval is centered at 70%, so the premise was internally inconsistent.

This is a useful counterexample. It demonstrates that model availability, valid
JSON, a valid answer choice, and a plausible explanation do not establish that an
exercise is correct.

Before the model update is considered production-ready, this exact defect should
become a permanent regression case and the complete production verifier should be
tested against it. The branch should not be promoted solely on the successful live
response and schema-validation result.

## Target Pipeline

The target path should be explicit and inspectable:

1. **Ingest and inventory evidence.** Preserve source structure, exact locators,
   extraction confidence, figures, tables, and relevant original media.
2. **Resolve scope.** Identify what the learner asked to retain and what is outside
   scope.
3. **Create a versioned skill specification.** Define the target capability,
   boundaries, prerequisites, misconceptions, answer modes, and evidence anchors.
4. **Run the skill-readiness gate.** Split, merge, reject, or request clarification
   before generating exercises.
5. **Create an exercise blueprint.** Allocate cognitive operations, difficulty,
   exercise types, source facets, and misconception coverage.
6. **Generate more candidates than are needed.** Candidate generation is
   disposable; publication is not.
7. **Run deterministic checks.** Validate structure, answer contracts, numeric and
   symbolic relationships, source locators, and exact duplicates.
8. **Run an independent solve-first verifier.** Solve the item without seeing the
   proposed answer first, then compare the independent result with the candidate.
9. **Run source and learning-quality checks.** Confirm support, scope, clarity,
   distractor quality, novelty, and appropriate difficulty.
10. **Adjudicate uncertainty.** Use a second provider or manual review only when
    risk or disagreement justifies it.
11. **Publish atomically.** Only candidates with a complete acceptance record enter
    the ready queue.
12. **Monitor use.** Quarantine flags quickly, measure item behavior, and feed
    adjudicated defects back into evals.

## Priority 0: Required Before Serious Production Use

### 1. Fix Semantic Correctness Verification

The first implementation slice should address the Gemini counterexample and the
general class it represents.

Required changes:

- Add the confidence-interval contradiction as a seeded failing fixture.
- Test whether the current live verifier rejects it; record the result rather than
  assuming the second model call catches it.
- Make verification **solve first**:
  1. Give the verifier the prompt and choices without the generated answer.
  2. Require an independent answer or an explicit `not_objectively_answerable`
     result.
  3. Compare that answer with `correctChoiceId`, `answerSpec`, and
     `correctAnswerDisplay` deterministically.
  4. Audit the explanation and source support only after the answer comparison.
- Add an explicit `premisesConsistent` decision. A correct answer to a broken
  premise is still a rejected exercise.
- Require evidence for every verification dimension: answer match, premise
  consistency, source alignment, scope, explanation, ambiguity, and distractor
  quality.
- Treat uncertainty as rejection. Model confidence may help route review, but it
  must never override a failed invariant.
- Separate generator and verifier roles. Use a fresh call and prompt, and evaluate
  whether a different model/provider materially reduces correlated errors.
- Route disagreements and high-risk items to cross-provider adjudication rather
  than automatically trusting either provider.
- Regenerate only the rejected coverage slots, with bounded attempts and the
  rejection reason included as structured repair context.

Deterministic consistency checks should be added where the domain permits them:

- Numeric quantities, ranges, percentages, signs, units, and rounding.
- Interval midpoint, width, and margin-of-error relationships.
- Arithmetic and algebraic recomputation.
- Choice ID, answer display, answer spec, and explanation agreement.
- Text-answer accepted variants and normalization behavior.
- Impossible, missing, or contradictory givens.

Do not attempt to build one universal symbolic reasoner for every subject. Start
with a small invariant registry for supported exercise families and fail closed
when an exercise claims a family whose invariants cannot be checked.

Acceptance criteria:

- The triggering Gemini candidate is rejected for premise inconsistency.
- Every accepted multiple-choice item has an independently reproduced answer.
- Every accepted numeric or math item passes deterministic recomputation.
- Explanations cannot contradict the accepted answer or source evidence.
- The same tests run separately against Gemini and Meta Muse.

### 2. Introduce A Versioned Skill Specification

The current title, objective, rules, examples, constraints, and tags are a useful
draft UI, but they are not yet a complete generation contract.

Each skill needs a versioned internal specification containing:

- The exact durable capability the learner should retrieve or apply.
- Positive scope and explicit exclusions.
- Prerequisite skills or assumed knowledge.
- Canonical rules, definitions, procedures, and exceptions.
- Common misconceptions and attractive wrong paths.
- Source evidence anchors for each substantive claim.
- Allowed exercise types and deterministic answer kinds.
- Disallowed question forms or assumptions.
- A progression from basic retrieval to transfer.
- Difficulty dimensions, rather than one unexplained 1-5 number.
- Expected response-time ranges by exercise family.
- Examples and non-examples.
- A minimum exercise-coverage plan.
- A version and fingerprint that invalidate stale exercises when meaning changes.
- An explicit list of unresolved ambiguities, with learner clarification requested
  only when the answer would materially change the skill.

Skill-readiness checks should reject or repair drafts that are:

- Too broad to interpret one review result.
- So narrow that the learner can memorize one answer instead of the skill.
- Compound skills joined by "and" without a justified shared retrieval target.
- Subjective or not deterministically gradable in V1.
- Redundant with an existing skill.
- Unsupported by the selected source scope.
- Missing a useful variation space.
- Better represented as a prerequisite, lesson, reference note, or one-off fact.

Acceptance criteria:

- Every active generated skill references an immutable specification version.
- Existing exercises state which specification version they test.
- Material changes retire or revalidate affected exercises.
- Cosmetic edits do not unnecessarily reset the learner's schedule.

### 3. Make Source Evidence A First-Class Contract

Source context should be assembled from evidence, not from convenient text
lengths.

Required changes:

- Create a context manifest for every generation and verification stage.
- Record source file/revision IDs, exact page or section locators, selected chunk
  IDs, media attachments, extraction confidence, and content hashes.
- Require evidence anchors for the skill definition, each exercise's governing
  rule, the correct answer, and the explanation.
- Distinguish source-derived content, pedagogical transformations, and verified
  supplements.
- Detect missing pages, low-confidence OCR, unreadable notation, absent figures,
  and incomplete tables before generation.
- Do not silently omit relevant evidence to fit a context window. Narrow the
  scope, retrieve a better slice, or stop with a useful error.
- Keep extracted text supplemental when the original image or PDF is authoritative.
- Preserve exceptions and qualifications instead of retrieving only the most
  semantically obvious paragraph.
- Treat all source text as untrusted data and keep instructions outside the source
  boundary.
- Never log full private source content. Logs should contain IDs, hashes, counts,
  and redacted diagnostics.

The current fixed character caps may remain as transport safeguards, but they
cannot serve as the evidence-selection policy.

For description-only skills without an uploaded source, preserve the user's stated
rules and examples as the declared authority. Do not silently convert model world
knowledge into source-backed fact. Any added factual content should use a vetted
reference or require explicit learner confirmation and carry a different
provenance class.

Acceptance criteria:

- Every source-backed accepted item can answer, "What source evidence supports
  this answer?"
- Missing or truncated required evidence blocks publication.
- Re-running against the same skill specification and source revision produces an
  equivalent context manifest.

### 4. Plan Exercise Coverage Before Generating Wording

Asking a model for five good exercises in one unconstrained batch encourages
repetition and leaves coverage to chance.

Create an exercise blueprint first. Each requested slot should specify:

- Skill-spec facet being tested.
- Cognitive operation: recall, discrimination, procedure, interpretation, or
  transfer.
- Exercise and answer type.
- Difficulty dimensions.
- Source anchor.
- Intended misconception or distractor rationale.
- Novelty requirements relative to recent exercises.
- Whether the item is scaffolded learning-time practice or independent retention
  evidence.

Candidate generation should overgenerate modestly, validate each candidate, and
select a diverse subset that fulfills the blueprint. It should not publish the
first five schema-valid objects.

Acceptance criteria:

- Every generated batch has a coverage plan and reports filled, rejected, and
  unfilled slots.
- A batch cannot consist of five paraphrases of the same recognition question.
- Distractors correspond to real misconceptions or calculation errors, not random
  nonsense.
- Correct-choice position, length, tone, and specificity do not leak the answer.

### 5. Strengthen Deterministic Answer Contracts

The app should generate only exercises that its deterministic grading layer can
represent faithfully.

Required changes:

- Define a capability registry for each supported answer kind and exercise family.
- Require a deterministic solution/checker result before an item can be accepted.
- Validate all accepted values, tolerances, units, normalization settings, and
  symbolic-equivalence limits.
- Detect multiple defensible choices and accepted-answer sets that are too narrow.
- Require the displayed answer to be one of the deterministically accepted answers.
- Keep the answer explanation downstream of the verified answer, not an alternate
  source of truth.
- Reject tasks involving proof, essays, diagrams, subjective judgment, or hidden
  assumptions until a trustworthy grading contract exists.

For multiple choice, deterministic grading of the selected ID is necessary but
not sufficient. The system must also establish that exactly one choice is
defensible.

### 6. Build A Real Evaluation And Release Gate

Model and prompt changes need an eval process before deployment.

The eval corpus should cover:

- Skill drafting, splitting, merging, and scope boundaries.
- Multiple-choice, text, numeric, and math exercises.
- Pasted text, clean PDFs, scanned PDFs, images, tables, and mixed evidence.
- Spanish grammar, arithmetic/fractions, algebra, statistics, biology
  classification, and history distinctions.
- Long context, noisy OCR, missing context, conflicting passages, and source
  prompt injection.
- Easy, medium, and difficult skills.
- Duplicate and near-duplicate pressure after repeated refills.
- Primary generation, fallback generation, primary verification, fallback
  verification, and the actual provider-handoff path.

Seed the corpus with known defects:

- Internally inconsistent quantities.
- Wrong answers with plausible explanations.
- Correct answers supported by an invalid premise.
- Multiple correct choices.
- Weak or giveaway distractors.
- Explanation-answer disagreement.
- Unsupported source claims and invented exceptions.
- Compound or untestable skills.
- Exact and semantic duplicates.
- Unit, sign, rounding, and normalization errors.
- Ambiguous pronouns, negation, and answer format.
- Instructions embedded in untrusted source text.

Every release candidate should run multiple trials because one successful sample
does not characterize a stochastic model.

Initial release gates should include:

- Zero schema or deterministic-answer failures among accepted items.
- Zero critical defects in the held-out release corpus.
- At least 99% recall on seeded critical defects before the verifier is trusted as
  an automated gate.
- At least 95% of accepted items rated useful without material edits in a blind
  human audit, with correctness and usefulness scored separately.
- Separate passing results for the primary and fallback providers.
- No statistically meaningful regression in latency, accepted yield, or cost.
- A stored, reproducible eval report tied to model, prompt, schema, and validator
  versions.

Before broad production, target a held-out audit of at least 1,000 accepted items
across the supported matrix with zero critical defects. If the sample is
representative, zero observed critical defects in 1,000 items places the rough 95%
upper bound on the true defect rate near 0.3%; it still does not prove perfection.

### 7. Treat Model Changes As Releases

Changing an environment variable can materially change product behavior.

Required changes:

- Pin model IDs; do not silently follow floating aliases in production.
- Version every generation, repair, and verification prompt independently.
- Version response schemas, deterministic validators, context builders, and
  skill-spec schemas.
- Record the complete version tuple on every candidate and accepted exercise.
- Run the full eval matrix separately for each provider/model configuration.
- Shadow new configurations on synthetic or approved test material before they
  can serve learners.
- Canary a small percentage of generation jobs with automatic stop conditions.
- Keep instant rollback to the last passing version tuple.
- Run recurring synthetic canaries through both providers using production
  schemas, without private learner data.
- Alert on model-not-found errors, schema failures, semantic rejection spikes,
  fallback spikes, latency, and token/cost changes.

The fallback must meet the same quality bar as the primary. A fallback response is
not acceptable merely because the primary failed and the fallback returned JSON.

### 8. Expand Generation Records Into An Audit Trail

`GenerationJob` records useful top-level state, but production diagnosis needs
candidate- and stage-level evidence.

Add an append-only generation audit contract containing:

- Job, stage, attempt, and candidate IDs.
- Provider, exact model, endpoint mode, and fallback reason.
- Prompt, schema, validator, context-builder, and skill-spec versions.
- Context-manifest hash and source revision IDs.
- Requested blueprint slot and exercise family.
- Latency, token counts, estimated cost, finish reason, and retry category.
- Structural, deterministic, source, semantic, duplicate, and diversity decisions.
- Rejection reason codes and repair ancestry.
- Final publication or quarantine decision.

Do not put raw private source material or credentials in operational logs. If raw
model inputs/outputs are retained for debugging, they need explicit retention,
access, encryption, deletion, and export policies.

Start lean: a versioned JSON decision envelope attached to job/candidate records
may be enough before normalizing every stage into separate tables.

### 9. Harden Jobs, Retries, And Queue Availability

The background pipeline should distinguish provider reliability from content
quality.

Required changes:

- Use explicit stage states rather than one opaque running state.
- Make claims and publication idempotent under retry, timeout, and duplicate event
  delivery.
- Retry transient transport/capacity errors, not malformed requests or semantic
  failures.
- Keep provider availability fallback separate from semantic repair and
  adjudication. A quality rejection is not a transport outage.
- Repair rejected candidates by slot; do not rerun successful work unnecessarily.
- Cap model attempts, elapsed time, tokens, and cost per skill/job.
- Add provider circuit breakers and bounded concurrency.
- Reconcile jobs stranded in running states.
- Preserve partial accepted results without publishing an under-covered batch.
- Keep enough verified inventory that ordinary practice never waits for recovery.
- Add dead-letter visibility and an operator-safe retry path.
- Test actual fallback handoff, timeout budgets, cancellation, and transaction
  races end to end.

Queue availability and content quality must be separate SLOs. The system should
prefer a temporarily smaller trustworthy queue over filling it with questionable
items.

### 10. Protect The Learner From Quality Incidents

The learner needs a fast, comprehensible trust loop.

Required changes:

- Show a concise source-linked explanation after submission.
- Add rationale for the learner's selected distractor where it can be generated and
  verified ahead of time.
- Let the learner flag wrong answer, unclear prompt, unfairness, stale content,
  off-topic content, or low usefulness with minimal interruption.
- Retire a flagged exercise immediately from future selection while it is reviewed.
- Quarantine related exercise-family/model/prompt combinations when a confirmed
  defect suggests a systemic pattern.
- Record whether a bad exercise already changed FSRS state.
- Provide a deterministic way to invalidate the affected review and recompute the
  skill schedule from valid review history after a confirmed defect.
- Exclude contested attempts from item calibration and model-quality labels.
- Turn confirmed incidents into eval fixtures and track time to containment.
- Give the learner a clear correction when LearnRecur was wrong.

A learner flag is a signal, not automatic proof that the answer key is wrong. The
system should contain the item immediately, then adjudicate it without allowing an
unresolved item to keep affecting other learners.

### 11. Enforce Privacy And Source-Safety Boundaries

Required changes:

- Send only the evidence required for the current bounded task.
- Do not send a source to the fallback provider until fallback is actually needed,
  except for approved synthetic evals.
- Maintain `store: false` or the provider-equivalent no-retention setting where
  available and verify the provider contract separately.
- Make provider use visible in privacy documentation and user controls.
- Redact logs and traces by construction.
- Propagate source deletion through derived context artifacts and retained debug
  payloads.
- Keep prompt-injection tests in every provider eval.
- Give generation models no tools, network retrieval, or write authority unless a
  future feature explicitly requires and constrains it.
- Validate MIME type, file size, media count, and source ownership before provider
  calls.
- Avoid passing raw learner attempt history when a derived mastery summary is
  sufficient.

## Priority 1: Required For Outstanding Learning Quality

### 12. Optimize For Retrieval, Not Content Variety

Exercise variety is valuable only when it produces better evidence about the same
skill.

The blueprint should intentionally progress through:

1. Discrimination or recognition when the learner is new or uncertain.
2. Cued recall with fewer supports.
3. Exact recall, numeric work, or symbolic production.
4. Application in a changed surface context.
5. Interleaved discrimination from nearby skills.
6. Delayed transfer that still tests the same specification.

Avoid:

- Five paraphrases that share the same answer cue.
- Recognition-only practice after the learner can retrieve independently.
- Novelty that changes the tested skill.
- Excess reading load unrelated to the target.
- Artificial difficulty from tricky wording.
- Explanations so long that review becomes a lesson every time.

### 13. Connect Generation To The Skill's Memory State

The roadmap expects current mastery, desired difficulty, freshness, and exercise
mix in generation inputs. The current generator contract does not fully carry or
use those signals.

Add a derived, privacy-minimized generation profile containing:

- Current FSRS state and stability band.
- Number and recency of valid independent reviews.
- Recent exercise families and surface features.
- Recent failure modes and misconceptions.
- Current answer-type eligibility.
- Desired difficulty and exercise-type mix.
- Whether the next item is learning-time support or retention evidence.

Keep scheduling and item selection conceptually separate:

- FSRS decides **when the skill is due**.
- The exercise selector decides **which accepted item will best test it now**.
- The quality of evidence determines **how much the attempt should influence the
  schedule**.

Model-predicted difficulty and expected seconds are only priors. Calibrate them
from valid aggregate attempts, stratified by subject and exercise family, and do
not treat fast guessing as strong memory evidence.

### 14. Distinguish Learning Evidence From Assisted Completion

If future learning-time practice includes hints, retries, worked examples, or
answer reveals, record the assistance explicitly.

- A cold correct answer is stronger evidence than a correct retry after a hint.
- A worked example followed immediately by an isomorphic question is learning
  evidence, not yet durable retention evidence.
- Guided Demo-Duo-Solo work should not be counted as an independent question
  attempt unless it was administered cold and cue level was recorded.
- Hints and retries should help the learner without falsely advancing mastery.
- Skills can enter scheduling early, but weak or assisted evidence should produce
  an earlier review rather than a mastery claim.

### 15. Build Exercise Families And Diversity Controls

Represent related exercises as families with controlled variation dimensions:

- Numbers, names, contexts, grammatical subjects, or surface forms.
- Misconception targeted.
- Cognitive operation.
- Difficulty dimension.
- Answer type.
- Source/example lineage.

Use parameterized or deterministic templates where they improve correctness and
cost. Use AI for blueprinting, language realization, and novel examples where it
adds value. A hybrid generator is likely more reliable than asking an LLM to
invent every field from scratch.

Add semantic novelty checks across:

- The current batch.
- The skill's recent ready and retired exercises.
- Closely related skills where confusion is likely.
- The same exercise family with different superficial values.

### 16. Improve Explanations And Corrective Feedback

Pre-generated feedback should:

- State the governing rule or reasoning step concisely.
- Explain why the correct answer follows.
- Address the intended misconception without insulting the learner.
- Use the source's terminology and link to the relevant location.
- Separate source-derived explanation from verified supplement.
- Avoid introducing unsupported facts or a second ambiguous interpretation.
- Include per-choice rationale only when each rationale is independently verified.

Explanation quality needs its own eval score. A correct answer paired with a
misleading explanation is a critical defect.

### 17. Handle Skill Evolution Deliberately

Define what happens when the source, skill, or generation policy changes.

- Source revision changes trigger evidence re-resolution and targeted
  revalidation.
- Meaningful skill-spec changes create a new version and retire incompatible
  exercises.
- If the retrieval target is materially different, create a new skill rather than
  silently inheriting the old FSRS state.
- Prompt/model changes do not automatically invalidate old exercises; revalidate
  based on risk and incident evidence.
- Preserve audit history so a learner's past schedule remains explainable.

### 18. Add Subject Capability Profiles

Keep a general skill schema, but do not pretend every subject has the same quality
controls.

Start with a small set of capability profiles:

- **Symbolic/numeric:** arithmetic, fractions, basic algebra, units, tolerances.
- **Language form:** accepted variants, diacritics, inflection, context, and
  grammatical ambiguity.
- **Conceptual/source-grounded:** definitions, classifications, distinctions, and
  interpretations with evidence anchors.

Each profile should define allowed answer kinds, deterministic checks, common
failure modes, eval cases, and publication restrictions. Unsupported profiles
should remain draft/manual rather than being forced through a generic prompt.

## Priority 2: Add After Reliable Production Data Exists

### 19. Calibrate Items From Aggregate Outcomes

After enough trustworthy attempts exist:

- Compare predicted and observed difficulty.
- Measure response-time distributions without hidden-tab contamination.
- Detect items that are too easy, misleading, or non-discriminating.
- Detect unusual wrong-answer concentrations that suggest a bad key or ambiguous
  distractor.
- Retire or review anomalous items before they create many flags.
- Use hierarchical estimates so a new skill can borrow cautiously from its subject
  and exercise family.

Do not use raw learner accuracy as proof that an answer key is correct. Learners
can share the same misconception, and easy clueing can create high accuracy on a
bad item.

### 20. Optimize For Long-Term Retention Outcomes

Once correctness and trust are stable, run controlled experiments on:

- Recognition-to-recall progression.
- Interleaving nearby skills.
- Difficulty selection.
- Explanation length and timing.
- Source-style matching.
- Exercise-family spacing.
- Initial FSRS state derived from learning-time evidence.

Primary outcomes should be delayed independent retrieval and return-to-criterion,
not clicks, generated-item count, or immediate accuracy alone.

### 21. Add Expert-Guided Active Learning For Evals

Use confirmed flags and reviewer disagreements to choose the next eval cases and
validator work. Prioritize high-severity, recurring defect families over broad
prompt tweaking. Keep eval labels human-reviewed and versioned.

## Proposed Data And Contract Updates

The exact schema should remain lean, but the following concepts need durable
representation:

| Current concept | Needed addition | Why |
| --- | --- | --- |
| `Skill` | Versioned skill specification and readiness decision | Exercises need a stable, testable contract. |
| `SkillSourceRef` | Field- and exercise-level evidence anchors | File-level provenance cannot prove a generated answer. |
| `Exercise` | Skill-spec version, family, blueprint slot, provenance, and acceptance record | A binary verification status hides how trust was established. |
| `GenerationJob` | Stage attempts, version tuple, context manifest, cost/latency, and retry category | Top-level success cannot diagnose model or gate failures. |
| Verifier output | Independent answer, premise consistency, source support, and per-gate decisions | `verified/rejected` alone is too weak and too easy to anchor. |
| `ExerciseFlag` | Incident adjudication and schedule-correction status | Confirmed bad items must be contained and repaired. |
| No current equivalent | Eval case, eval run, model release, and canary result | Model/prompt changes need reproducible release evidence. |
| No current equivalent | Exercise family and calibrated item statistics | Diversity and difficulty need more than prompt hashes. |

Prefer append-only decision records and versioned JSON contracts initially. Add
normalized tables only when query, retention, or integrity requirements justify
them.

## Quality Metrics And SLOs

Track metrics separately by provider, model, prompt version, subject profile,
answer kind, source modality, and generation stage.

### Correctness And Trust

- Critical defect rate among human-audited accepted exercises.
- Seeded-defect recall and false-accept rate for each verifier/gate.
- Deterministic-answer failure rate.
- Source-support and locator coverage.
- Learner-reported incorrect-answer and ambiguity rates after adjudication.
- Time from confirmed defect to quarantine and eval-fixture creation.

### Learning Quality

- Human usefulness and clarity ratings.
- Skill draft acceptance and material-edit rate.
- Exercise-family and cognitive-operation coverage.
- Semantic duplicate rate.
- Delayed independent retrieval, not only immediate correctness.
- Performance after transfer to a new surface form.

### Reliability

- Ready-queue availability when a skill is due.
- Generation and verification success by stage.
- Fallback frequency and fallback acceptance yield.
- P50/P95 latency, retries, timeouts, and stranded jobs.
- Tokens and estimated cost per accepted exercise and active skill.

### Safety And Privacy

- Prompt-injection regression pass rate.
- Requests with missing evidence or silent truncation.
- Source deletion completion for derived artifacts.
- Sensitive-content leakage into logs or retained debug payloads.

## Required Test Layers

No single layer establishes production readiness.

1. **Unit tests:** schemas, answer contracts, invariants, context selection,
   deduplication, state transitions, retries, and failure messages.
2. **Property tests:** numeric ranges, accepted-answer normalization, generated
   parameters, and solver/display consistency.
3. **Golden evals:** human-reviewed skill drafts, exercises, explanations, and
   verifier decisions.
4. **Adversarial evals:** contradictions, ambiguity, injection, OCR corruption,
   missing figures, and misleading distractors.
5. **Live provider contract tests:** each model directly, each operation, each
   response schema, and the real fallback path.
6. **Database integration tests:** ownership, idempotency, candidate decisions,
   atomic publication, schedule repair, and cleanup.
7. **Background delivery tests:** retries, duplicate delivery, cancellation, timeout, partial
   completion, and recovery.
8. **Browser tests:** skill review, evidence display, generation failure, flagging,
   quarantine, and correction UX.
9. **Shadow/canary tests:** production configuration with synthetic or explicitly
   approved material before broad traffic.
10. **Human audit:** blind correctness and usefulness review across the supported
    domain matrix.

## Recommended Implementation Order

### Slice 1: Contain The Known Failure

- Add the Gemini incident fixture.
- Test the current full verifier against it.
- Add solve-first verification and deterministic cross-field checks.
- Prove both providers reject the fixture.
- Keep the model update out of production until this slice and the focused eval
  pass.

### Slice 2: Establish The Eval Harness

- Create versioned fixtures, graders, reports, and provider-specific runs.
- Add the initial cross-domain and adversarial matrix.
- Record baseline results for the old and new model configurations.
- Set release gates and rollback metadata.

### Slice 3: Introduce The Skill Specification

- Define and validate the versioned spec.
- Add atomicity, objective-gradability, and source-support gates.
- Migrate generation prompts to consume the spec.
- Revalidate or retire exercises when meaning changes.

### Slice 4: Add Blueprints And Candidate Decisions

- Plan coverage before wording.
- Overgenerate within strict budgets.
- Record per-candidate gate decisions.
- Select for correctness, coverage, and diversity.

### Slice 5: Harden Context And Provenance

- Add context manifests and exact evidence anchors.
- Remove silent evidence loss.
- Handle low-confidence OCR, tables, figures, and source revisions.
- Add privacy-preserving traceability.

### Slice 6: Harden Operations And User Recovery

- Add staged jobs, reconciliation, circuit breakers, canaries, and dashboards.
- Add incident adjudication, exercise quarantine, and FSRS schedule correction.
- Prove queue availability under provider failure.

### Slice 7: Improve Memory Efficiency

- Add mastery-aware blueprints and exercise selection.
- Calibrate difficulty and expected time.
- Add recognition-to-recall progression, interleaving, and transfer evaluation.
- Measure delayed retention before optimizing further.

Each slice should begin with failing tests or eval cases and end with a bounded,
reproducible evidence packet. Avoid a large rewrite of the existing generation
module.

## Explicit Non-Goals For This Work

- Runtime AI judgment after ordinary answer submission.
- Open-ended essay grading in V1.
- Supporting every academic subject equally at launch.
- A chat tutor as the primary practice interface.
- A large analytics or MLOps platform before the core eval loop works.
- Automatically accepting model-generated supplemental facts.
- Treating model confidence, learner accuracy, or a successful API response as
  correctness proof.
- Generating a full private source in one opaque prompt.
- Replacing FSRS with a custom scheduler before evidence shows a scheduling
  problem.

## Production Readiness Definition

The AI skill-generation process is ready for serious production only when:

- A learner-approved, versioned, source-supported skill specification exists.
- Every accepted exercise has complete structural, deterministic, semantic,
  source, duplicate, and quality decisions.
- The known Gemini contradiction and the full seeded-defect set are rejected.
- Primary and fallback configurations independently pass the release matrix.
- Full provider handoff and background-job recovery are tested.
- Model and prompt releases are versioned, canaried, observable, and reversible.
- A bad exercise can be quarantined quickly and its scheduling effect corrected.
- Private sources are minimized, traceable, deletable, and absent from logs.
- The learner can understand the answer, report a problem, and trust the correction.
- Real delayed-retrieval evidence shows that the generated practice helps people
  remember the intended skills.

Outstanding quality means going further: the system reliably chooses the smallest,
clearest, most varied exercise that yields useful independent evidence at the right
time, while preserving the learner's source and never pretending uncertainty is
knowledge.

## Implementation Status

The code-side foundation in this plan is implemented on the generation-hardening
branch: solve-first verification, deterministic semantic and answer checks,
versioned skill/blueprint/context contracts, memory-aware exercise planning,
source identity manifests, acceptance metadata, staged jobs, bounded retries and
concurrency, release/canary controls, redacted eval artifacts, live primary,
fallback and handoff tests, learner incident quarantine, and deterministic FSRS
replay. The operational procedure is in `docs/ai-skill-generation-operations.md`.

The statistical and human evidence gates remain intentionally open. A blind audit
of accepted exercises, the 1,000-item broad-production target, real canary traffic,
and delayed independent-retrieval outcomes require approved production samples
and human labels; they cannot be truthfully completed by code or synthetic model
calls. Priority 2 remains gated on that evidence, as specified above.

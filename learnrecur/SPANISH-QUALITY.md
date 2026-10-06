# Spanish generation trial

On October 5, 2026, three approved skills from chapters 14 and 15 of *Complete Spanish Step-by-Step, Premium Second Edition* passed a local generation and Mac review trial. All 12 generated exercises passed manual inspection. Import retries, offline review, report-and-skip, undo, restart, and automatic refill delivery also passed. One guidance gap remains: refills use a generated example instead of the original book examples.

## Material and scope

The source was Barbara Bregstein's 2020 edition. The user approved the definitions and six examples before submission, with a $1 spending limit. This covered three rules from two chapters, not the complete chapters.

| Skill | Chapter | Source examples |
| --- | --- | --- |
| Regular -ar verbs in the preterite | 14 | Exercise 14.1, items 2 and 4 |
| Regular -er and -ir verbs in the preterite | 14 | Exercise 14.1, items 1 and 14 |
| Regular -ar verbs in the imperfect | 15 | Exercise 15.1, items 7 and 15 |

Definitions used the rules on printed pages 235–237 and 257–258. Example answers were checked against the keys on pages 575–576. Each prompt specified the tense, subject, and infinitive and asked for one missing verb. Preterite skills excluded irregular verbs and stem or spelling changes. The imperfect skill covered habitual or ongoing past actions. None asked the learner to translate, select a pronoun, or choose between tenses.

The examples came from the book. Adaptations added explicit tense instructions, normalized blanks, and moved the imperfect exercise's separate reason question into the explanation. Explanations were written from the chapter rules. The PDF and example text remain outside Git.

## Generation and quality

The [import helper](../.agents/skills/learnrecur-import/SKILL.md) submitted the approved plan to a fresh authenticated local companion. Three jobs each generated three exercises using `gpt-6-luna` with `xhigh` reasoning. A later report requested one three-exercise refill. All four jobs completed on their first attempt, with exactly four provider submissions.

Every prompt, answer, and explanation was inspected against the approved rule. Checks covered correctness, one clear answer, scope, comparable difficulty, useful variation, and concise explanations. All nine initial items and three refill items passed. Prompts varied verbs, subjects, and contexts without copying the supplied examples or previous prompts. The small banks do not cover every grammatical person in each skill.

The four jobs reported 1,894 input tokens and 2,074 output tokens. The adapter's per-attempt usage estimates totaled **1,229 microusd ($0.001229)**, with no unsettled reservations. The trial configured no credits or discounts, so its gross and out-of-pocket estimates matched. Reservations stayed within the approved $1 ceiling. This is a usage-based estimate, not a provider invoice; [the provider notes](companion/OPENAI.md) explain the accounting limits.

## Mac workflow

The packaged app used its own disposable LearnRecur profile. **Tools > Import skills…** created three native cards. Repeating both helper submission and native import preserved those cards and the original jobs without another provider submission.

With the companion and worker stopped, native reveal, Again, Good, variation, and rating undo/redo worked from the cache. One correct exercise was deliberately reported with **Other** to test the workflow; it was not a quality failure. Report-and-skip showed the next eligible exercise on the same card with its answer hidden. Its revealed answer matched that replacement. Exact note, card, and review rows were unchanged by the report. Report undo/redo restored the appropriate question and exclusion.

Quitting and reopening offline preserved three cards, four review entries, the report, and its pending delivery record. Here, offline means the companion was unavailable and no worker was running. The Mac's general Internet access was not blocked.

On reconnect, the report was acknowledged and queued one refill. Entering the deck overview downloaded its completed batch automatically. The affected bank grew from three to six exercises; the other banks stayed at three. Exact card and review rows, original exercise content, and the active report were preserved. A final offline restart retained all 12 cached exercises and the same learner state.

## Limits and next step

This is a small manual sample of three conjugation rules. It does not establish quality for whole chapters, harder grammar, math, or long-term use. There was no independent instructor review, hosted trial, or new collection-sync or backup-restoration test. Earlier synthetic checks cover those other paths.

Initial generation received the six source examples. The refill retained the approved description but used one eligible cached exercise as its example. Original examples remain in the saved creation request; automatic refills do not use them. The next small slice should carry source examples into refills, with a fallback for skills that have none and checks for revisions, reports, and retry behavior. This would keep later generation anchored to the learner's material.

Private plans, provenance, provider receipts, quality judgments, and native state comparisons remain with the disposable trial. No textbook text, generated bank, credentials, collection, or private logs are committed. The trial app, companion, and worker are stopped. No Azure changes or personal Anki data were used. A daily-use trial and a second protected backup-key copy remain outstanding.

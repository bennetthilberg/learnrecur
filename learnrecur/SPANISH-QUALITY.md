# Spanish generation trials

On October 5, 2026, three approved skills from chapters 14 and 15 of *Complete Spanish Step-by-Step, Premium Second Edition* passed a local generation and Mac review trial. All 12 generated exercises passed manual inspection. Import retries, offline review, report-and-skip, undo, restart, and automatic refill delivery also passed. The trial found a refill-guidance bug, fixed in the follow-up described below.

An [editor trial on October 6](#editor-trial-on-october-6) checked three more skills from chapters 10 and 11. All 12 stored answers were correct within their definitions, but six initial prompts needed clearer instructions when shown as review cards. The actual provider requests, including the automatic refill, contained the saved book examples. These two trials cover six narrow skills and 24 generated exercises. A [follow-up](#standalone-prompt-follow-up-on-october-6) checks the revised generation instructions on the same three editor skills. None of these trials establishes daily-use readiness.

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

## Limits and follow-up

This is a small manual sample of three conjugation rules. It does not establish quality for whole chapters, harder grammar, math, or long-term use. There was no independent instructor review, hosted trial, or new collection-sync or backup-restoration test. Earlier synthetic checks cover those other paths.

Initial generation received the six source examples. The trial's refill retained the approved description but used one eligible cached exercise as its example. The original examples were saved in the creation request, but automatic refills did not read them.

The follow-up fix makes new refills use all saved examples for the current revision. Skills without supplied examples keep the cached-exercise fallback. Edited revisions use their own guidance, and queued jobs retain their frozen context. [The refill checks](companion/REFILLS.md#verification) cover the provider request, revisions, reports, retries, and the native Mac flow. A read-only check selected both approved book examples for each trial skill. This did not rerun the paid trial or change its data; verification used synthetic generation at zero cost.

Private plans, provenance, provider receipts, quality judgments, and native state comparisons remain with the disposable trial. No textbook text, generated bank, credentials, collection, or private logs are committed. The trial app, companion, and worker are stopped. No Azure changes or personal Anki data were used. A daily-use trial and a second protected backup-key copy remain outstanding.

## Editor trial on October 6

The user authorized another local trial with agent-selected material and a $1 ceiling. This trial used **Tools > Add skill…** in the packaged Mac app, with a fresh LearnRecur profile and authenticated local companion. Each definition received two book exercises as guidance.

| Skill | Source examples | Rule and answer-key pages |
| --- | --- | --- |
| Choose gusta or gustan | Exercise 10.2, items 4 and 11 | Rules 153–157; key 571 |
| Choose a direct object pronoun for a thing | Exercise 11.5, items 1 and 8 | Rules 182–186; key 573 |
| Attach a supplied direct object pronoun to an infinitive | Exercise 11.5, items 2 and 7 | Rules 183 and 187; key 573 |

These are printed page numbers in the same 2020 edition. The original exercises and keys were checked visually. Adaptations supplied the indirect object pronoun for gustar, limited pronoun selection to inanimate objects, or supplied both forms for infinitive attachment. Each prompt tested one rule. Example explanations were written from the chapter rules. No authored fallback examples were needed.

### Generation and quality

Three initial jobs and one automatic gustar refill each generated three exercises with `gpt-6-luna` and `xhigh` reasoning. All four completed on their first attempt, with exactly four provider submissions. The saved examples were compared with both the job context and the actual outbound request for every submission. The refill received both book examples, rather than a generated exemplar.

All 12 stored answers and explanations were correct within the defined rules. Scope, difficulty, and variation also passed. Gustar covered singular nouns, plural nouns, and infinitives. Pronoun selection used explicit gender and number cues. Infinitive attachment supplied the verb and pronoun, so it did not require another choice or conjugation. Generated prompts differed from the source examples and previous prompts. Three items per initial bank do not cover every pronoun form or context.

Six initial prompts failed the clarity check when assessed as review cards: the gustar batch did not say to use gusta or gustan, and the pronoun-selection batch did not give its four choices. The native front displays only the prompt, without the skill title or definition. A gustar blank can also take a form of encantar or interesar. The direct-object prompts leave the learner to infer that the blank requires lo, la, los, or las. Judging against the hidden definition missed this problem. The three infinitive-attachment prompts and three refill prompts stated the required operation or choices and passed this check. Source examples included those instructions, but the model did not consistently retain them.

The jobs reported 1,736 input tokens and 1,339 output tokens. Their usage estimates totaled **845 microusd ($0.000845)**, with no unsettled reservations. No credits or discounts were assumed. Reservations stayed within the $1 ceiling, and the worker stopped after the fourth submission. The [published model rates](https://developers.openai.com/api/docs/models/gpt-6-luna) were checked on October 6. This is a usage-based estimate, not a provider invoice.

### Native Mac checks

The editor disabled its inputs during generation and added exactly three cards, keeping preview optional. Rating the first skill Again queued one refill with its saved examples. Undo restored its original card state. A correct exercise was deliberately reported with **Other** to check the workflow; this was not a quality failure. The report shared the existing refill job and showed an eligible cached replacement with its answer hidden. Reporting and report undo/redo preserved the exact card, note, and review rows. Reveal matched the replacement while generation completed.

Returning to the deck list downloaded the refill automatically. That bank grew from three to six exercises; the other banks stayed at three. The exact card and review rows remained unchanged. With the companion stopped, all three skills passed cached reveal and rating. Rating undo/redo restored the exact card and review entry, and subsequent reviews selected different exercises, including a new refill item.

The final offline restart preserved all three cards, five review entries, 12 cached exercises, identities, reports, and delivery records exactly. The new refill exercise still revealed its matching answer. Offline here means the local companion was stopped and no worker was running; general Internet access was not blocked. The app exited normally. Existing Qt accessibility warnings appeared during automation; this trial does not resolve the [known accessibility issue](MAC-ACCESSIBILITY.md).

The editor trial recorded these findings without changing runtime code. The follow-up below changes generation instructions and checks new output. Private source extracts, definitions, requests, receipts, quality judgments, and state comparisons remain outside Git. All trial processes are stopped. No personal Anki data or Azure services were used. Real-provider editing, independent instructor review, longer use, bank retention, and upstream-update effort remained untested by the editor trial. Arrange the second protected backup-key copy before a daily-use trial.

## Standalone prompt follow-up on October 6

Generation instructions now tell the model that the learner sees only the prompt before revealing the answer. Every prompt must state the task and include the forms, choices, units, or other information needed to answer it. When choosing a tense or operation is the target skill, the prompt must leave that choice to the learner. Otherwise, it must supply the tense or operation the skill assumes is given. The model must check the prompt without relying on the hidden definition or examples. New OpenAI jobs save instruction version 2; queued jobs and retries retain their original instructions. [The provider notes](companion/OPENAI.md) describe that contract. The editor and review layout are unchanged.

A first-draft trial reused the three editor definitions and their six book examples in a fresh private companion. Three initial jobs, a gustar title edit, and a refill for that edited revision generated 15 exercises with `gpt-6-luna` and `xhigh` reasoning. All five completed on their first attempt. Every actual provider request contained the first-draft instructions and both saved examples for its skill. The original trials were left intact.

Each prompt was inspected before its answer, using only the information on the review card. All 15 stated the task and supplied the required choices or forms. Answers, scope, difficulty, variation, and brief explanations passed manual checks. One infinitive exercise used an awkward context: it described a letter as ready while asking the learner to write it. The supplied verb and pronoun still gave one clear answer, but the context needs better wording. This small sample checks the missing-instruction fix; it does not establish consistent quality or replace manual inspection with a semantic validator.

The five jobs reported 2,823 input tokens and 2,075 output tokens. Usage estimates totaled **1,322 microusd ($0.001322)**, with no assumed credits or unsettled reservations. The worker stopped after five submissions.

Native Mac import created three cards. Their prompts showed the task without the skill definition, and reveal displayed the matching answers. Importing the edited revision and refill preserved the exact card and three review rows. The active banks held six gustar exercises and three for each other skill; the previous gustar revision stayed in history. With the companion stopped, a normal quit and restart preserved exact notes, cards, reviews, and links. A different cached exercise revealed its matching answer offline. Offline here means the companion was unavailable and all finite workers had stopped; general Internet access was not blocked. Automatic refill requests were disabled for this bounded trial, and the refill was requested explicitly through the normal job API.

Initial code review found that requiring every prompt to supply the tense or operation could give away a decision the skill was meant to test. The final instructions distinguish that decision from information the learner needs. A second fresh trial checked the final instructions on the same three Spanish skills and a synthetic math skill that asks the learner to choose addition or multiplication. The Spanish skills kept their six book examples; the math skill used two authored examples. All four requests contained the exact final instructions and their saved examples, and all jobs completed on their first attempt.

All 12 final prompts passed manual checks for a clear task, enough information, one correct answer, scope, difficulty, variation, and brief explanations. The math prompts gave both expression choices without selecting the correct operation. Native import created four cards. With the companion stopped, all four passed cached prompt display, reveal, and rating, producing four review entries. The app exited normally.

The final four jobs reported 2,475 input tokens and 2,130 output tokens, costing an estimated **1,315 microusd ($0.001315)**. Both follow-up trials together cost an estimated **$0.002637**; including the earlier editor trial, the total was **$0.003482**, within the approved $1 ceiling. No credits or discounts were assumed, and no reservations remain unsettled. Rates were checked against the [model page](https://developers.openai.com/api/docs/models/gpt-6-luna) on October 6. These are usage estimates, not a provider invoice.

All 249 companion tests pass, including seven new cases for creation, editing, refill, report replacement, and frozen legacy instructions across restart, retry, and response retrieval. Private requests, responses, quality judgments, and collection comparisons remain outside Git. The app, companion, and workers are stopped. No Azure changes or personal Anki data were used. The real-provider edit changed only the title; description and example edits, independent instructor review, longer use, bank retention, and upstream-update effort remain outside this check.

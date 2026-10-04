# Create a skill

Choose **Tools > Add skill…**. Enter a title and a description of the rule or procedure to test. You can add up to five example exercises, each with a prompt, answer, and explanation. These guide generation; they do not become review exercises.

The editor opens in its own resizable window, like Anki's Add window. Collapsible labels appear above the fields, and typed text uses a larger font. Chevrons brighten on hover; reduced-motion settings disable the fade. Info icons beside Description and Examples explain what to enter. Move the pointer over an icon or activate it with the keyboard to show a wide tooltip beside it. Input text stays in place when focus changes. The title has a taller single-line field; the description stays compact instead of filling the window. A small examples list shows saved prompts or **No examples**. **Add example…** opens the example form; examples start unselected. Edit and Remove become available when an example is selected. Close sits on the left, and the primary action sits on the right. The editor closes when its LearnRecur profile closes, while preserving any submitted request for recovery.

Select **Add skill**. The companion saves the definition and queues a job for three exercises. The worker uses the provider configured on the server. The form and action button stay disabled during generation, with an indeterminate native progress bar. When the exercises are ready, the app creates one native card in **LearnRecur skills** through the existing import code. A compact completion window keeps exercises hidden and groups **Close**, **Preview exercises…**, and **Add another skill** together. Add another skill restores the editor's previous size and position. Preview opens a separate read-only dialog; it is optional and does not affect the card or its schedule. Review, ratings, and undo use Anki's normal paths.

Closing before Add skill discards an unsent form. Closing after submission leaves the request saved. Reopen Add skill to resume the same job and finish saving its card, without another generation call. Closing after completion leaves the saved skill intact. **Add another skill** resets the form after the current card has been saved. Budget waits and errors stop the animation and show recovery controls. A known failed job offers **Edit** so the user can deliberately submit a new request. An uncertain provider response must be recovered before this flow offers a new request.

This slice creates skills. Editing an existing description in the app comes later; revisions currently use Import skills.

## Creation and recovery

`POST /v1/skill-drafts` requires the same bearer token as other companion endpoints. Its payload contains exactly these fields:

- `request_id`: a fresh UUID represented as 32 lowercase hexadecimal characters.
- `source_id`: the companion's database UUID from `GET /v1/skills`.
- `title`: up to 256 UTF-8 bytes.
- `description`: up to 8,192 UTF-8 bytes.
- `examples`: zero to five objects with nonempty `prompt`, `answer`, and `explanation` strings, each up to 8,192 UTF-8 bytes. The complete request must fit within 65,536 bytes.

The server chooses `fixture` or `openai` from its existing refill configuration. Clients cannot select a provider through this endpoint. A disabled provider rejects new requests. Retrying a saved request returns its original job even after the configuration changes. Reusing a request ID with different content fails.

One transaction saves the draft and job in `skills.sqlite3`. The skill ID is `skill-<request_id>`. Drafts reserve an ID, a slot within the 100-skill trial ceiling, and enough snapshot space for three maximum-sized valid exercises. Concurrent drafts, imports, and publication cannot consume that reserved space. A nearly full companion rejects creation before queuing a job or reserving any spending. They stay out of normal snapshots until valid exercises are available. Publication saves revision 1 and the native note/card identity together, then removes the draft. Invalid output leaves no published skill or partial identity, while retaining the job and any recorded cost. Failed drafts and jobs remain subject to the trial ceilings; retention is separate work.

The desktop saves the request in its LearnRecur profile before sending it. The saved definition contains no key, token, or connection URL. It binds to the original companion identity, so changing servers cannot silently repeat generation. Requests use the existing cost reservations, leases, provider response recovery, and restore fences. Complete backend backups include drafts and jobs in the companion database.

The initial Add skill click authorizes generation and local card creation together. Only that request's skill is imported. Retrying after an interrupted native commit finds the existing card. If the main app is reviewing when generation finishes, creation waits for an explicit Finish adding action at the deck list rather than interrupting review. Profile and connection guards discard late callbacks after the dialog closes or its context changes.

## Local checks

The October 3–4, 2026 checks used the packaged Mac app with isolated synthetic storage in `out/learnrecur/skill-editor-preview-20261003/`. Form entry, example editing, hover help, stable input focus, disabled loading controls, automatic creation of one card, optional preview, Add another skill, reveal, Again, and native undo passed. The completion window is compact, groups its actions together, and restores the editor size when adding another skill. The companion supplied fixed Spanish exercises. No real model call or paid generation ran. Mocked OpenAI tests cover initial generation and usage accounting; they do not establish model answer quality.

The fixture provider accepts the original Spanish fixture and new skills with this exact description:

> Form the first-person singular preterite of regular Spanish -ar verbs. Exclude spelling changes, irregular verbs, other persons, and other tenses.

Its small fixed pool is for local checks. Other descriptions require the configured OpenAI worker and authorized spending. No key belongs in the desktop profile.

Run the focused checks after building the Python library and Qt client:

```sh
ANKI_TEST_MODE=1 PYTHONPATH=.:pylib:out/pylib out/pyenv/bin/python \
  -m pytest learnrecur/companion/tests/test_creation.py -q
PYTHONPATH=pylib:qt:out/pylib:out/qt out/pyenv/bin/python \
  -m pytest qt/tests/test_learnrecur_skill_editor.py -q
```

The desktop and companion must both include this slice. An older companion returns an update message instead of creating a request. The Azure deployment has not been upgraded for this endpoint. The user approved the local UI. [PR 18](https://github.com/bennetthilberg/learnrecur/pull/18) contains the editor. Initial code review found the snapshot-capacity issue described above; it is addressed in one batch. Initial security review reported no additional findings. CI remains pending.

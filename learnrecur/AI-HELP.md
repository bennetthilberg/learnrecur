# AI help during review

After you reveal a card's answer, press **H**, click **Ask** in the bottom bar, or choose **More > Ask AI**. A panel opens on the right where you can ask a model about the card and send follow-ups. The window grows to make room for it, so the card keeps its width, and shrinks back when the panel closes. A full-screen or zoomed window can't grow, so there the panel takes space from the card. It works on skill exercises and ordinary cards. You pay for it with your own API key from Claude, OpenAI, or OpenRouter.

## Why it only opens after the reveal

Trying to remember the answer, even when you get it wrong, is the part of review that does the work. If help were one key away while you're still stuck, you'd use it, and the review would turn into a lesson. Asking after the reveal also leaves your rating honest: you rate whether you got it yourself, and the scheduler uses that rating as usual. Pressing H before the reveal just shows "Show the answer first."

## What the model sees

- **Skill cards:** the skill's title and description, plus the exercise's instruction, prompt, context, answer, blank fills, and explanation.
- **Ordinary cards:** both sides as plain text, the deck name, and the note type. Images and audio show up only as `[image]` and `[audio]`. If the card asks you to type an answer, the model also sees what you typed.

The instructions tell the model to keep replies short, stay on the card, and say plainly when a card or exercise looks wrong. If it agrees an exercise is wrong, use **Report** as usual; the chat never reports or rates anything.

A chat belongs to one showing of one card. Esc or the panel's close button hides the panel and keeps the chat until you rate the card. Rating, moving to another card, or leaving review throws the chat away. Chats are never saved, so they don't sync and don't end up in exports.

While the chat is empty, three buttons send a question right away: **Explain the rule here**, **Walk me through this step by step**, and **Is this exercise correct?** (**Is this card correct?** on ordinary cards). Cmd+1, Cmd+2, and Cmd+3 send them at any point while the panel has focus. The panel takes focus when it opens, so H then Cmd+1 works without the mouse. Outside the panel, Cmd+1–3 still set flags.

Your questions appear in a shaded box on the right, and the replies below them span the panel's width. Until a reply starts, "Thinking" shows under your question, with dots that count down from three to one and back.

While the text box has focus, review shortcuts are off. Typing `1` or pressing Space doesn't rate the card, and Cmd+Backspace doesn't delete the note. Return sends the question and Shift+Return starts a new line.

## Settings

**Tools > AI Help Settings…** holds:

- **Provider:** Claude API, OpenAI, or OpenRouter. Claude is the default.
- **API key:** stored in the macOS login Keychain under "LearnRecur AI help", one entry per provider. It isn't stored in the profile or collection. The app passes it to `/usr/bin/security` on stdin, so it never shows up in a process list.
- **Model and reasoning:** each provider remembers its own choice.

  | Provider   | Default model       | Default reasoning |
  | ---------- | ------------------- | ----------------- |
  | Claude API | `claude-sonnet-5-5` | high              |
  | OpenAI     | `gpt-6-luna`        | xhigh             |
  | OpenRouter | `openai/gpt-6-luna` | xhigh             |

  Sonnet 5.5 at high reasoning matches the exercise generator. `gpt-6-luna` matches the setting the OpenAI generator uses. A provider you've already used keeps the model you saved for it.
- **Fast mode:** off by default. For Claude it's sent only to models that support it (`claude-opus-5-5` today), since asking any other model for fast mode is an error. If Claude rate-limits fast mode, the app retries at standard speed. OpenAI and OpenRouter get `service_tier: "fast"`, which costs twice as much. If OpenAI serves the request at standard speed anyway, it bills, and the app counts, standard rates.
- **Monthly limit:** $1.00 by default. Set it to zero for no limit.

## Spending

Each reply's cost is added to a running total for the current UTC month, saved in the profile. Claude and OpenAI costs come from the token counts each reply reports and a price table in `qt/aqt/learnrecur_ask_client.py` (checked November 3, 2026). OpenRouter reports each reply's cost itself. The app checks the total before every question and refuses once it reaches the limit, so the last reply can go a little over. A reply cut off by rating the card isn't counted, though the provider still bills the part it generated. A Claude reply is capped at 128,000 output tokens, the most current Claude models allow, including reasoning. At Sonnet's $10 per million output tokens, a reply that used it all would cost about $1.28; most use a small part of it. OpenAI and OpenRouter replies are capped at 16,000.

If a limit is set and the chosen model isn't in the price table, the app won't send anything. It says so and suggests removing the limit. With no limit, any model works and unpriced replies just aren't counted.

## Code and tests

- **`qt/aqt/learnrecur_ask_client.py`:** provider requests, prices, and the Keychain.
  - Claude uses the official `anthropic` SDK.
  - OpenAI uses the official `openai` SDK and the Responses API with `store: false`.
  - OpenRouter uses the same code with OpenRouter's base URL, since OpenRouter serves the Responses API too.
- **`qt/aqt/learnrecur_ask.py`:** the panel, settings dialog, card context, and reviewer hooks.
- **`qt/tests/test_learnrecur_ask.py`:** replays recorded streaming responses through the real SDKs. It covers request bodies, fast mode, errors, cancellation, costs, key handling, card context, and keyboard behavior. No test makes a network call.

## Limits

- The panel shows Markdown but not math notation, so math skills will need MathJax in the panel later.
- Replies have no images.
- Changing models mid-chat applies to the next question.
- The price table needs updating when providers change prices.

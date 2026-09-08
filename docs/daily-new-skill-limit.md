# Daily new-skill allowance

Settings → Practice preferences now offers **New skills per day**, **Unlimited new skills**, and **Daily reset timezone**. The default remains Unlimited; existing accounts keep their current practice behavior. A limit accepts 0–1000. Zero stops new introductions while allowing previously introduced skills and scheduled follow-up reviews.

The counted event is the first exercise presented for a previously unpracticed skill, across every collection in the account. Reloads, alternative exercises for that same skill, and scheduled same-day follow-ups do not spend another introduction. Merely declaring a skill “already studied” does not exempt its first introduction in LearnRecur. An unfinished introduction remains available on later days. Lowering the limit does not withdraw an exercise already introduced.

The allowance resets at local midnight in the explicitly selected IANA timezone, independently of reminder settings. Changing that timezone immediately evaluates today's introductions in the new timezone. DST days follow calendar dates rather than 24-hour windows. Deleting a skill also removes its presentation marker; this learner-controlled pacing setting is not a billing or abuse-prevention quota.

## Persistence and enforcement

`User.dailyNewSkillLimit` is nullable (`null` means Unlimited), with a database constraint of 0–1000. `User.practiceTimezone` defaults to UTC. `Skill.firstIntroducedAt` records introduction without adding an attempt or altering FSRS. The additive migration seeds this marker from the earliest recorded review, falling back to `lastReviewedAt`; it does not rewrite review evidence or schedules. Legacy skills with repetitions remain reviewable even if their timestamps are absent.

Selection and direct answer submission serialize introduction checks under the user row lock. Limits apply across scopes and concurrent tabs. Eligible exercises are checked before an introduction is recorded. A visible Practice client explicitly requests its first item; server rendering and link prefetching do not select or charge one. A delivery interrupted after the server records it remains resumable without a second charge.

Dashboard totals and reminders cap new work by the remaining account allowance. Each collection shows how much could be practiced within that collection using the shared allowance, so collection counts need not sum to the account total. Read models never spend the allowance. When new work is deferred, Practice explains the limit and links to Settings; unprepared review work retains its preparation state.

MCP `practice.get_settings` and `practice.update_settings` expose both account fields with the existing `practice:read` and `practice:write` scopes. Example update:

```json
{
  "target": { "scope": "user" },
  "changes": {
    "dailyNewSkillLimit": 10,
    "practiceTimezone": "America/Chicago"
  }
}
```

Send `dailyNewSkillLimit: null` to restore Unlimited. Partial agent edits and older web preference payloads preserve omitted fields. These are account settings; collection and skill targets reject them. Study exports advance to version 5 and include both settings and `firstIntroducedAt`; normal account/skill deletion removes these fields with their owning rows.

Apply `20260907220000_daily_new_skill_limit` before deploying this code. The schema readiness check requires it. An app rollback can leave the additive fields and backfill in place; older code ignores them. No production migration or deployment is part of this implementation PR.

## UI review

Five choices rejected during the UI review and the resulting controls:

1. A separate quota dashboard would bury a small preference. Keep the existing Settings form and Save action.
2. A number without units could imply attempts or completed reviews. Name the unit “New skills per day” and explain the first presented exercise.
3. A hidden reset timezone would make midnight behavior unpredictable. Provide a searchable timezone control beside the allowance.
4. An “all caught up” success screen would misrepresent deferred work. Show “Daily new-skill limit reached” and a direct Settings link.
5. Side-by-side controls or a new decorative card would crowd mobile Settings. Keep the existing vertical Mantine layout, keyboard controls, hydration gate, and save notifications.

Verification covers validation and DST, first presentation/reloads, concurrency across collections, direct submission, scheduled follow-ups, ownership, MCP permissions and partial writes, readiness counts, export, and desktop/mobile browser flows. Release evidence and exact passing counts are recorded in the PR.

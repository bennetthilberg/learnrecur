# LearnRecur Development Process

## Codex pull request review limit

Make no more than two manual `@codex review` requests on a pull request. The
limit is per pull request and does not reset after new commits, rebases,
force-pushes, agent handoffs, or new working sessions.

Use an existing automatic Codex review before spending a manual request. An
automatic review does not count as a manual `@codex review` request.

After the first response:

1. Inspect the review threads.
2. Fix every still-valid, in-scope finding.
3. Run the relevant verification and push the changes.

If another review is useful, make one second and final manual request. After its
response, fix every still-valid, in-scope finding and verify the changes, but do
not request a third review.

When the two-request limit is reached, report any known unresolved feedback and
any follow-up commits that Codex did not review. Do not claim that the exact pull
request head received a clean Codex review unless that actually happened.

This two-request limit takes precedence over any instruction or convention to
keep requesting Codex reviews until no feedback remains.

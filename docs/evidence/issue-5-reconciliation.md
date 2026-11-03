# Issue #5 reconciliation verification

## Native review notification: live local verification

Verified at `2026-11-03T04:35:13.839Z` (November 2, America/Los_Angeles), using Node `24.15.0`, managed Paperclip `2026.1023.0`, and the existing Board CLI sign-in at authenticated loopback `http://127.0.0.1:8100`.

The test used the production `buildReviewInteraction` generator and `reconciliationHandoffBody`. A disposable standalone issue had no agent or user assignee. No agent configuration changed, no Cloud command ran, and no Cloud job was submitted. The card referenced the already accepted #3 Cloud task only as a link.

| Record | Value |
| --- | --- |
| Company | `dc9439c0-a0d6-4233-b81f-2cc3adc2ec0b` |
| Project | `a7fb8b31-92a3-4739-98bb-3293bf3a0cf4` |
| Disposable task | `PAP-3`, `51b407c1-2553-4646-8de6-19e16db2507a` |
| Interaction | `1326af56-3c4b-413e-a069-cd7274b9904b` |
| Test execution marker | `fe3fe818-ccfc-49f2-8862-5ea444f59a45` (not a live journal execution) |
| Existing Cloud link | <https://chatgpt.com/remote/task_e_6ae8be3af9888325b7e16a152a0843a8> |

Each command used the managed `paperclipai` launcher with `--api-base http://127.0.0.1:8100 --json`. The normal CLI resolved its saved Board credential; no credential file was read manually, and credentials were excluded from evidence.

| Operation | Exit | Observed result |
| --- | --- | --- |
| `issue create -C COMPANY --project-id PROJECT --status blocked --standalone ...` | 0 | Created PAP-3 with status `blocked`, both assignees null. |
| `issue interaction:create ISSUE --payload-json PAYLOAD` | 0 | Created one human-only custom review card with continuation `none`; returned payload exactly matched the generator, including normalization defaults. |
| `issue get ISSUE` | 0 | Status remained `blocked`; agent assignee remained null. |
| Repeat the identical `interaction:create` payload and idempotency key | 0 | Returned the same interaction ID. |
| `issue update ISSUE --status done` without a comment | 0 | Disposable task became `done`. |
| `interaction:create` with a different execution/idempotency key | 1 | New review card on the terminal task was rejected. |
| `issue get ISSUE` | 0 | Status remained `done`; agent assignee remained null. |
| `issue interactions ISSUE` | 0 | Exactly one original card remained, projected as `expired` after task closure. |

PAP-3 was left `done` as a durable verification record. No assignee heartbeat was requested by this test. This verifies the supported notification interface and terminal guard; it does not claim browser rendering was inspected or that the Cloud task's acceptance criteria passed.

## Why the notification uses an interaction

The installed, pinned Paperclip server treats a Board-authored ordinary comment as human follow-up. Its `routes/authz.js` maps Board actors to activity actor type `user`; `routes/issues.js` calls `shouldImplicitlyMoveCommentedIssueToTodo` for comments on assigned blocked or closed issues. Both `issue comment` and `issue update --comment` can therefore implicitly change status. They do not satisfy this feature's status-preservation contract.

The supported CLI exposes `issue interaction:create --payload-json` and `issue interactions`. In the installed `@paperclipai/server/dist/services/issue-thread-interactions.js`, `create` locks the issue row inside its insert transaction and rejects terminal issues. Creation inserts the card and touches `updatedAt`; it does not change task status. The request uses:

- A stable execution-scoped idempotency key and custom target key, rather than `native_completion_review`.
- `resolverPolicy: human_only`, `continuationPolicy: none`, no agent addressee, and no source-run attribution.
- Explicit `allowDeclineReason: true` and `supersedeOnUserComment: false` to match server normalization.

The native completion-review special case is selected by the exact custom target key `native_completion_review`, which this feature never emits. A Board-created custom card has no creator agent to return execution to. A human can acknowledge the card separately from changing task status or verifying acceptance criteria.

The live terminal test exercised the locked guard sequentially. The concurrency guarantee itself is established by the installed service's issue-row transaction; this test did not attempt to reproduce an HTTP race.

# Paperclip → Codex Cloud dispatch verification

Verified on 2026-11-02 for [issue #3](https://github.com/bradywatkinson/paperclip-codex-factory/issues/3), using Paperclip `2026.1023.0`, Codex CLI `0.166.0`, and Node `24.15.0`.

The implemented bridge runs through Paperclip's supported `process` adapter. No Paperclip core files were changed. A disposable project and agent were configured through the supported Board CLI; the existing Chief of Staff agent was left unchanged. Scheduled heartbeats were disabled for the smoke agent. The live test was authorized for read-only inspection of Story Keeper.

## Live path

- Paperclip task: **PAP-2**, `688630d3-a281-45ab-8707-37e5f3731663`.
- Project: `a7fb8b31-92a3-4739-98bb-3293bf3a0cf4`; workspace: `0809b177-68a3-416a-9453-bbd69087e14a`.
- Dispatcher: `8dbe3519-3064-4038-a913-682b95b02ce3`.
- Repository: `bradywatkinson/story-keeper`; requested branch: `main`.
- Cloud environment: `6a7aa92536508191bf085b59e7d6b8ba`.
- Cloud task: https://chatgpt.com/remote/task_e_6ae8be3af9888325b7e16a152a0843a8

Assignment triggered the initial process run. The bridge resolved its issue from its own heartbeat, validated assignment and project/workspace binding, checked the installed CLI and ChatGPT login, checked out the issue, recorded an exclusive issue-scoped intent, submitted one Cloud job, and saved the accepted receipt.

| Observation | Result |
| --- | --- |
| Assignment run `3984a3d7-b366-4dec-bd54-146a185f1b26` | `succeeded`, exit `0`, 18.688 seconds; stdout `status: dispatched` |
| Recorded Cloud submission interval | Approximately 4.82 seconds |
| Initial Paperclip disposition | `blocked`, dispatcher-owned reconciliation action, one receipt comment |
| Explicit verification run `d7390bf3-07c1-45aa-b4fa-64c9f2ab52e4` | `succeeded`, exit `0`, 2.669 seconds; stdout `status: already_dispatched` |
| Guard reuse | Same Cloud ID and original dispatch-run ID; no new handoff PATCH/comment |
| Cloud observations | `READY`, one attempt, zero reported file/line changes |

The second run was explicitly requested for guard verification. An automatic self-notification run was not observed. Source policy permits blocked-owner wake-ups; the guard handles a repeated invocation without submitting another job.

The [Paperclip evidence](paperclip-live.json) contains selected API metadata, actual bridge stdout retrieved through supported run-log commands, and the guard receipt. The Cloud fixtures are parsed, filtered observations of this task, not raw account-wide task inventories: [initial status](cloud-status-initial.json), [initial list](cloud-list-initial.json), [follow-up status](cloud-status-follow-up.json), and [follow-up list](cloud-list-follow-up.json). No independent account-wide Cloud job count is claimed. The two actual process receipts and guarded code path establish reuse within this test.

The bridge returns after submission and handoff; it contains no Cloud completion polling. Cloud status was observed separately for verification. A list update timestamp is not treated as a precise Cloud completion timestamp.

## Human result review and manual closeout

The user supplied [this Cloud UI screenshot](cloud-result-user.png), with a [separate transcription/provenance record](cloud-result-user.json). It shows:

- `FACTORY_CLOUD_ADAPTER_OK`.
- Reported branch `work` and HEAD `20145a418c4ce2034b301253df8927ec266ace9c`.
- The Story Keeper README heading.
- A report of read-only inspection with no file changes, commits, pushes, PRs, deployments, installations, project scripts, or secret reads.

This is human-supplied result evidence, not automated transcript retrieval. The reported `work` branch does not establish whether the requested `main` base was honored; branch ancestry was not independently verified.

After this review, a Board operator manually marked PAP-2 `done` with a verification comment. A fresh API read confirmed `done` and a cleared unblock descriptor; see [manual closeout](manual-closeout.json). The earlier blocked-state snapshot is intentionally retained. Automatic result reconciliation is not implemented by this bridge and remains issue #5.

The disposable smoke agent was [paused after verification](test-agent-cleanup.json). Its configuration, completed task and evidence were retained for inspection.

## Local tests and boundaries

All **28 tests passed** on Node `24.15.0`, including 20 bridge tests. Run:

```sh
node --test tests/*.test.mjs
```

Coverage includes actual process-entrypoint/HTTP/CLI-fixture integration, literal argument handling, credential filtering, API redirects, project/workspace and active-run scope checks, checkout drift, version/authentication gates, bounded prompts/output, process-tree cancellation, concurrent claims, sticky unknown outcomes, failed handoff recovery, and receipt reuse. The existing configuration tests now use ephemeral network fixtures and coexist with the running service on port `8100`.

The minimal guard is not the complete execution journal planned in #4. The bridge does not poll Cloud results, retrieve final assistant text, create PRs, merge, deploy, or automatically retry an ambiguous submission. `read_only` is a prompt policy, not a newly enforced Cloud filesystem permission boundary. This live verification used the read-only mode; the coding/PR delivery workflow remains future end-to-end work.

CLI authentication used the supported browser-approved flow. An initial credential-store permission failure was corrected, and the exact unused key from that failed attempt was revoked. No auth challenge URLs, bearer credentials, credential-store contents, or unrelated account data are included in these artifacts.

Implementation and operating instructions: [dispatch guide](../../cloud-dispatch.md). The changes and evidence are committed locally; publication/review is separate.

## Publication update — 2026-11-02

This implementation and its artifacts are now published in [draft PR #17](https://github.com/bradywatkinson/paperclip-codex-factory/pull/17). The earlier local-publication note records the state at live verification time. The original 23 feature commit SHAs are unchanged, and published code head `63d0e2707f90a2a07002d3850388de2a368b520f` has the same verified file tree as `cafc9879e3378acc68ba780923e44e8126b0c72b`. The recorded 28-test result and live evidence are retained; publication introduced no code changes. `main` contains only the empty base, so the feature work is still awaiting review and merge. See [the publication record](../../publication.md).

# Publication and review record

Published on 2026-11-02 in [draft PR #17](https://github.com/bradywatkinson/paperclip-codex-factory/pull/17): bootstrap, Codex Cloud contract spike, and the external dispatch bridge for issues #1, #2, and #3.

The remote repository was empty before publication. To establish a reviewable base while preserving the recorded evidence commits:

- Created `main` at empty initial commit `f5170a129f439ce740599040edff14418dad4b78`.
- Connected that base to the existing feature history with merge commit `63d0e2707f90a2a07002d3850388de2a368b520f` on `issue-3-cloud-dispatch`.
- Published those two refs together and opened the draft PR against `main`.

`main` contains only the empty base. The feature work has not been merged. All 23 pre-publication feature commit SHAs remain unchanged and reachable from the review branch, including the evidence-bearing commits referenced in issues and local records.

The published code head's tree exactly matches verified commit `cafc9879e3378acc68ba780923e44e8126b0c72b` (tree `f1731f88549871b2475ce799528e3e75bfffe19b`). Connecting the review base changed history, not files. The recorded **28/28 passing tests on Node 24.15.0** and live verification therefore remain applicable to that code snapshot; no new test run was needed for the history-only connection. Subsequent publication notes change documentation only.

Review evidence:

- [Paperclip bootstrap evidence](evidence/2026-10-31-bootstrap.md)
- [Codex Cloud spike evidence](codex-cloud/evidence/2026-11-01.md)
- [Live dispatch and guard-reuse evidence](evidence/issue-3-cloud-dispatch/README.md)
- [Dispatch operating instructions](cloud-dispatch.md)

Earlier dated records that say artifacts were local or unpublished describe their state at verification time. Draft PR #17 now publishes those artifacts. Remaining manual checks and unsupported operations recorded under #1, #2, and #16 remain explicit; publication does not establish completion of those checks.

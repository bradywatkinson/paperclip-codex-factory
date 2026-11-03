Implement the new-list-only fix described in Story Keeper issue #3465: https://github.com/bradywatkinson/story-keeper/issues/3465

Approved repository: `bradywatkinson/story-keeper`.
Approved base commit: `<EXPECTED_BASE_SHA>` (the operator must replace this with the full approved main SHA before assignment).

Before edits:

1. Read the repository's applicable AGENTS instructions, `.codex/rules.md`, and `convex/AGENTS.md`. Follow the prescribed Cloud startup skill and use Bun for this repository.
2. Report `git rev-parse HEAD`, `git branch --show-current`, and `git status --porcelain`. Require the initial HEAD to equal the approved base exactly and the working tree to be clean. If the placeholder remains or the base differs, stop without edits or retries. A checkout branch named `work` is acceptable when its commit matches.
3. Inspect issue #3465's new-row scope and the existing collection slug implementation and tests. If the defect has already been fixed, report that fact and stop rather than manufacture a change.

Make the smallest useful change in these files only:

- `convex/model/collections.ts`: reserve `all` alongside `owned` when creating new collection slugs. Correct the static list-route path comment if it still points at the wrong directory.
- `convex/collections.test.ts`: add behavioral coverage for a new list named `All` receiving `all-1`, a subsequent collision receiving the next available suffix, and preserved `owned` reservation behavior. Use the existing test harness and naming conventions.

Do not migrate, modify, or count production rows. Existing lists and legacy shared URLs are outside this task. Do not edit application routes, dependencies, package scripts, or generated files.

Run `bun run test -- convex/collections.test.ts` and `git diff --check`. Record exit codes and the actual number of tests executed. The test wrapper has `--passWithNoTests`, so a zero exit code with zero executed tests does not satisfy this task. Report failed or unavailable checks explicitly; do not call the application-wide gate green from this focused command.

Return the initial commit, final HEAD, branch, changed-file list, reviewable patch, commands, actual test count, and outcomes. Include any limitations that prevent validating the change. Do not claim that all acceptance criteria of Story Keeper #3465 are closed by this new-row-only fix.

Do not read or disclose credentials, push branches, create PRs, merge, deploy, run migrations, or access production. Leave the patch for human review; the factory will collect the diff through its existing Cloud receipt. This task is the coding slice of Factory issue #7, not authorization to complete or close unrelated issues.

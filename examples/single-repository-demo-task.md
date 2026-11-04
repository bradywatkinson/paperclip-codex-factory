Create one isolated documentation patch for the Factory Cloud delivery tracer.

The operator must replace `<EXPECTED_BASE_SHA>` with the approved repository's full immutable base commit before assigning this task. If it is still a placeholder, stop without changing files.

1. Before changes, run `git rev-parse HEAD`, `git branch --show-current`, and `git status --porcelain`. Require HEAD to equal `<EXPECTED_BASE_SHA>` exactly and the working tree to be clean. A branch named `work` is acceptable; a different commit or preexisting changes are not. On mismatch, stop and report the observation without editing, fetching, installing, or retrying.
2. Require `docs/factory-cloud-demo.md` to be absent. Run the following guard in the shell that would create the file; if it fails, stop and report that fact rather than overwrite it:

```sh
test ! -e docs/factory-cloud-demo.md || { printf '%s\n' 'Demo artifact already exists; stopping.' >&2; exit 1; }
```
3. Create only `docs/factory-cloud-demo.md`, with these exact UTF-8 bytes and a final newline:

```markdown
# Factory Cloud execution demo

FACTORY_CLOUD_CODE_CHANGE_OK

This isolated documentation change verifies delivery from Paperclip through Codex Cloud. It does not change application behavior.
```

4. Run this focused check from the repository root, then `git diff --check`:

```sh
node --input-type=module <<'NODE'
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const expected = '# Factory Cloud execution demo\n\nFACTORY_CLOUD_CODE_CHANGE_OK\n\nThis isolated documentation change verifies delivery from Paperclip through Codex Cloud. It does not change application behavior.\n';
assert.equal(readFileSync('docs/factory-cloud-demo.md', 'utf8'), expected);
console.log('FACTORY_CLOUD_DEMO_CHECK_OK');
NODE
```

5. Return the initial commit, final HEAD, branch name, changed paths, check commands and outcomes, and a reviewable patch. Report any command that could not run. Do not claim the application test suite passed from this focused file check.

Do not change application code or other files, install dependencies, read credentials, push branches, create a PR, merge, or deploy. Do not make a commit yourself; retain the patch for review. This documentation-only tracer demonstrates patch delivery, not completion of issue #7's application-code acceptance criterion.

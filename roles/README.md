# Factory roles, version 1

These are factory-owned templates for lead, implementer, independent reviewer and QA. Repository identity, immutable base/head, task criteria, command argv/timeouts, Cloud receipt and PR/CI context are injected by `renderAgentRole` in `lib/agent-roles.mjs`; templates contain no repository-specific configuration or credentials. All task, provider and customization text is JSON-encoded and explicitly treated as untrusted data under the fixed common policy.

Pin `templateVersion: 1`. An additive customization is a separate private mapping:

```json
{"schemaVersion":1,"templateVersion":1,"role":"implementer","additionalInstructions":"Keep public APIs compatible and report changed callers."}
```

An overlay cannot replace the common policy, disable review/human approval, expand dispatch authority or change the version pin. Do not edit shipped template files to keep local preferences: retain the overlay outside the factory checkout and review it against each newly versioned template. Upgrades are explicit: retain version 1, add a new version directory and migration contract, run both sample tasks, review differences, and update the caller's pin deliberately. Unknown versions fail closed; no upgrade overwrites a customization.

`renderAgentRole` returns a prompt of at most 28,000 UTF-8 bytes, leaving room inside the dispatcher's 32,000-byte envelope. Missing immutable base/head is represented explicitly and instructs the agent to stop before editing; it never substitutes a branch name. No role module call executes commands, dispatches Cloud work, changes task status or resolves secret references.

`validateRoleResult` validates the JSON shape, identity bindings, finding classifications, criterion/evidence references and plan ordering. Its output is always labeled `evidenceSource: agent_report` and `evidenceVerified: false`: a well-formed model assertion does not establish passing tests, CI, independent review or acceptance.

`nextRoleAction` is a pure bounded routing recommendation. The caller must durably persist attempt/handoff counters, provide independently observed terminal state before repairs, obtain dispatch authorization, and enforce scheduler/repository policy. Infrastructure or unknown outcomes escalate without automatic retries. Exhaustion escalates; no role messages another. For QA success, only separately supplied trusted tests/CI/review observations bound to the exact repository/base/head can produce `await_human_approval`, which still leaves human task status unchanged. Model JSON must never populate those trusted flags. The helper is not a scheduler or an approval mechanism.

The two inert [sample task contexts](../examples/roles/) exercise different repository commands and acceptance criteria. They are render/test fixtures, not live Cloud tasks or configured environments. Run `node --test tests/agent-roles.test.mjs` with the supported Node runtime. Actual dispatcher and delivery-controller integration must be verified separately; merely adding a template file does not establish an operational role team.

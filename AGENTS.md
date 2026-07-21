# Engineering Operating Environment

## Authority

1. Explicit user requirements and security constraints.
2. This file.
3. `README.md` for supported behavior and operations.
4. Automated tests and implementation for verified current behavior.

When these sources materially conflict, stop and ask rather than silently choosing.

## Current product constraints

- Preserve compatibility with the live realm and its wire protocol.
- Run at most five bot accounts concurrently.
- Keep credentials local and untracked. Never log secrets or return stored passwords to browser clients.
- The primary experience is one launcher that starts the dashboard first; bot count and credentials are configured in that dashboard.
- Legacy launch scripts may remain as compatibility wrappers, but documentation must identify one primary entry point.
- User-facing dashboard text, runtime actions, logs, and operational documentation are English.

## Validation

- Run the automated test suite for implementation changes.
- Run focused tests for configuration, credential redaction, and fleet sizing.
- Smoke-test that the primary launcher serves the dashboard without requiring credentials and that configured bots can be started from the UI.
- Do not claim live-realm validation unless it was actually performed with authorized accounts.

## Knowledge and delivery

- Keep operational instructions in `README.md` and architectural/security reasoning near the implementation when it prevents misuse.
- Preserve unrelated working-tree changes.
- If `gh auth status` reports an authentication failure inside the sandbox, retry it with approved execution outside the sandbox before concluding that GitHub credentials are invalid.
- This is an informal repository: direct commits and pushes to the current/default branch are acceptable. Do not create a pull request unless the user explicitly requests one.
- Report validation performed and any unavailable validation at handoff.

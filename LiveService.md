# Adapting the Bot to Another Live Service

## Purpose

This document is an implementation runbook for adapting the World of Claudecraft bot architecture to another authorized live service with a similar REST-authentication, persistent-session, real-time-state, and command-driven model.

It is written for an engineering agent expected to inspect the target protocol, implement the adapter, validate it, and leave an operable dashboard-first system behind. It is not authorization to automate a service. Before writing target-specific code, obtain written confirmation that the accounts, API access, traffic pattern, and intended automation are permitted by the service owner and its current terms.

Do not implement CAPTCHA solving, challenge bypasses, browser-fingerprint spoofing, proxy rotation, account cycling, or detector-specific evasion for an unrelated service. When an interactive challenge is required, stop automation and require a human to complete the official flow. When a service rejects or suspends an account, stop or back off; do not route around the control.

## Required outcome

The finished adaptation must provide:

1. One launcher that starts a local dashboard before any account authentication.
2. Configuration for zero through the target service's authorized concurrency limit, never exceeding five in this repository unless the repository rules are explicitly changed.
3. Credentials stored locally, excluded from version control, and never returned to browser clients or written to logs.
4. A target-specific authentication adapter with human-in-the-loop handling for interactive challenges.
5. A reconnecting real-time transport with token reuse, bounded retries, rate-limit compliance, and terminal handling for suspension or policy errors.
6. A protocol normalization layer that shields decision logic from target wire-format changes.
7. Target-specific world data and action mappings.
8. Conservative, configurable command pacing based on published limits or owner-provided requirements—not reverse-engineered detector thresholds.
9. Focused tests for protocol translation, configuration, credential redaction, fleet sizing, retries, and stop conditions.
10. A staged validation record that distinguishes local simulation, staging, and authorized live-service testing.

## Existing architecture to preserve

The current runtime is divided into layers. Keep these boundaries; replace target-specific behavior behind adapters.

```text
start.sh
  -> console.mjs / local dashboard
      -> fleet factory
          -> authentication provider
          -> Connection transport
              -> protocol decoder
                  -> normalized World state
                      -> brain / fleet coordinator
                          -> abstract actions
                              -> protocol encoder
```

The most relevant current implementations are:

- [`lib/connection.mjs`](./lib/connection.mjs): token cache, WebSocket lifecycle, retry classification, and wire envelopes.
- [`autobot.mjs`](./autobot.mjs): construction of one bot, normalized context, event handling, decision loop, and watchdog.
- [`fleet.mjs`](./fleet.mjs): per-account creation, staggered startup, and fleet loop.
- [`lib/world.mjs`](./lib/world.mjs): normalized state ingestion and queries used by decision code.
- [`lib/brain.mjs`](./lib/brain.mjs): autonomous decisions expressed through `ctx.cmd` and `ctx.input`.
- [`lib/fleet_coordinator.mjs`](./lib/fleet_coordinator.mjs): party roles and coordinated actions.
- [`get-token.mjs`](./get-token.mjs): human-in-the-loop browser authentication and local token capture.
- [`lib/console_config.mjs`](./lib/console_config.mjs): fleet configuration and credential boundaries.
- [`tests/humanize.test.mjs`](./tests/humanize.test.mjs): legacy current-realm timing assumptions; do not treat these as portable service requirements.

## Phase 0: establish authority and scope

Before implementation, create a short target-service integration record, either in an existing design document or under a clearly marked section in this file. Record:

```markdown
Target service:
Service owner/contact:
Automation authorization reference:
Permitted accounts:
Permitted environments: local / staging / production
Maximum concurrent sessions:
Published request and command limits:
Approved authentication mechanism:
Interactive challenge behavior:
Data retention constraints:
Prohibited actions:
Live test window and rollback contact:
```

Stop and request a human decision if any of these affect architecture and cannot be learned from authoritative target documentation. Never infer that an undocumented endpoint, browser session, or observed client packet is permitted merely because it is technically accessible.

## Phase 1: capture a sanitized protocol specification

Build the adapter from authoritative API documentation whenever available. If the owner authorizes observation of an official client, record only sanitized fixtures. Remove bearer tokens, cookies, passwords, email addresses, account IDs, character names, IP addresses, and chat content.

At minimum, obtain fixtures for:

- successful login or token exchange;
- authentication failure;
- expired token;
- rate limiting, including `Retry-After` if supplied;
- suspension, ban, lock, or policy rejection;
- session creation and session-ready acknowledgement;
- duplicate-session rejection;
- one full state snapshot;
- one incremental state update, if applicable;
- representative event batches;
- every command family the bot will use;
- command rejection and malformed-message behavior;
- clean shutdown and unexpected disconnect.

Write a protocol matrix before coding:

| Concern | Current realm | Target service | Evidence |
|---|---|---|---|
| Login endpoint | `POST /api/login` | Fill in | Official docs or owner fixture |
| Character list | `GET /api/characters` | Fill in | Official docs or owner fixture |
| Real-time endpoint | `/ws` | Fill in | Official docs or owner fixture |
| Session handshake | `{t:"auth", token, character}` | Fill in | Sanitized fixture |
| Snapshot message | `t === "snap"` | Fill in | Sanitized fixture |
| Event message | `t === "events"` | Fill in | Sanitized fixture |
| Command envelope | `{t:"cmd", ...}` | Fill in | Sanitized fixture |
| Movement envelope | `{t:"input", ...}` | Fill in | Sanitized fixture |
| Rate-limit signal | HTTP 429/text classification | Fill in | Official docs |
| Terminal account signal | suspend/ban/locked | Fill in | Official docs |

Unknown fields remain unknown. Do not invent defaults for coordinates, identifiers, units, cooldowns, or message ordering.

## Phase 2: introduce a target adapter

Do not scatter target conditionals across `brain.mjs` and `fleet_coordinator.mjs`. Add a cohesive adapter, for example:

```text
lib/services/
  contract.mjs
  claudecraft.mjs
  target-name.mjs
```

The adapter should implement a contract like this:

```js
export class ServiceAdapter {
  async authenticate(account, { forceFresh, signal }) {}
  async listActors(session, { signal }) {}
  async selectActor(session, account, { signal }) {}

  realtimeUrl(baseUrl) {}
  encodeHandshake(session) {}
  decodeMessage(raw) {}
  encodeCommand(command) {}
  encodeInput(input) {}
  classifyHttpFailure(response, body) {}
  classifyRealtimeError(message) {}
  normalizeSnapshot(message) {}
  normalizeEvents(message) {}
}
```

Return normalized failure categories rather than making the transport parse arbitrary English text everywhere:

```js
// Suggested result, not a mandatory concrete type.
{
  kind: 'rate_limit' | 'interactive_challenge' | 'expired_auth' |
        'duplicate_session' | 'suspended' | 'transient' | 'fatal',
  retryAfterMs: null,
  terminal: false,
  publicMessage: 'Rate limited; waiting before retry.',
  cause: error
}
```

Keep `cause` out of dashboard payloads because upstream exceptions may contain sensitive headers or response bodies.

### Why this boundary matters

The current [`Connection`](./lib/connection.mjs) directly knows the realm's `/ws` path, handshake object, message types, and error wording. Those are the principal transport replacement points. Moving them behind an adapter prevents target protocol changes from contaminating game decisions.

## Phase 3: implement authentication safely

### 3.1 Credential source

Use the dashboard's server-side configuration as the primary credential source. Preserve these invariants:

- A blank password submitted by the dashboard means “retain the stored password,” not “erase it” or “return it.”
- Browser-visible state must contain only a boolean such as `hasPassword`.
- Configuration files and token directories must be gitignored.
- Directories should be mode `0700`; credential and token files should be mode `0600` on platforms supporting POSIX modes.
- Never include passwords, bearer tokens, cookies, challenge responses, authorization headers, or full authentication response bodies in errors.

### 3.2 Token cache

Key cached sessions by a collision-resistant account identity and target service, not username alone:

```js
const cacheKey = `${serviceId}:${account.username}`;
```

Store only the minimum needed to reconnect:

```json
{
  "token": "REDACTED",
  "actorId": "target-actor-id",
  "savedAt": 0,
  "expiresAt": 0
}
```

Prefer the server-provided expiration time. If none exists, use a conservative operator-configured TTL and treat rejection as authoritative. The current cache uses a six-day client TTL because its server tokens reportedly last about seven days; that assumption belongs only to the current realm in [`lib/connection.mjs`](./lib/connection.mjs).

Write cache files atomically and with explicit permissions. Validate the username-derived filename rather than allowing path traversal.

### 3.3 Interactive challenge

If the official login flow presents Turnstile, CAPTCHA, WebAuthn, MFA, or another interactive control:

1. Mark the account `needs_human_auth`.
2. Stop automated REST login retries.
3. Present an English dashboard instruction describing the official action required.
4. Open or instruct the operator to open an approved visible browser flow.
5. Let the human complete the challenge.
6. Capture only the resulting service session through an owner-approved mechanism.
7. Save the session locally and close the browser.
8. Resume only after validating the session through a harmless authenticated endpoint.

The current helper in [`get-token.mjs`](./get-token.mjs) demonstrates a visible, human-completed flow. Do not copy its DOM IDs or browser flags to a new target. In particular, do not add fingerprint-hiding switches or automated challenge-solving services.

If the target provides OAuth device authorization, prefer that over browser DOM automation:

```text
request device code
  -> show verification URL and user code
  -> human authorizes in official browser
  -> poll at the server-provided interval
  -> store access/refresh tokens securely
```

Respect `slow_down`, token expiration, and polling intervals from the OAuth response.

### 3.4 Authentication state machine

Implement and test these transitions:

```text
NO_SESSION
  -> authenticate or load cache
  -> SESSION_AVAILABLE
  -> validate / establish realtime session
  -> ONLINE

SESSION_AVAILABLE -- expired/rejected --> NO_SESSION
NO_SESSION -- interactive challenge --> NEEDS_HUMAN_AUTH
any state -- suspension/policy rejection --> STOPPED_POLICY
any nonterminal state -- transient failure --> BACKING_OFF
BACKING_OFF -- timer elapsed --> prior safe retry point
```

`STOPPED_POLICY` must not automatically transition back to login unless the service supplies an explicit end time and authorization permits retry. Even then, wait until that time plus a small safety margin.

## Phase 4: implement resilient transport

Use one connection object per account. It must own exactly one live socket, one reconnect timer, and one cancellation path.

Required properties:

```js
{
  socket: null,
  ready: false,
  closed: false,
  reconnectTimer: null,
  session: null,
  backoffMs: initialBackoff,
  state: 'idle',
  lastReadyAt: 0
}
```

Required behavior:

- The first connection failure must enter the same retry machinery as later disconnects.
- A network drop should reuse a still-valid session rather than performing another login.
- An explicit token rejection should invalidate the cache and authenticate once through the approved flow.
- A duplicate-session response should retry the real-time handshake with the same token after a short documented delay.
- A rate limit should honor `Retry-After`; otherwise use a conservative exponential backoff with jitter.
- Only one retry timer may exist per account.
- `close()` must cancel timers and prevent all future reconnects.
- Invalid inbound messages should be bounded in logs and must not crash the process.
- Maximum message size and parse limits should be configured where the WebSocket library permits it.

A safe delay helper is:

```js
export function retryDelay({ attempt, retryAfterMs, baseMs = 3000, capMs = 120000 }) {
  if (Number.isFinite(retryAfterMs) && retryAfterMs >= 0) return retryAfterMs;
  const ceiling = Math.min(capMs, baseMs * (2 ** attempt));
  // Full jitter spreads authorized clients without encoding a detector-specific pattern.
  return Math.floor(Math.random() * ceiling);
}
```

This jitter is for load distribution and retry stability, not impersonation. Do not tune it from inferred anti-bot scores.

### HTTP failure policy

| Signal | Required action |
|---|---|
| 400/validation error | Treat as implementation/configuration error; do not retry unchanged input |
| 401/expired token | Invalidate token and perform one approved refresh/auth flow |
| 403/interactive challenge | Enter `NEEDS_HUMAN_AUTH`; no automated login loop |
| 403/policy denial | Enter `STOPPED_POLICY` |
| 409/duplicate session | Retry only the session handshake after documented grace period |
| 429 | Honor `Retry-After`, then jitter; reduce fleet pressure |
| 5xx/network failure | Exponential backoff with jitter and a cap |

Do not classify every HTTP 403 as a challenge. The target adapter must distinguish challenge, permission denial, suspension, and application errors using documented codes or structured fields.

## Phase 5: normalize the real-time protocol

The decision engine should never consume raw target packets. Normalize snapshots into the smallest stable domain model it needs:

```js
{
  self: {
    id, x, z, hp, maxHp, resource, maxResource,
    level, dead, targetId, casting, cooldowns, inventory,
    quests, party, zoneId
  },
  entities: [
    { id, type, templateId, name, x, z, hp, maxHp, level,
      hostile, dead, targetId, flags }
  ],
  serverTime
}
```

Normalize events into explicit types:

```js
{ type: 'actor_death', actorId, killerId, at }
{ type: 'cast_stopped', actorId, abilityId, reason, at }
{ type: 'experience_gained', amount, at }
{ type: 'level_changed', level, at }
{ type: 'party_invitation', inviterId, inviterName, at }
```

Rules:

- Preserve opaque server IDs as strings unless the protocol guarantees safe integers.
- State coordinate units and axes explicitly.
- Do not use client receipt time as server event time when the server supplies a timestamp.
- Define whether snapshots replace all state or merge partial state.
- Define deletion/tombstone semantics.
- Reject or quarantine messages with impossible types rather than silently coercing them.
- Keep unknown target fields out of the core model until a decision genuinely needs them.

Write fixture-driven tests for every normalization rule.

## Phase 6: map abstract actions to target commands

Inventory every command issued through `ctx.cmd()` and `ctx.input()` before enabling the target adapter. Use `rg "ctx\\.(cmd|input)|conn\\.(cmd|input)"` to find call sites.

Define a target-independent action union:

```js
{ kind: 'move', vector: { x, z }, facing }
{ kind: 'stop' }
{ kind: 'target', actorId }
{ kind: 'cast', abilityId, targetId }
{ kind: 'loot', actorId }
{ kind: 'quest_accept', questId }
{ kind: 'quest_turn_in', questId }
{ kind: 'party_accept', invitationId }
```

The adapter converts those actions to wire messages. It must reject unsupported actions locally with a typed error. Never guess target command names or send development/admin commands to a live service.

Before sending an action, validate:

- the session is online;
- the action is on an allowlist;
- IDs have the expected type and length;
- numeric coordinates are finite and within documented bounds;
- string values are bounded;
- the account-level rate budget permits the action;
- any server-enforced cooldown known from authoritative state has elapsed.

Do not retry non-idempotent actions blindly. Assign client request IDs if the target supports idempotency keys. Otherwise wait for a state acknowledgement before deciding whether another attempt is safe.

## Phase 7: pacing and automation controls

The current realm includes randomized decision ticks and event reaction holds specifically matched to anti-bot assumptions. Those values are compatibility behavior for this realm, not a reusable design standard.

For another service, implement a declared pacing policy:

```js
export const pacing = {
  decisionIntervalMs: 250,
  maxCommandsPerSecond: 2,
  maxBurst: 2,
  minInteractiveDelayMs: 0,
  fleetStartSpacingMs: 5000
};
```

Populate it only from:

1. official API documentation;
2. explicit service-owner requirements;
3. conservative operational measurements in an authorized staging environment.

Use a token bucket or equivalent limiter at both account and process scope:

```js
class TokenBucket {
  constructor({ capacity, refillPerSecond, now = Date.now }) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerMs = refillPerSecond / 1000;
    this.updatedAt = now();
    this.now = now;
  }

  take(count = 1) {
    const current = this.now();
    this.tokens = Math.min(
      this.capacity,
      this.tokens + (current - this.updatedAt) * this.refillPerMs
    );
    this.updatedAt = current;
    if (this.tokens < count) return false;
    this.tokens -= count;
    return true;
  }
}
```

Rate limiting must delay or drop low-priority actions without reordering safety-critical stop commands. Prioritize roughly as follows:

1. stop movement / disconnect / cancel;
2. immediate survival actions;
3. required acknowledgements;
4. combat actions;
5. navigation updates;
6. looting, inventory, and market actions.

If the target requires an automation identifier or dedicated bot account type, add it. Do not claim to be an official interactive client.

## Phase 8: replace world and game data

The current decision logic depends on generated and authored data for classes, abilities, mobs, items, vendors, quests, routes, density, and dungeons. Do not reuse those values unless the target contract says they are identical.

Create target-specific data importers from authoritative, versioned sources. Each generator should:

1. Accept an explicit source path or API fixture.
2. Validate the source schema.
3. Emit deterministic output.
4. Record the source version or content hash.
5. Fail when required fields are missing.
6. Have a `--check` mode that detects stale generated output without rewriting it.

At minimum, reconcile these semantics:

- playable roles/classes and their resource systems;
- ability IDs, ranges, costs, cast times, cooldowns, and targeting;
- entity hostility and aggro behavior;
- navigation coordinate system and collision model;
- death, resurrection, and penalty behavior;
- loot ownership and inventory capacity;
- quest lifecycle and prerequisite graph;
- party size and invitation rules;
- dungeon entry, completion, and reset behavior;
- vendor and marketplace transaction semantics.

If a semantic mismatch changes a decision invariant—for example, movement cancels casting on one service but not another—modify the normalized model and tests before changing decision code.

## Phase 9: fleet and dashboard integration

Preserve dashboard-first startup. Starting the dashboard must not require credentials and must not automatically start bots until the saved enabled count is applied through the existing UI flow.

The target integration must enforce:

- `0 <= enabledBots <= min(5, authorizedTargetLimit)`;
- unique account identity per simultaneous session unless the target explicitly permits otherwise;
- staggered session startup;
- a process-wide rate budget;
- independent connection state and stop controls per bot;
- redacted browser state;
- English operational messages;
- loopback dashboard binding by default.

Expose safe status fields such as:

```js
{
  service: 'target-name',
  accountLabel: 'Bot 1',
  online: false,
  authState: 'needs_human_auth',
  retryAt: null,
  lastErrorCode: 'INTERACTIVE_CHALLENGE',
  hasPassword: true
}
```

Never expose raw usernames if the deployment considers them sensitive. Never expose tokens, cookies, passwords, challenge responses, raw headers, or unredacted upstream error bodies.

## Phase 10: watchdog and stop conditions

Keep transport health separate from gameplay progress. Track:

- whether the bot has ever become ready;
- last successful snapshot time;
- last acknowledged command time;
- last movement or domain progress time;
- repeated deaths or equivalent failure loops;
- authentication state;
- pending retry and its cause.

Required stop conditions include:

- suspension, ban, lock, or explicit policy denial;
- repeated interactive challenge without human action;
- invalid credentials after one confirmed attempt;
- protocol version mismatch;
- malformed message volume exceeding a small threshold;
- target concurrency limit exceeded;
- credential or token file permissions cannot be secured;
- dashboard exposed beyond the configured trusted interface without operator intent.

The watchdog may reconnect transient failures and reset internal navigation state, but it must not turn terminal policy failures into infinite retries.

## Phase 11: tests

Run the full existing test suite for implementation changes and add focused tests for the target integration.

### Unit tests

- Authentication request construction excludes secrets from logs.
- Token cache uses the service/account namespace and rejects expired entries.
- Browser/dashboard payloads contain `hasPassword` but no password.
- Every HTTP and real-time failure maps to the correct category.
- `Retry-After` in seconds and HTTP-date formats is honored.
- Only one reconnect timer can exist.
- `close()` prevents reconnect.
- Raw snapshots normalize correctly.
- Full snapshots delete absent entities if that is the declared target semantic.
- Incremental snapshots preserve unaffected entities.
- Unknown message types do not crash the process.
- Every abstract action encodes to the expected fixture.
- Unsupported actions are rejected locally.
- Rate limiting respects both per-account and process-wide budgets.
- Fleet size cannot exceed the repository or target limit.
- Suspension and policy errors are terminal.
- Interactive challenges produce `needs_human_auth` without retry storms.

### Integration tests with a fake service

Build a local HTTP/WebSocket fake that can script:

1. successful auth and session readiness;
2. token expiration followed by one refresh;
3. network drop followed by token reuse;
4. duplicate session followed by successful same-token retry;
5. 429 with `Retry-After`;
6. interactive challenge requiring operator state;
7. suspension with and without an end time;
8. malformed and oversized messages;
9. graceful shutdown with a pending retry.

Use a fake clock for backoff and limiter tests. Do not make timing tests sleep in real time.

### Required repository validation

After implementation:

```bash
npm test
```

Also run focused configuration, credential-redaction, fleet-sizing, target-adapter, and connection tests directly. Smoke-test that `./start.sh` serves the dashboard with zero configured credentials. Then, against the local fake service, configure one bot in the UI and verify it reaches `ONLINE`, receives a snapshot, sends an allowed command, disconnects, and reconnects.

Do not claim live-service validation unless it was performed with authorized accounts. Record which environment, account count, duration, and behaviors were actually tested without recording account secrets.

## Phase 12: staged rollout

Use this order:

1. Static fixture tests only.
2. Local fake-service integration.
3. Owner-provided staging with one account and read-only/no-op actions where possible.
4. Staging with a minimal allowed action set.
5. Authorized production smoke test with one account for a bounded window.
6. Gradual increase up to the smaller of the repository limit and authorized target limit.

At every stage, define rollback as disabling the account and closing its connection. Do not automatically escalate concurrency after errors, rate limits, challenges, or policy messages.

Monitor:

- authentication attempts per hour;
- session reconnects by reason;
- HTTP 429 count and retry delays;
- commands sent per account and process;
- rejected commands by category;
- time since last snapshot;
- terminal stop states;
- credential-redaction test status.

Do not log complete inbound/outbound packets in production. Use message type, bounded identifiers, sizes, and correlation IDs.

## Definition of done

The adaptation is complete only when all of the following are true:

- Authorization and target limits are recorded.
- The target protocol matrix has no architecture-affecting unknowns.
- Target-specific logic is isolated behind an adapter.
- The dashboard starts without credentials.
- Credentials and tokens remain local, permission-restricted, gitignored, redacted, and absent from logs.
- Interactive challenges stop for human completion through the official flow.
- Rate limits and `Retry-After` are honored.
- Suspension and policy errors stop automation.
- Reconnects reuse valid sessions and cannot create timer storms.
- The core brain consumes normalized state and emits abstract actions.
- Target data is generated deterministically from an authoritative source.
- The configured fleet cannot exceed either limit.
- Automated tests pass.
- Dashboard-first and fake-service smoke tests pass.
- Any unavailable staging or live validation is explicitly reported.
- `README.md` identifies the single primary launcher and includes the target's operator workflow.

## Current-realm compatibility note

For World of Claudecraft itself, the existing implementation contains realm-specific behavior that must remain compatible unless the realm protocol or repository authority changes:

- local token reuse and expiry behavior in [`lib/connection.mjs`](./lib/connection.mjs);
- a human-completed Turnstile flow in [`get-token.mjs`](./get-token.mjs);
- staggered fleet startup in [`fleet.mjs`](./fleet.mjs);
- realm-specific event handling and decision pacing in [`autobot.mjs`](./autobot.mjs) and [`fleet.mjs`](./fleet.mjs);
- regression assumptions in [`tests/humanize.test.mjs`](./tests/humanize.test.mjs).

Those details document current compatibility; they are not evidence that another service permits automation or that its controls should be imitated or defeated. For a new target, use documented limits and explicit owner requirements, retain human control over interactive challenges, and fail closed on policy uncertainty.

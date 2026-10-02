# Changelog

All notable changes to this project are documented in this file, together with the
[README](README.md). The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Each entry records what changed, why, and — where a change narrows or widens what the plugin can do — which
section of the README's [Known limitations](README.md#known-limitations) it moves.

## [Unreleased]

Nothing yet.

## [0.3.0] — 2026-10-02

A compact panel and an editable settings tab.

### Changed

- **The panel lost two rows.** The headline is now `total_balance` — topped-up money plus granted credit — and
  the `topped up` caption and `total … granted …` line are gone. The header already names the figure, so the
  caption was repeating it, and the total *is* the balance: leading with only the topped-up part reads as zero
  on an account living on granted credit. The granted/topped-up split moves into the settings tab, and the
  pill's label lost the same words.
- README limitation 14 rewritten: it covered a **new** install needing a restart, but not the case that
  actually bit — **editing** an already-loaded host half. Troubleshooting gained a row pointing at
  `pluginVersion` and `cost.reason`.

### Added

- **A settings tab.** A gear button on the panel opens a *Budget* tab in the right sidebar with every option as
  an editable field. Durations are shown in seconds and minutes and converted back on save. The API key field
  is write-only and tri-state — absent leaves it, empty clears it — so an untouched password box cannot delete
  the user's key. The gear is rendered only when a tab could actually be registered.
- **`POST /dsh-budget-watcher/config`**, writing through DSH's own `configEditor` service so the change lands
  in the profile's `cordis.patch.yml` and is applied by the normal loader path. A value set back to its default
  is removed rather than written, so the row returns to inheriting.
- **Request validation before the write.** An allow-list of editable keys, per-key type checks, an 8 KiB body
  cap, and a required `application/json` content type — the last is what stops a cross-site form from reaching
  the write path at all. Validation runs before the profile patch is opened, so a mistyped field is refused
  without touching the user's config file.
- **`@deepseek-ai/schemastery` as a peer dependency.** Its absence was a real defect: `Config` was silently
  `undefined`, so the plugin's schema never reached the runtime and config was never validated. Declaring the
  peer is what lets DSH resolve it from the installation. Deliberately *not* a `@deepseek-ai/dsh*` peer, whose
  ranges the compatibility gate checks and can skip the whole row over.
- **`pluginVersion` in every payload.** A host module is imported once and cached for the life of the DSH
  process, so an edited plugin keeps serving its old code until that process restarts; a version marker makes
  that visible instead of something to deduce from process start times.
- **`cost.reason` when there are no cost figures** (`disabled`, `no-live-sessions`, `failed`). An omitted key
  is indistinguishable from a bug; the payload now says which it is.

### Fixed

- **`total_balance` is no longer assumed present.** It is reconstructed from its parts, in integer hundredths so
  the sum carries no float error; a wallet reporting only its parts would otherwise render as `0.00`.
- **Config was never validated**, because the schema never loaded. See the peer-dependency note.

### Decisions worth recording

- **The settings transport is the plugin's own route, not `remote.settings`.** The generated path needs a
  schemastery `Config` with every field `.volatile()` plus a client form built on `configForms`. The route is
  smaller, is testable without a live page, and was verified writing a real profile patch. Migrating is the
  natural next step if the plugin grows more settings.
- **Ordinary config over volatile fields.** Volatile fields avoid a fiber reload, but arrive as live getter
  objects that must be dereferenced on every read. A reload on save measured as a blip and is easier to reason
  about.

### Known limitations at this version

The README list gains 26–31. Highlights: the gear needs a right sidebar and the write needs `configEditor`,
both optional; saving reloads the plugin's fiber and clears its in-memory cost ledger; a home patch or
`--patch` overlay on the same row makes it unwritable; and the settings transport is bespoke rather than the
generated one.

## [0.2.0] — 2026-10-02

Adds cost estimates, and makes the expanded panel draggable from anywhere.

The motivating case: a deep-research skill fanned 64 target sites out to subagents and burned ¥15 in twenty
minutes. The conversation showed one turn, still open, with no answer yet. Balance alone says *that* you are
spending; it cannot say *how fast*, which is the number that decides whether to stop.

### Added

- **`lib/cost.js`** — DeepSeek's published rate card, peak/off-peak selection from the call timestamp, a
  usage→USD function, and a fold from session events to per-turn token and cost totals. Pure: no DSH imports,
  no `fetch`, so it is directly testable.
- **`lib/ledger.js`** — decides which sessions count as one conversation's spend. It folds the selected session
  **and every subagent session beneath it**, because a fan-out bills in the children. A finished subagent keeps
  contributing, so the total never falls — the one direction a spend counter must not move.
- **Three figures in the panel**: `last turn` (updates while the turn is still running), `session` with an
  `N agents` suffix, and `burn` — spend over the last window projected per hour. This is the early warning: it
  moves within a minute of a fan-out starting, long before the turn finishes.
- **A burn warning**: `burnWarnUsdPerHour` tints the burn figure and turns the dot amber. The dot survives
  collapsing the panel, so a runaway is visible from the pill.
- **Session handshake**: the client names the conversation it is showing, read from the root slot kit's
  `useSessions` the same way DSH's own title bar reads it, and sends it as `?session=`. The host falls back to
  the newest live root session, so an older client still gets an answer.
- **Config**: `costEnabled`, `burnWindowMs`, `burnWarnUsdPerHour`, `usdToCny`, `costCurrency`.
- **Tests**: 90 total, up from 39 — the rate card and fold arithmetic, the ledger tree (fan-out, descendants,
  finish-must-not-subtract, sibling isolation, unpriced models), the route's cost payload, and the client's
  cost rendering, drag scoping and session handshake.

### Changed

- **The expanded panel drags from anywhere on it**, not only its title bar. A press that lands on a control is
  left alone, so collapse and refresh still work. The collapsed pill deliberately installs no drag handling at
  all: a pill you can nudge by accident is a pill you cannot click.
- `docs/screenshot.png` recaptured against the new panel.

### Fixed

- **Cached input was priced wrongly.** The first cut subtracted `cacheReadTokens` from `inputTokens`, which
  looks like the obvious arithmetic and is wrong: DSH's `inputTokens` is the **uncached** half and the cache
  buckets are separate. On a well-cached turn the subtraction collapsed the uncached half to zero and
  under-reported exactly the turns worth watching. `dsh-llm-deepseek` states the identity outright —
  `totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens` — and there is now a test
  that fails if a large cached prefix is allowed to cancel a smaller uncached remainder. The turn and session
  fields were renamed `uncachedInputTokens` so the distinction cannot be lost again.
- **Retried attempts were free.** A failed attempt settles as `assistant/attempt`, which carries no `usage`
  field at all; its numbers survive only in the last `usage` chunk of its stream. Reading just `usage` dropped
  the cost of every retry. Both event kinds are now folded, using the same two-tier read DSH's own token meter
  performs.

### Decisions worth recording

- **No tokens are spent to produce an estimate.** The feature was asked for as "using a small amount of tokens
  to take a crude estimate"; the usage DeepSeek already reports on every assistant message is exact, already
  logged, and free. Paying a model to guess at a number that is already on disk would be strictly worse —
  costlier, slower, and less accurate.
- **The recent burn rate, not the last turn, is the warning.** A fanned-out turn does not finish, so a "cost of
  the last completed turn" would stay silent through the entire runaway. Cost is accumulated per assistant
  message with its own timestamp, and the warning comes from a short window projected per hour.
- **Descendants are counted, and a finished one keeps counting.** Counting only the session on screen reports
  the calm, not the fire; letting a finished subagent drop out would make the total fall as work completes.
- **An unpriced model is reported, never estimated.** A silent zero reads as "that turn was free".
- **The DSH deprecation is accepted knowingly.** `ownEvents()` / `snapshotEvents()` are the only whole-log
  reads a plugin has, and DSH's own README prohibits new production calls to them. Every call is wrapped, so if
  a future release removes them the cost section disappears and the balance keeps working.

### Known limitations at this version

The full list lives in the [README](README.md#known-limitations); the cost feature adds limitations 16–25.
Highlights: the rate card is a dated snapshot rather than a feed; Chinese public holidays are not modelled, so
a holiday weekday is priced at the peak rate (an overestimate); the USD→CNY rate is configured, not fetched;
and only spend observed while the plugin is loaded is counted, so a fan-out that finished before it loaded is
missing from the session total.

## [0.1.0] — 2026-10-02

First release. A floating window over the conversation showing the topped-up balance left on the DeepSeek API
account, collapsed to a pill on demand and draggable anywhere in the frame.

### Added

- **Host half** (`index.js`): resolves the API key at every refresh through `ctx.credentials` (falling back to
  `apiKey` in config, then the launch environment), calls `GET https://api.deepseek.com/user/balance`, and
  serves a normalized snapshot from `GET /dsh-budget-watcher/balance`.
- **Client half** (`lib/client.cjs`): registers into the frame-wide `shell.overlay` slot and draws the balance
  with `React.createElement` against the `--dsw-*` theme tokens. Hand-written in the loader's classic-script
  lazy-CJS format — no bundler, no JSX, no runtime dependencies.
- **Caching with single flight**: one upstream answer is reused for `refreshIntervalMs`, and concurrent requests
  share one in-flight call, so several open windows cost one request.
- **Stale-but-visible failures**: a failed refresh keeps the last known number on screen and labels it, instead
  of blanking the panel. An unreadable body is reported as a protocol error, never rendered as `0.00`.
- **Same-origin fence** on the plugin's route: loopback `Host`, `Origin` matching `Host`, and
  `sec-fetch-site: cross-site` refused. `allowNonLoopback` opts out of the loopback requirement only.
- **Pure, testable core** (`lib/balance.js`): payload normalization, currency selection and HTTP-failure
  messaging, free of DSH and `fetch` imports.
- **Config**: `provider`, `apiKey`, `apiKeyEnv`, `endpoint`, `refreshIntervalMs`, `requestTimeoutMs`,
  `currency`, `allowNonLoopback`.
- **Tests** (`node --test`, 39 tests): the normalizer's accepted and rejected shapes, the route against a
  stubbed API (caching, `?refresh=1`, every failure mode, the fence), and the client bundle loaded in a VM with
  a stubbed module loader (registration id, exported service set, slot mounting, rendering per host state,
  unmount cleanup).
- **Docs**: `README.md` with install, configuration, the key-resolution order, how it works, troubleshooting
  and a known-limitations list; `docs/screenshot.png` captured from a real browser.

### Decisions worth recording

- **`topped_up_balance` is the headline, not `total_balance`.** The feature was asked for as "the topped-up
  balance left". `total_balance` includes promotional credit that expires, so leading with it would overstate
  what the user paid for. The split appears underneath when the two differ.
- **The public API, not DSH's account service.** DSH already exposes `ctx.deepseekAccount.getBalance()`, but it
  authenticates with a signed-in Platform OAuth grant and returns a different figure with no `is_available`.
  Reading it would have made the widget disagree with the API key the profile actually bills against. This is
  recorded as limitation 2.
- **A plugin-owned route rather than a Typert `@Remote` service.** The Remote path needs a build-time generator
  that is not shipped in a DSH installation; hand-authoring its reflection artifacts is a large amount of
  scaffolding for one read-only number. The web-server route is the pattern a shipped third-party plugin in
  this build already uses.
- **No schemastery import at module scope.** A static import of a package that a given installation does not
  carry would stop the whole profile from loading. The import is dynamic and its absence only costs config
  validation. Recorded as limitation 8.
- **No `@deepseek-ai/dsh*` peer dependencies.** The compatibility gate only inspects those names, so declaring
  none means it can never refuse the plugin. Recorded as limitation 13.
- **The client half uses `setInterval` inside a component effect, not `ctx.timer`.** The component's own
  lifetime is the right scope: collapsing to a pill must stop the poll even though the plugin's fiber lives on.
- **`inject = ["slots"]` and nothing else.** On the web boot path a declared service the profile does not
  provide leaves the fiber pending and fails the *entire page*, so the hard dependency set is kept to the one
  service that is always present wherever `shell.overlay` exists.

### Known limitations at this version

The full list lives in the [README](README.md#known-limitations). Highlights: DeepSeek is the only provider; the
API-key balance is not the signed-in Platform account balance; the route is loopback-only unless
`allowNonLoopback` is set; polling rather than push, with a 15 s floor; and a new install requires a profile
restart.

[Unreleased]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/NeutronStar714/dsh-budget-watcher/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/NeutronStar714/dsh-budget-watcher/releases/tag/v0.1.0

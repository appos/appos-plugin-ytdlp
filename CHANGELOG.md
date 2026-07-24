# Changelog

All notable changes to the yt-dlp Media Downloader plugin will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] - 2026-07-15

Migration to the AppOS core-plugin API surface (Public Action Fabric,
Core Notifications). Functionally identical for users; adds
typed/auditable action surfaces and routable download notifications.

### Added
- Public Action Fabric integration: all 5 palette verbs
  (`recheck-dependencies`, `open-download-panel`, `open-library-panel`,
  `clear-completed`, `paste-and-download`) are bridged into the typed action
  catalog via `actions.registerFromCommand(...)` — they gain ActionReceipt
  audit rows, rate limiting, Settings → Actions browsing, and (for
  `paste-and-download`) cross-plugin/agent/automation invocability. The
  legacy `commands.register` surface remains (permanent private namespace)
- New `downloadUrl` public action (`space.appos.ytdlp:downloadUrl`) wrapping
  the download engine with a typed input schema `{url, format?, quality?}` —
  `api`/`agent`/`automation` visibility, so LLM agents (via ToolSpec
  projection), other plugins, scheduler jobs, and recipes can trigger
  downloads programmatically
- Manifest `extensions[]` with 6 `actions.definition` contributions
  mirroring the runtime registrations (two-tier discovery: palette /
  `actions.all()` see the verbs before any JS runs; runtime registration
  binds the executable handlers)
- Core Notifications integration: terminal download events (`complete` /
  `failed`) now emit typed, user-routable notifications
  (categories `download.complete` / `download.failed`) that flow through
  routing rules, quiet hours, dedupe, and the delivery log — deliverable to
  Notification Center or webhooks. Inline panel toasts are unchanged
- Local typings shim (`src/types/appos-core-apis.d.ts`) declaring the
  `ActionsNamespace` and `NotificationsNamespace` on `PluginContext`
  (the published `@appos.space/plugin-types` SDK does not yet declare the
  Actions / Notifications surfaces). Both are optional-chained — the plugin
  still activates cleanly on older hosts, skipping registration

### Changed
- Dev dependencies now point at the published npm SDK packages
  (`@appos.space/plugin-types` / `plugin-utils` / `view-builders` `^2.4.0`)
  instead of local workspace paths; the package is marked `"type": "module"`
  so the tsx-based test runners resolve the SDK packages' ESM-only exports
- Manifest permissions: added `actions.register`, `actions.invoke`,
  `notifications.emit`; added plugin dependencies on
  `space.appos.core.actions` and `space.appos.core.notifications`
  (`notifications.emit` requires the `actions.invoke` scope and a
  non-optional dependency on the Core Notifications plugin)
- Workspace auto-apply is first-run-only again (`applyIfFirstRun`) instead
  of overriding the user's selected workspace on every launch; the
  open-panel verbs and the menubar icon still apply the workspace on demand

### Removed
- Debug/diagnostic activation toasts left over from the resolved
  activation-hang investigation ("plugin activated", "reached Step 11",
  "workspace applied", "state loaded")
- Declared-but-unused permissions: `ui.sidebar`, `ui.contextMenu`,
  `ui.shortcuts`, `ui.statusBar`, `network`, and the stale
  `ui.notifications` (superseded by `notifications.emit`).
  `feedback.confirm` is retained — it gates `feedback.alert()`, used by the
  library panel's delete-from-disk confirmation

## [1.0.0] - 2026-04-11

### Changed
- Rewrote the entire plugin against `@appos.space/plugin-types`, `@appos.space/view-builders`, and `@appos.space/plugin-utils` SDK packages
- Migrated to host Dependency Management via `ctx.lifecycle.getDependencyStatus()`, `recheckDependencies()`, and `onDependencyStatusChanged()` -- the host now probes for yt-dlp/ffmpeg and renders a native Dependency Issues panel in the sidebar
- Unified the queue dashboard into the download panel (2-panel limit compliance: download + library only)
- Canonical settings keys: `outputDir`, `proxyUrl`, `filenameTemplate`, `defaultFormat`, `defaultQuality`, `metadataDepth`
- Settings persistence uses `{ persist: true }` with generation-guarded debounced writers
- State manager uses sharded Cache API keys (`ytdlp:queue`, `ytdlp:library`, `ytdlp:history`) with per-shard debounced writers

### Added
- Resume-loop pattern (`shell-with-retry`) to survive the 120-second host shell timeout via `--continue` + `--download-archive` with progress-aware retry (up to 20 attempts, 3 stall max)
- Security module with URL validator (scheme, length, control characters), yt-dlp argument deny-list (blocks `--exec`, `--batch-file`, `--postprocessor-args`, etc.), and filename template sanitizer
- `extracting` queue entry state for post-download ffmpeg merge/transcode/embed phases
- Path helpers module (`core/paths.ts`) with home-directory probing (duck-typed SDK probe + `process.env.HOME` fallback), conditional `~` expansion (only when home dir is resolvable -- typically unavailable in the plugin sandbox, so users must provide absolute paths), output directory validation, and `ensureOutputDir`
- Playlist service with `--flat-playlist` probing, URL normalization (handles bare extractor IDs), `PlaylistSelection` API, and canonical `groupTag`/`groupLabel` generation
- Degraded-state banner in both WebView panels (accessible: `role="status"`, `aria-live="polite"`) that auto-hides when all required dependencies are satisfied
- CLI preview in the download form showing the exact yt-dlp command before enqueue
- Paste-and-download command that reads clipboard, validates URL, and enqueues with defaults (keyboard shortcut deferred to v1.1)
- `pipeShellToWebPanel` integration for direct CLI-to-WebView streaming with plugin-side `onData` progress parsing
- Throttled queue-update broadcasts at 10 Hz and lightweight progress-only state mutations to avoid O(state size) panel traffic on high-frequency ticks
- Keyed list rendering with DOM diffing (`webview/shared/ui-helpers.js`) for smooth queue and library updates
- Library grid/list view toggle with search (debounced 250ms), sort, favorites-only filter, and scroll-driven virtualization for list mode (>200 items)
- Workspace template with outputDir-anchored file browser tab, re-registered on settings change
- First-run workspace auto-apply via `ytdlp:initialized` cache flag
- Smoke test script (`scripts/smoke.mjs`) that loads `dist/main.js` in a VM, calls `activate(mockCtx)`, and exercises error-parser and security module fixtures
- Unit tests for error parser, security module, state manager, paths, shell-with-retry, metadata service, and playlist service
- Versioned message protocol (`v: 1`) with discriminated union types as the single source of truth for all WebView messages

### Removed
- Manual `dependency-checker.ts` and setup wizard (replaced by the host dependency sidebar)
- Local copy of `plugin-api.d.ts` (replaced by `@appos.space/plugin-types`)
- `"which"` from `shellCommands` in plugin manifest (host probes dependencies directly)
- Separate queue dashboard panel (merged into download panel's queue view tab)

### Fixed
- State persistence: added missing `{ persist: true }` to all cache writes; fixed double JSON parse bug in state hydration
- ffmpeg-aware format fallback: auto-downgrades to pre-muxed format when ffmpeg is unavailable instead of failing silently
- Cancel race condition: abort flag is re-checked after executor resolves so user intent wins over late success
- State hydration validates persisted QueueRequestSnapshot fields (format, quality, outputDir, filenameTemplate, archivePath, tempDir) and drops entries with invalid/missing data rather than crashing at runtime
- Path fields validated as absolute POSIX paths during hydration -- tilde or relative paths from old schema cannot reach shell execution
- Debounced writers use generation tokens so stale callbacks from previous init cycles no-op instead of writing to the wrong context
- Listener dispatch snapshots the subscriber array before iteration so self-unsubscribing callbacks cannot skip other listeners
- Smart folder mutable state scoped per-registration to prevent cross-contamination on reactivation
- Recent filter uses stored timestamps compared at `Date.now()` evaluation time rather than precomputed boolean sets that go stale

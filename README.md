# yt-dlp Media Downloader

> A polished GUI for yt-dlp -- paste a URL, pick a format, download. First title in the AppOS Plugin Store.

*Screenshots are coming soon.*

## What it does

- **Paste and Download** -- paste any supported URL, auto-probe for formats, pick quality, download with one click
- **Streaming Progress** -- real-time progress bars via `pipeShellToWebPanel` with speed, ETA, and per-entry status
- **Playlist Support** -- lightweight flat-playlist probing (capped at 500 entries), per-video selection, batch queueing with group tags
- **Library Browser** -- grid/list view of completed downloads with thumbnails, search, sort, and favorites
- **Media Playback** -- click any library entry to play in the native file viewer pane
- **Smart Folders** -- Videos, Audio, Favorites, Recent (7 days) via the Smart Folders API
- **MenuBar Integration** -- background downloads with badge count; click the icon to open the workspace
- **Workspace Template** -- dual-pane layout with downloads on the left, library + file browser + web browser on the right
- **Resume Loop** -- survives the 120-second host shell timeout via `--continue` + `--download-archive` with progress-aware retries
- **Human-Readable Errors** -- yt-dlp stderr parsed into clear, actionable messages for non-technical users
- **Security** -- URL validation, yt-dlp argument deny-list (blocks `--exec`, `--batch-file`, etc.), filename template sanitization

## Requirements

- **AppOS** v1.0.0 or later
- **macOS** 14.0 (Sonoma) or later
- **yt-dlp** (required) -- install via Homebrew: `brew install yt-dlp`
- **ffmpeg** (optional) -- install via Homebrew: `brew install ffmpeg`

Dependencies are managed by the host's dependency management system. If yt-dlp or ffmpeg is missing, a Dependency Issues panel appears in the sidebar with install hints and clickable links. The plugin enters degraded mode (banner shown, downloads blocked) until yt-dlp is available.

## Installation

### From the Plugin Store (recommended)

Search for "yt-dlp" in the AppOS Plugin Store and click Install. Grant the requested permissions when prompted. The plugin's menubar icon appears immediately.

### Manual

    git clone https://github.com/appos/appos-plugin-ytdlp.git
    cd appos-plugin-ytdlp
    npm install && npm run build
    cp -r . ~/Library/Application\ Support/AppOS/plugins/space.appos.ytdlp/

Restart AppOS to load the plugin.

## How it works (for plugin developers)

This plugin is the canonical reference for the AppOS Plugin API. Every pattern listed below is production-tested and commented.

| Pattern | Files |
|---------|-------|
| WebView panels (register, message handler, bidirectional messaging) | `src/panels/download-panel.ts`, `src/panels/library-panel.ts` |
| `pipeShellToWebPanel` (direct CLI-to-WebView streaming) | `src/services/downloader.ts` |
| `shell.execute` with `onData` (streaming shell output) | `src/services/downloader.ts`, `src/services/metadata-service.ts` |
| Shell-with-retry (120s timeout mitigation via resume loop) | `src/services/shell-with-retry.ts` |
| Workspace templates (dual-pane layout) | `src/workspace/template.ts` |
| MenuBar integration (icon, reactive badge, click-to-open) | `src/menubar/menubar.ts` |
| Smart folder filter types (closure-based evaluate) | `src/smart-folders/filters.ts` |
| Cache API persistence (sharded, debounced, generation-guarded) | `src/core/state.ts` |
| Host dependency management (`ctx.lifecycle.*`) | `src/main.ts` |
| Security module (URL validation, arg deny-list, template sanitization) | `src/core/security.ts` |
| Error parsing (stderr to human-readable messages) | `src/core/error-parser.ts` |
| WebView bridge (host-injected `window.twopanez` wrapper) | `webview/shared/bridge.js` |
| Versioned message protocol (v:1 discriminated unions) | `src/types/webview-messages.ts`, `webview/shared/messages.js` |
| Degraded-state banner (accessible, auto-hides on satisfied) | `webview/shared/degraded-banner.js` |
| Keyed list rendering with DOM diffing | `webview/shared/ui-helpers.js` |

## Architecture

    src/
    +-- main.ts                  # Entry point -- activation order, lifecycle, disposables
    +-- constants.ts             # Panel IDs, timing, error patterns, format presets
    +-- types/
    |   +-- index.ts             # Barrel re-export
    |   +-- plugin-state.ts      # Queue/library/settings shapes, error categories
    |   +-- webview-messages.ts  # Versioned message contract (single source of truth)
    |   +-- yt-dlp.ts            # Raw JSON types, metadata, playlist, progress
    +-- core/
    |   +-- error-parser.ts      # stderr -> ParsedError (pure, no host deps)
    |   +-- security.ts          # URL validator, arg deny-list, template sanitizer
    |   +-- state.ts             # Cache API persistence, pub/sub, panel broadcast
    |   +-- paths.ts             # Home-dir expansion, outputDir validation
    +-- services/
    |   +-- shell-with-retry.ts  # 120s timeout mitigation, resume args builder
    |   +-- downloader.ts        # Queue processor, pipeShellToWebPanel, cancel/retry
    |   +-- metadata-service.ts  # URL probing via --dump-json, playlist detection
    |   +-- playlist-service.ts  # --flat-playlist probe, URL normalization, selection
    +-- panels/
    |   +-- download-panel.ts    # Download panel registration and message routing
    |   +-- library-panel.ts     # Library panel registration and message routing
    +-- workspace/
    |   +-- template.ts          # Dual-pane workspace, first-run auto-apply
    +-- menubar/
    |   +-- menubar.ts           # NSStatusItem, reactive badge, click-to-open
    +-- smart-folders/
        +-- filters.ts           # Videos/Audio/Favorites/Recent filter types

    webview/
    +-- shared/
    |   +-- bridge.js            # Host bridge wrapper (twopanez -> stable API)
    |   +-- messages.js          # Message builder and inbound validator
    |   +-- degraded-banner.js   # Dependency-missing banner (accessible)
    |   +-- ui-helpers.js        # Debounce, throttle, keyed renderList, escapeHtml
    |   +-- styles.css           # Shared base styles
    +-- download/
    |   +-- index.html           # Download panel markup
    |   +-- form.js              # URL input, probe, playlist, advanced options
    |   +-- queue.js             # Queue view with progress, cancel, retry
    |   +-- switch.js            # Form/queue tab switching with auto-switch
    |   +-- styles.css           # Download panel styles
    +-- library/
        +-- index.html           # Library panel markup
        +-- app.js               # Grid/list, search, sort, favorites, virtualization
        +-- styles.css           # Library panel styles

## Development

    npm install
    npm run build          # One-shot build (esbuild -> dist/main.js)
    npm run watch          # Watch mode (rebuild on save)
    npm run typecheck      # TypeScript type checking (tsc --noEmit)
    npm run test:units     # Unit tests (error parser, security, state, paths, services)
    npm run test:smoke     # Smoke test (loads bundle, calls activate, exercises fixtures)

Typecheck covers two compilation worlds. The main `tsconfig.json` checks
`src/**/*.ts` against the JavaScriptCore plugin runtime: `lib` is `["ES2022"]`
with **no `DOM`** (there is no `document`/`window`/browser `fetch` in JSC — use
`ctx.network.fetch`), and `src/jsc-globals.d.ts` declares the globals the
runtime genuinely provides (native `console`; timer quartet typed `| undefined`
so unguarded `setTimeout(...)` fails TS2722 while a `typeof setTimeout ===
'function'`-narrowed call compiles). `tsconfig.webview.json` checks `webview/`
against the DOM and sets `skipLibCheck: false` on purpose: the only declaration
file in that program is the project-owned `webview/twopanez.d.ts`, so lib-check
must stay on or corruption inside that file is silently suppressed — which is
exactly what the config exists to catch.

Deploy to AppOS for testing:

    rsync -av --exclude node_modules --exclude .git . \
      ~/Library/Application\ Support/AppOS/plugins/space.appos.ytdlp/

## Known limitations

- **Cancellation is best-effort.** Shell processes cannot be killed mid-flight from the plugin layer; cancel takes effect at the next retry-loop attempt boundary.
- **ffmpeg subprocess orphans on cancel during merge.** yt-dlp spawns ffmpeg as a child process; the host's `Process.terminate()` only signals the direct child. Orphaned ffmpeg processes clean up on their own but may briefly consume resources.
- **Playlist cap of 500 entries per probe.** Flat-playlist enumeration must complete within the 120s shell timeout. Larger playlists require pagination (planned for v1.1).
- **No cookies-from-browser in v1.** The `--cookies-from-browser` flag is on the deny-list. Browser cookie support with explicit UX is planned for v1.1.
- **No home-directory API in practice.** The plugin includes `~` expansion code (probes a future SDK API and `process.env.HOME`), but both are typically unavailable in the plugin sandbox. Users must provide an absolute path for `outputDir` in plugin settings.

## License

MIT -- see [LICENSE](LICENSE)

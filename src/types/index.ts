/**
 * Barrel re-export for all shared type contracts.
 *
 * Import from `'../types'` (or `'./types'`) to access any type defined
 * across the three focused modules.
 *
 * @module types
 */

export type {
    DownloadStatus,
    QueueEntry,
    QueueRequestSnapshot,
    LibraryEntry,
    ParsedError,
    ParsedErrorCategory,
    SettingsSnapshot,
    PluginState,
    DependencyStatus,
} from './plugin-state';

export type {
    RawYtDlpJson,
    MediaMetadata,
    FormatInfo,
    PlaylistEntry,
    ProgressTick,
} from './yt-dlp';

export type {
    PanelOutboundMessage,
    PanelInboundMessage,
} from './webview-messages';

export { parseInbound } from './webview-messages';

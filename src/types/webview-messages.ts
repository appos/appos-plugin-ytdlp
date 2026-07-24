/**
 * WebView ↔ Plugin message contract — **single source of truth**.
 *
 * Every message between the yt-dlp plugin and its WebView panels is defined
 * here as a versioned (`v: 1`) discriminated union. Downstream tasks that add
 * new messages MUST update this file FIRST.
 *
 * Host envelope: The webview receives messages wrapped by the host in
 * `{ data, instanceId, windowId, paneId }`. The actual payload is `msg.data`.
 * The `v` field and `type` discriminant live inside `data`.
 *
 * @module webview-messages
 */

import type {
    DownloadStatus,
    QueueEntry,
    LibraryEntry,
    ParsedError,
    SettingsSnapshot,
    DependencyStatus,
} from './plugin-state';

import type {
    MediaMetadata,
    FormatInfo,
    PlaylistEntry,
} from './yt-dlp';

// ── Envelope ────────────────────────────────────────────────────────

/** Base envelope — every message carries a protocol version. */
interface MessageEnvelope {
    /** Protocol version for future evolution. Always `1` for now. */
    v: 1;
}

// ── Outbound (plugin → webview) ─────────────────────────────────────

/** Full state snapshot sent on panel open or `request-state`. */
interface StateUpdateMessage extends MessageEnvelope {
    type: 'state-update';
    queue: QueueEntry[];
    library: LibraryEntry[];
    history: string[];
    settings: SettingsSnapshot;
    dependencyStatuses: DependencyStatus[];
}

/** Full queue snapshot, throttled 10 Hz. */
interface QueueUpdateMessage extends MessageEnvelope {
    type: 'queue-update';
    entries: QueueEntry[];
}

/** Full library snapshot, throttled 100 ms. */
interface LibraryUpdateMessage extends MessageEnvelope {
    type: 'library-update';
    entries: LibraryEntry[];
}

/** Fired when a setting changes mid-session. */
interface SettingsUpdateMessage extends MessageEnvelope {
    type: 'settings-update';
    settings: SettingsSnapshot;
}

/** Successful URL probe result. */
interface ProbeResultMessage extends MessageEnvelope {
    type: 'probe-result';
    /** Echoed from probe-url for correlation. */
    probeId: string;
    url: string;
    metadata: MediaMetadata;
    formats: FormatInfo[];
}

/** Failed URL probe. */
interface ProbeErrorMessage extends MessageEnvelope {
    type: 'probe-error';
    /** Echoed from probe-url for correlation. */
    probeId: string;
    url: string;
    error: ParsedError;
}

/** Playlist probe result. */
interface PlaylistDataMessage extends MessageEnvelope {
    type: 'playlist-data';
    /** Echoed from probe-url for correlation. */
    probeId: string;
    playlistUrl: string;
    playlistTitle: string;
    entries: PlaylistEntry[];
    groupTag: string;
    groupLabel: string;
    totalCount: number;
}

/** Per-entry download progress tick. */
interface DownloadProgressMessage extends MessageEnvelope {
    type: 'download-progress';
    id: string;
    percent: number;
    speed?: string;
    eta?: string;
    attempt: number;
    maxAttempts: number;
}

/** Per-entry status transition. */
interface DownloadStatusMessage extends MessageEnvelope {
    type: 'download-status';
    id: string;
    status: DownloadStatus;
    errorMessage?: string;
    finalFilePath?: string;
    finalFileUrl?: string;
}

/** Dependency status update (lifecycle event). */
interface DependencyStatusMessage extends MessageEnvelope {
    type: 'dependency-status';
    statuses: DependencyStatus[];
}

/** Degraded-state banner payload (replaces legacy "setup-wizard"). */
interface DependencyBannerMessage extends MessageEnvelope {
    type: 'dependency-banner';
    statuses: DependencyStatus[];
}

/** CLI preview response showing constructed yt-dlp command. */
interface CliPreviewMessage extends MessageEnvelope {
    type: 'cli-preview';
    /** Echoed from request-cli-preview to correlate response with sender. */
    previewId: string;
    args?: string[];
    error?: string;
}

/** Enqueue acknowledgement — confirms success or failure of a queue-download/queue-playlist request. */
interface EnqueueAckMessage extends MessageEnvelope {
    type: 'enqueue-ack';
    /** Echoed from the originating request to correlate ack with sender. */
    requestId: string;
    ok: boolean;
    /** Number of entries successfully enqueued (0 on failure). */
    count: number;
    /** Human-readable error reason when ok is false. */
    error?: string;
}

/** All messages the plugin can send to the webview. */
export type PanelOutboundMessage =
    | StateUpdateMessage
    | QueueUpdateMessage
    | LibraryUpdateMessage
    | SettingsUpdateMessage
    | ProbeResultMessage
    | ProbeErrorMessage
    | PlaylistDataMessage
    | DownloadProgressMessage
    | DownloadStatusMessage
    | DependencyStatusMessage
    | DependencyBannerMessage
    | CliPreviewMessage
    | EnqueueAckMessage;

// ── Inbound (webview → plugin) ──────────────────────────────────────

interface RequestStateMessage extends MessageEnvelope {
    type: 'request-state';
}

interface ProbeUrlMessage extends MessageEnvelope {
    type: 'probe-url';
    /** Caller-generated ID echoed in probe-result/probe-error/playlist-data for correlation. */
    probeId: string;
    url: string;
}

interface QueueDownloadMessage extends MessageEnvelope {
    type: 'queue-download';
    /** Caller-generated ID echoed in enqueue-ack for correlation. */
    requestId: string;
    url: string;
    format: string;
    quality: string;
    advancedArgs?: string[];
    proxyUrl?: string;
    filenameTemplate?: string;
}

interface QueuePlaylistMessage extends MessageEnvelope {
    type: 'queue-playlist';
    /** Caller-generated ID echoed in enqueue-ack for correlation. */
    requestId: string;
    playlistUrl: string;
    selectedEntries: { id: string; url: string; title: string }[];
    format: string;
    quality: string;
    groupTag: string;
    groupLabel: string;
    advancedArgs?: string[];
    proxyUrl?: string;
    filenameTemplate?: string;
}

interface CancelDownloadMessage extends MessageEnvelope {
    type: 'cancel-download';
    id: string;
}

interface RetryDownloadMessage extends MessageEnvelope {
    type: 'retry-download';
    id: string;
}

interface PauseQueueMessage extends MessageEnvelope {
    type: 'pause-queue';
}

interface ResumeQueueMessage extends MessageEnvelope {
    type: 'resume-queue';
}

interface ClearCompletedMessage extends MessageEnvelope {
    type: 'clear-completed';
}

interface ToggleViewMessage extends MessageEnvelope {
    type: 'toggle-view';
    view: 'form' | 'queue';
}

interface PlayFileMessage extends MessageEnvelope {
    type: 'play-file';
    id: string;
}

interface RevealFileMessage extends MessageEnvelope {
    type: 'reveal-file';
    id: string;
}

interface ToggleFavoriteMessage extends MessageEnvelope {
    type: 'toggle-favorite';
    id: string;
}

interface DeleteItemMessage extends MessageEnvelope {
    type: 'delete-item';
    id: string;
    deleteFromDisk?: boolean;
}

interface CopyUrlMessage extends MessageEnvelope {
    type: 'copy-url';
    id: string;
}

interface RedownloadMessage extends MessageEnvelope {
    type: 'redownload';
    id: string;
}

interface RecheckDependenciesMessage extends MessageEnvelope {
    type: 'recheck-dependencies';
}

interface RequestCliPreviewMessage extends MessageEnvelope {
    type: 'request-cli-preview';
    /** Caller-generated ID echoed in cli-preview for correlation. */
    previewId: string;
    url: string;
    format: string;
    quality: string;
    advancedArgs?: string[];
    proxyUrl?: string;
    filenameTemplate?: string;
}

/** All messages the webview can send to the plugin. */
export type PanelInboundMessage =
    | RequestStateMessage
    | ProbeUrlMessage
    | QueueDownloadMessage
    | QueuePlaylistMessage
    | CancelDownloadMessage
    | RetryDownloadMessage
    | PauseQueueMessage
    | ResumeQueueMessage
    | ClearCompletedMessage
    | ToggleViewMessage
    | PlayFileMessage
    | RevealFileMessage
    | ToggleFavoriteMessage
    | DeleteItemMessage
    | CopyUrlMessage
    | RedownloadMessage
    | RecheckDependenciesMessage
    | RequestCliPreviewMessage;

// ── Runtime validation ──────────────────────────────────────────────

/**
 * Validate an inbound message envelope and return the typed message,
 * or `null` if the envelope is malformed (log + drop).
 *
 * **Host envelope note**: The host wraps webview messages in
 * `{ data, instanceId, windowId, paneId }`. Callers must pass `msg.data`
 * (not the raw host envelope) to this function.
 *
 * Performs envelope-only validation — does not runtime-check the full
 * discriminated union payloads (TypeScript handles that at compile time).
 *
 * @param raw - The raw `msg.data` value from the host envelope.
 * @returns The parsed inbound message, or `null` if the envelope is malformed.
 */
export function parseInbound(raw: unknown): PanelInboundMessage | null {
    if (
        typeof raw === 'object' &&
        raw !== null &&
        (raw as any).v === 1 &&
        typeof (raw as any).type === 'string'
    ) {
        return raw as PanelInboundMessage;
    }

    // Malformed envelope — log redacted summary only (payloads may contain
    // sensitive fields like proxyUrl or advancedArgs)
    if (typeof raw === 'object' && raw !== null) {
        const keys = Object.keys(raw as Record<string, unknown>).join(', ');
        console.warn(`[yt-dlp] Dropped malformed inbound message: missing v:1 or type (keys: ${keys})`);
    } else {
        console.warn('[yt-dlp] Dropped non-object inbound message:', typeof raw);
    }

    return null;
}

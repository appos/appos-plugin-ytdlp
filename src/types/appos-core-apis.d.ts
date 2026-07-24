/**
 * Local typings shim for the core-plugin surfaces (Public Action Fabric,
 * Core Notifications) that the host injects on `PluginContext` but that
 * `@appos.space/plugin-types` does not yet declare (known d.ts drift —
 * the published SDK package predates these surfaces).
 *
 * Shapes are transcribed 1:1 from the host-authoritative plugin API
 * typings — see the public SDK docs at https://docs.appos.space.
 * DELETE this file and drop the augmentation once the SDK package
 * ships these namespaces — a duplicate-identifier typecheck error on
 * upgrade is the intended tripwire.
 *
 * Both namespaces are declared OPTIONAL on `PluginContext`: on an older
 * host the properties are absent and all call sites guard with
 * `ctx.actions?` / `ctx.notifications?`.
 */

import type {} from '@appos.space/plugin-types';

declare module '@appos.space/plugin-types' {
    // ── Public Action Fabric ────────────────────────────────────────

    /** Risk classification for an action. Drives default approval policy. */
    type ActionRisk = 'read' | 'write' | 'external' | 'destructive';

    /** Approval policy for an action invocation. */
    type ActionApproval = 'auto' | 'user' | 'dangerous';

    /** Where an action surfaces. */
    type ActionVisibility = 'palette' | 'api' | 'agent' | 'automation';

    /** Origin of an action invocation. Defaults to `plugin`. */
    type InvocationSource = 'user' | 'plugin' | 'agent' | 'recipe' | 'sequence' | 'system';

    /** Final state of an action invocation. */
    type ActionOutcome =
        | { kind: 'succeeded' }
        | { kind: 'failed'; error: string }
        | { kind: 'cancelled' }
        | { kind: 'rejected' }
        | { kind: 'timedOut' };

    /** Lightweight artifact produced by an action handler. */
    interface ActionArtifact {
        kind: 'file' | 'url' | 'entity' | 'text' | 'json';
        value: string;
        title?: string;
    }

    /** Public action definition input to `actions.register(...)`. */
    interface ActionDefinitionSpec {
        id: string;
        displayName?: string;
        title?: string;
        description?: string;
        summary?: string;
        pluginId?: string;
        /** JSON Schema object for the action input. Use `{}` for no-input actions. */
        inputSchema: Record<string, unknown>;
        outputSchema?: Record<string, unknown>;
        visibility: ActionVisibility | ActionVisibility[];
        risk: ActionRisk;
        /** Defaults to `auto` when omitted. */
        approval?: ActionApproval;
        icon?: string;
        shortcut?: string;
        permissionScope?: string;
        tags?: string[];
    }

    /** Execution context passed to an action handler. */
    interface ActionExecutionContext {
        invocationId: string;
        source: InvocationSource;
        sourceId?: string;
        /** The validated input matching the action's `inputSchema`. Already JSON-decoded. */
        input: unknown;
    }

    /** Explicit envelope return shape (requires `_actionResult: true` sentinel). */
    interface ActionResult {
        _actionResult: true;
        output?: unknown;
        artifacts?: ActionArtifact[];
        undoToken?: string;
    }

    /** Receipt produced by `context.actions.invoke(...)`. */
    interface ActionReceipt {
        receiptId: string;
        actionId: string;
        source: InvocationSource;
        result: ActionOutcome;
        artifacts?: ActionArtifact[];
        startedAt: string;
        completedAt: string;
    }

    /** `context.actions` — Public Action Fabric. */
    interface ActionsNamespace {
        /** Requires `actions.register`. Resolves with an opaque handle token. */
        register(
            def: ActionDefinitionSpec,
            handler: (
                ctx: ActionExecutionContext,
            ) => ActionResult | Promise<ActionResult> | unknown | Promise<unknown>,
        ): Promise<string>;

        /**
         * Wraps an existing `commands.register(...)` command as a public
         * action without re-implementing the handler. `metadata.risk` is
         * REQUIRED; `visibility` defaults to `["palette"]`; `displayName`
         * falls back to the live command title. Requires `actions.register`.
         */
        registerFromCommand(
            commandId: string,
            metadata: Partial<ActionDefinitionSpec> & { risk: ActionRisk },
        ): Promise<string>;

        invoke(id: string): Promise<ActionReceipt>;
        invoke(id: string, input: unknown, source?: InvocationSource): Promise<ActionReceipt>;

        /** Requires `actions.list`. */
        all(): Promise<unknown[]>;

        /** Revokes a previously-returned handle token. Idempotent. */
        unregister(handleToken: string): Promise<void>;
    }

    // ── Core Notifications (outbound) ───────────────────────────────

    /** Notification severity. */
    type NotificationLevel = 'debug' | 'info' | 'warning' | 'critical';

    /**
     * Caller-supplied input to `notifications.emit(...)`. The host stamps
     * `id` / `emittedAt` / `emittedBy` — supplying them is rejected.
     */
    interface NotificationInput {
        level: NotificationLevel;
        /** ≤ 256 chars. */
        title: string;
        /** ≤ 4096 chars. */
        body: string;
        /** ≤ 128 chars. Plugin-defined grouping label. */
        category?: string;
        actionCategoryId?: string;
        /** ≤ 16 keys, ≤ 4 KB serialized; one-level only. */
        metadata?: { [key: string]: unknown };
        /** ≤ 128 chars. Opaque pass-through. */
        correlationId?: string;
        /** ISO-8601 string. */
        expiresAt?: string;
        /** ≤ 128 chars. Native-center grouping; defaults to emitter id. */
        threadIdentifier?: string;
    }

    /** Returned by `notifications.emit(...)` — `id` IS the notification id. */
    interface NotificationHandle {
        id: string;
    }

    /**
     * `context.notifications` — outbound notification surface.
     * Subset used by this plugin (emit/cancel); channel/filter contributor
     * sub-bridges intentionally omitted.
     */
    interface NotificationsNamespace {
        /**
         * Emit a notification. Routes through the action invoke pipeline.
         * Requires `notifications.emit` + `actions.invoke` scopes and a
         * manifest dependency on `space.appos.core.notifications`.
         */
        emit(input: NotificationInput): Promise<NotificationHandle>;

        /** Cancel a pending notification. Uniform `false` on missing/foreign/terminal. */
        cancel(handleId: string): Promise<boolean>;
    }

    // ── PluginContext augmentation ──────────────────────────────────

    interface PluginContext {
        /**
         * Public Action Fabric. Absent on older hosts — always
         * guard with `ctx.actions?.`.
         */
        readonly actions?: ActionsNamespace;

        /**
         * Outbound notifications. Absent on older hosts — always
         * guard with `ctx.notifications?.`.
         */
        readonly notifications?: NotificationsNamespace;
    }
}

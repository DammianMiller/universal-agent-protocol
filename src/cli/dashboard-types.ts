/**
 * The shared dashboard command types — a LEAF module so every dashboard view
 * module (dashboard.ts's views, the session family in dashboard-session.ts,
 * and any future split) imports the option shape without a back-edge into
 * the dispatcher module. Keep this file types-only: a value import from a
 * view back into the dispatcher is the cycle the split exists to prevent.
 */

/** Options every `uap dashboard <action>` view accepts. */
export interface DashboardOptions {
  verbose?: boolean;
  compact?: boolean;
  taskId?: string;
  port?: number;
  host?: string;
  /** Snapshot push/poll interval in seconds (`--refresh`). */
  refresh?: string;
}

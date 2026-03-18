import type { Plugin } from '@opencode-ai/plugin';
import { tool } from '@opencode-ai/plugin';

export const UAPDashboardPlugin: Plugin = async ({ $ }) => {
  return {
    tool: {
      uap_dashboard: tool({
        description:
          'Show UAP session dashboard with live status of agents, tasks, skills, patterns, and costs',
        args: {
          action: tool.schema
            .enum(['show', 'start', 'stop', 'snapshot', 'summary'])
            .default('show')
            .describe(
              'Dashboard action: show (basic view), start (persistent updates every 2s), stop, snapshot (detailed), summary (full session)'
            ),
          withWorkGraph: tool.schema
            .boolean()
            .optional()
            .describe('Include work graph visualization (for show/snapshot actions)'),
        },
        async execute({ action, withWorkGraph = false }) {
          try {
            const telemetry = await import('../../src/telemetry/session-telemetry.js');

            if (action === 'start') {
              telemetry.startDashboard(2000, withWorkGraph);
              return '✅ Dashboard started. Updates every 2 seconds. Use /uap_dashboard --action stop to stop.';
            }

            if (action === 'stop') {
              telemetry.stopDashboard();
              return '✅ Dashboard stopped.';
            }

            if (action === 'snapshot') {
              telemetry.showDashboardSnapshot(withWorkGraph);
              return '✅ Dashboard snapshot displayed.';
            }

            if (action === 'summary') {
              telemetry.sessionSummary();
              return '✅ Full session summary displayed.';
            }

            // Default: show basic dashboard
            telemetry.showDashboardSnapshot(withWorkGraph);
            return '✅ UAP Dashboard shown. Use --action start for persistent updates, --action summary for full details.';
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return `❌ Dashboard error: ${errorMsg}`;
          }
        },
      }),
    },
  };
};

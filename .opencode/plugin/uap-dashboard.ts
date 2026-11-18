import type { Plugin } from '@opencode/plugin';
import { toolInput, toolResult } from '../lib/uap-plugin-kit';

const plugin: Plugin.Plugin = {
  id: 'uap-dashboard',
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: 'uap_dashboard',
        description:
          'Show UAP session dashboard with live status of agents, tasks, skills, patterns, and costs',
        input: toolInput.object(
          {
            action: toolInput.enum(
              'Dashboard action: show (basic view), start (persistent updates every 2s), stop, snapshot (detailed), summary (full session)',
              ['show', 'start', 'stop', 'snapshot', 'summary'],
              'show'
            ),
            withWorkGraph: toolInput.boolean(
              'Include work graph visualization (for show/snapshot actions)'
            ),
          },
          []
        ),
        async execute(input) {
          const { action, withWorkGraph } = input as {
            action?: string;
            withWorkGraph?: boolean;
          };
          const graph = withWorkGraph ?? false;
          try {
            const telemetry = await import('../../src/telemetry/session-telemetry.js');

            if (action === 'start') {
              telemetry.startDashboard(2000, graph);
              return toolResult(
                '✅ Dashboard started. Updates every 2 seconds. Use /uap_dashboard --action stop to stop.'
              );
            }

            if (action === 'stop') {
              telemetry.stopDashboard();
              return toolResult('✅ Dashboard stopped.');
            }

            if (action === 'snapshot') {
              telemetry.showDashboardSnapshot(graph);
              return toolResult('✅ Dashboard snapshot displayed.');
            }

            if (action === 'summary') {
              telemetry.sessionSummary();
              return toolResult('✅ Full session summary displayed.');
            }

            // Default: show basic dashboard
            telemetry.showDashboardSnapshot(graph);
            return toolResult(
              '✅ UAP Dashboard shown. Use --action start for persistent updates, --action summary for full details.'
            );
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            return toolResult(`❌ Dashboard error: ${errorMsg}`);
          }
        },
      });
    });
  },
};

export default plugin;

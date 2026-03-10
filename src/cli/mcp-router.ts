/**
 * MCP Router CLI Commands
 * Lightweight hierarchical router for 98%+ token reduction
 */

import chalk from 'chalk';
import { McpRouter } from '../mcp-router/index.js';

type RouterAction = 'start' | 'stats' | 'discover' | 'list';

interface RouterOptions {
  config?: string;
  query?: string;
  server?: string;
  limit?: string;
  verbose?: boolean;
  json?: boolean;
}

export async function mcpRouterCommand(action: RouterAction, options: RouterOptions = {}): Promise<void> {
  switch (action) {
    case 'start':
      await startServer(options);
      break;
    case 'stats':
      await showStats(options);
      break;
    case 'discover':
      await discoverTools(options);
      break;
    case 'list':
      await listServers(options);
      break;
    default:
      console.error(chalk.red(`Unknown action: ${action}`));
      process.exit(1);
  }
}

async function startServer(options: RouterOptions): Promise<void> {
  const { runStdioServer } = await import('../mcp-router/server.js');
  
  console.error(chalk.cyan('Starting MCP Router server (stdio)...'));
  console.error(chalk.gray('This server exposes 2 meta-tools: discover_tools, execute_tool'));
  console.error(chalk.gray('Add to your MCP config:'));
  console.error(chalk.yellow(`
{
  "mcpServers": {
    "router": {
      "command": "npx",
      "args": ["uap", "mcp-router", "start"]
    }
  }
}
`));
  
  await runStdioServer({
    configPath: options.config,
    verbose: options.verbose,
  });
}

async function showStats(options: RouterOptions): Promise<void> {
  const router = new McpRouter({
    configPath: options.config,
    verbose: options.verbose,
  });
  
  console.error(chalk.cyan('Loading tools from configured servers...'));
  await router.loadTools();
  
  const stats = router.getStats();
  
  if (options.json) {
    console.log(JSON.stringify(stats, null, 2));
    return;
  }
  
  console.log('');
  console.log(chalk.bold('MCP Router Statistics'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`${chalk.cyan('Servers:')}        ${stats.totalServers}`);
  console.log(`${chalk.cyan('Tools:')}          ${stats.totalTools}`);
  console.log('');
  console.log(chalk.bold('Token Usage Comparison'));
  console.log(chalk.gray('─'.repeat(50)));
  console.log(`${chalk.red('Traditional:')}    ${stats.traditionalTokens.toLocaleString()} tokens`);
  console.log(`${chalk.green('With Router:')}    ${stats.routerTokens.toLocaleString()} tokens`);
  console.log(`${chalk.bold.green('Savings:')}         ${stats.savings}`);
  console.log('');
  
  if (stats.totalTools === 0) {
    console.log(chalk.yellow('No tools found. Make sure MCP servers are configured.'));
    console.log(chalk.gray('Check ~/.claude/settings.json, Cursor config, or local mcp.json'));
  }
  
  await router.shutdown();
}

async function discoverTools(options: RouterOptions): Promise<void> {
  if (!options.query) {
    console.error(chalk.red('Query required. Use --query "search term"'));
    process.exit(1);
  }
  
  const router = new McpRouter({
    configPath: options.config,
    verbose: options.verbose,
  });
  
  console.error(chalk.cyan('Loading tools...'));
  await router.loadTools();
  
  const result = await router.handleToolCall('discover_tools', {
    query: options.query,
    server: options.server,
    limit: options.limit ? parseInt(options.limit, 10) : 10,
  }) as { tools: Array<{ path: string; name: string; description: string; server: string; score: number }>; hint: string };
  
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('');
    console.log(chalk.bold(`Tools matching "${options.query}":`));
    console.log(chalk.gray('─'.repeat(60)));
    
    if (result.tools.length === 0) {
      console.log(chalk.yellow('No tools found matching query.'));
    } else {
      for (const tool of result.tools) {
        const score = Math.round(tool.score * 100);
        console.log(`${chalk.green(tool.path)} ${chalk.gray(`(${score}%)`)}`);
        console.log(`  ${chalk.gray(tool.description.slice(0, 80))}${tool.description.length > 80 ? '...' : ''}`);
      }
    }
    
    console.log('');
    console.log(chalk.gray(result.hint));
  }
  
  await router.shutdown();
}

async function listServers(options: RouterOptions): Promise<void> {
  const router = new McpRouter({
    configPath: options.config,
    verbose: false,
  });
  
  const config = router.getConfig();
  const servers = Object.entries(config.mcpServers);
  
  if (options.json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }
  
  console.log('');
  console.log(chalk.bold('Configured MCP Servers'));
  console.log(chalk.gray('─'.repeat(50)));
  
  if (servers.length === 0) {
    console.log(chalk.yellow('No MCP servers configured.'));
    console.log(chalk.gray('Add servers to ~/.claude/settings.json, Cursor config, or local mcp.json'));
  } else {
    for (const [name, config] of servers) {
      const transport = config.url ? 'HTTP' : 'stdio';
      const target = config.url || `${config.command} ${(config.args || []).join(' ')}`;
      console.log(`${chalk.green(name)} ${chalk.gray(`[${transport}]`)}`);
      console.log(`  ${chalk.gray(target.slice(0, 70))}${target.length > 70 ? '...' : ''}`);
    }
  }
  
  console.log('');
  console.log(chalk.gray(`Found ${servers.length} server(s)`));
}

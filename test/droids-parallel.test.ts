import { describe, it } from 'vitest';
import { execaCommand } from 'execa';
import chalk from 'chalk';

describe('Parallel Subagents/Droids', () => {
  const droidName = `test-droid-${Date.now()}`;

  it('creates a test droid and demonstrates parallel execution', async () => {
    console.log('\n' + '='.repeat(60));
    console.log(chalk.bold.cyan('🤖 Testing Parallel Droids'));
    console.log('='.repeat(60) + '\n');

    // Step 1: Create test droid using CLI
    console.log('[Step 1] Creating test droid...');
    const createResult = await execaCommand(
      `node dist/bin/cli.js droids add ${droidName} code-reviewer`
    );
    console.log(createResult.stdout);

    // Step 2: List available droids to confirm creation
    console.log('\n[Step 2] Listing all available droids...');
    const listResult = await execaCommand(`node dist/bin/cli.js droids list`);
    console.log(listResult.stdout);

    // Step 3: Demonstrate parallel execution by spawning multiple independent tasks concurrently
    console.log('[Step 3] Demonstrating parallel subagent execution...\n');

    const start1 = Date.now();
    const task1 = execaCommand(
      `node dist/bin/cli.js droids add test-droid-parallel-${Date.now()}-alpha`
    );

    const start2 = Date.now();
    const task2 = execaCommand(
      `node dist/bin/cli.js droids add test-droid-parallel-${Date.now()}-beta`
    );

    const start3 = Date.now();
    const task3 = execaCommand(
      `node dist/bin/cli.js droids add test-droid-parallel-${Date.now()}-gamma`
    );

    // Wait for all tasks to complete in parallel
    await Promise.all([task1, task2, task3]);

    console.log('\n[Step 4] All three droids created concurrently:');
    const finalList = await execaCommand(`node dist/bin/cli.js droids list`);
    console.log(finalList.stdout);

    // Cleanup - remove test droids
    console.log('[Cleanup] Removing temporary droids...');

    try {
      const fs = (await import('fs')).default;
      const path = await import('path');

      for (const suffix of ['', '-alpha', '-beta', '-gamma']) {
        const testDroidName = `test-droid-parallel-${Date.now()}${suffix}`;
        const droidPath = path.join(process.cwd(), '.factory/droids', `${testDroidName}.md`);

        if (fs.existsSync(droidPath)) {
          fs.unlinkSync(droidPath);
          console.log(`  Removed: ${testDroidName}`);
        }
      }
    } catch (e) {
      // Ignore cleanup errors for now
    }

    console.log('\n' + '='.repeat(60));
    console.log(chalk.bold.green('✅ Parallel droids test completed!'));
    console.log('='.repeat(60) + '\n');
  });
});

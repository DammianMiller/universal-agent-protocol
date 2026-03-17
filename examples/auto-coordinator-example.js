#!/usr/bin/env node
/**
 * Auto-Coordinator Example
 *
 * Demonstrates automatic agent registration and multi-agent coordination.
 *
 * Usage:
 *   node examples/auto-coordinator-example.js
 */

import { createAutoAgent } from '../src/coordination/auto-agent.js';
import { TaskService } from '../src/tasks/service.js';
import { TaskCoordinator } from '../src/tasks/coordination.js';

async function main() {
  console.log('=== Multi-Agent Coordination Example ===\n');

  // Example 1: Create an auto-agent
  console.log('1. Creating auto-agent with automatic registration...');
  const autoAgent = createAutoAgent({
    name: 'dev-agent-1',
    capabilities: ['coding', 'testing', 'review'],
    worktreeBranch: 'feature/new-dashboard',
    heartbeatIntervalMs: 30000,
  });

  const result = await autoAgent.start();
  console.log(`   ✓ Agent registered: ${result.agent.id}`);
  console.log(`   ✓ Agent name: ${result.agent.name}`);
  console.log(`   ✓ Status: ${result.agent.status}`);
  console.log(`   ✓ Worktree: ${result.agent.worktreeBranch}\n`);

  // Example 2: Announce work on a resource
  console.log('2. Announcing work on resource...');
  const announcementResult = autoAgent.announceWork('src/components/Dashboard.tsx', 'editing', {
    description: 'Implementing new dashboard component',
    filesAffected: ['src/components/Dashboard.tsx', 'src/types/dashboard.ts'],
    estimatedMinutes: 120,
  });
  console.log(`   ✓ Announced: ${announcementResult.announcement.resource}`);
  console.log(`   ✓ Intent: ${announcementResult.announcement.intentType}`);
  console.log(`   ✓ Overlaps detected: ${announcementResult.overlaps.length}\n`);

  // Example 3: Check for overlaps
  console.log('3. Checking for overlaps...');
  const overlaps = autoAgent.checkOverlaps('src/components/Dashboard.tsx');
  if (overlaps.length > 0) {
    console.log(`   ⚠️  Found ${overlaps.length} overlap(s):`);
    for (const overlap of overlaps) {
      console.log(`      - ${overlap.conflictRisk}: ${overlap.agents.length} agents`);
    }
  } else {
    console.log('   ✓ No overlaps detected\n');
  }

  // Example 4: Integrate with task coordination
  console.log('4. Integrating with task coordination...');
  const taskService = new TaskService();
  const taskCoordinator = new TaskCoordinator({
    taskService,
    coordinationService: autoAgent.getService(),
    agentId: autoAgent.getAgentId(),
    agentName: autoAgent.getAgentId().slice(0, 8),
    worktreeBranch: 'feature/new-dashboard',
  });

  // Suggest next task
  const suggestedTask = taskCoordinator.suggestNextTask();
  if (suggestedTask) {
    console.log(
      `   ✓ Suggested task: ${suggestedTask.title} (Priority: ${suggestedTask.priority})`
    );
  } else {
    console.log('   ✓ No ready tasks found\n');
  }

  // Example 5: Claim a task with coordination
  console.log('5. Claiming task with coordination...');
  try {
    // First, create a test task
    const testTask = taskService.create({
      title: 'Test Task for Coordination',
      type: 'task',
      priority: 1,
      labels: ['coordination', 'test'],
    });

    // Claim it
    const claimResult = await taskCoordinator.claim(testTask.id);
    if (claimResult) {
      console.log(`   ✓ Task claimed: ${claimResult.task.title}`);
      console.log(`   ✓ Worktree: ${claimResult.worktreeBranch}`);
      console.log(`   ✓ Announced work to coordination system`);
    }
  } catch (error) {
    console.log(`   ⚠️  Could not claim task: ${error.message}`);
  }

  // Example 6: Simulate another agent
  console.log('\n6. Simulating second agent...');
  const autoAgent2 = createAutoAgent({
    name: 'dev-agent-2',
    capabilities: ['testing', 'review'],
    worktreeBranch: 'fix/login-bug',
  });

  const result2 = await autoAgent2.start();
  console.log(`   ✓ Agent 2 registered: ${result2.agent.id}`);

  // Announce work on same resource
  const announcement2 = autoAgent2.announceWork('src/components/Dashboard.tsx', 'reviewing', {
    description: 'Reviewing dashboard component',
    estimatedMinutes: 30,
  });
  console.log(`   ✓ Agent 2 announced work on same resource`);
  console.log(`   ✓ Overlaps detected: ${announcement2.overlaps.length}`);

  // Example 7: Cleanup
  console.log('\n7. Cleaning up agents...');
  result.cleanup();
  result2.cleanup();
  console.log('   ✓ Agents marked as completed');

  console.log('\n=== Example Complete ===');
}

main().catch(console.error);

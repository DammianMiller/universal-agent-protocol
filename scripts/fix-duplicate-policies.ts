#!/usr/bin/env node
/**
 * Fix duplicate policies in the policies database
 *
 * This script identifies and removes duplicate policy entries
 * that have the same name, level, stage, and category.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';

interface PolicyRow {
  id: string;
  name: string;
  level: string;
  enforcementStage: string;
  category: string;
}

const cwd = process.cwd();
const dbPath = join(cwd, 'agents', 'data', 'memory', 'policies.db');

if (!existsSync(dbPath)) {
  console.error('Policies database not found at:', dbPath);
  process.exit(1);
}

const db = new Database(dbPath);

try {
  // Get all policies
  const allPolicies = db
    .prepare('SELECT id, name, level, enforcementStage, category FROM policies')
    .all() as PolicyRow[];

  if (allPolicies.length === 0) {
    console.log('No policies found in database.');
    db.close();
    process.exit(0);
  }

  // Group by unique policy signature (name + level + stage + category)
  const policyMap = new Map<string, PolicyRow>();
  const duplicates: Array<{ kept: string; removed: string[]; name: string }> = [];

  for (const policy of allPolicies) {
    const key = `${policy.name}|${policy.level}|${policy.enforcementStage}|${policy.category}`;

    if (policyMap.has(key)) {
      // This is a duplicate
      const existing = policyMap.get(key)!;
      if (!duplicates.find((d) => d.name === policy.name)) {
        duplicates.push({
          kept: existing.id,
          removed: [policy.id],
          name: policy.name,
        });
      } else {
        const dup = duplicates.find((d) => d.name === policy.name);
        if (dup) dup.removed.push(policy.id);
      }
    } else {
      policyMap.set(key, policy);
    }
  }

  if (duplicates.length === 0) {
    console.log('No duplicate policies found.');
    db.close();
    process.exit(0);
  }

  console.log(`Found ${duplicates.length} set(s) of duplicate policies:\n`);

  for (const dup of duplicates) {
    console.log(`Policy: ${dup.name}`);
    console.log(`  Keeping: ${dup.kept}`);
    console.log(`  Removing: ${dup.removed.length} duplicates`);
    console.log('');
  }

  // Remove duplicates (keep the one with the lowest id for consistency)
  const toDelete: string[] = [];
  for (const dup of duplicates) {
    // Keep the policy with the lowest id (oldest insertion)
    const ids = [dup.kept, ...dup.removed].sort();
    const keepId = ids[0];

    console.log(`Keeping: ${keepId}`);
    for (const id of ids.slice(1)) {
      toDelete.push(id);
      console.log(`  Deleting: ${id}`);
    }
    console.log('');
  }

  // Execute deletions
  if (toDelete.length > 0) {
    const stmt = db.prepare('DELETE FROM policies WHERE id = ?');
    for (const id of toDelete) {
      stmt.run(id);
    }
    console.log(`\nRemoved ${toDelete.length} duplicate policy entries.`);
  }

  // Verify cleanup
  const remaining = db.prepare('SELECT COUNT(*) as c FROM policies').get() as { c: number };
  console.log(`Total policies remaining: ${remaining.c}`);

  db.close();
  console.log('\nDone!');
} catch (error) {
  console.error('Error:', error instanceof Error ? error.message : String(error));
  db.close();
  process.exit(1);
}

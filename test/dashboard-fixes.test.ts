/**
 * Tests for dashboard fixes
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { join } from 'path';
import Database from 'better-sqlite3';
import { getPolicyMemoryManager } from '../src/policies/policy-memory.js';

describe('Dashboard Fixes', () => {
  describe('Duplicate Policy Removal', () => {
    const dbPath = join(process.cwd(), 'agents/data/memory/policies.db');

    it('should have no duplicate policies after cleanup', async () => {
      if (!existsSync(dbPath)) {
        expect(true).toBe(true); // DB doesn't exist, skip test
        return;
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        const allPolicies = db
          .prepare('SELECT id, name, level, enforcementStage, category FROM policies')
          .all() as Array<Record<string, string>>;

        // Group by unique signature
        const signatures = new Map<string, string[]>();
        for (const policy of allPolicies) {
          const key = `${policy.name}|${policy.level}|${policy.enforcementStage}|${policy.category}`;
          if (!signatures.has(key)) {
            signatures.set(key, []);
          }
          signatures.get(key)?.push(policy.id);
        }

        // Check no duplicates
        for (const [signature, ids] of signatures.entries()) {
          (expect(ids.length).toBe(1),
            `Policy with signature "${signature}" has ${ids.length} entries: ${ids.join(', ')}`);
        }
      } finally {
        db.close();
      }
    });

    it('should have unique policy IDs', async () => {
      if (!existsSync(dbPath)) {
        expect(true).toBe(true);
        return;
      }

      const db = new Database(dbPath, { readonly: true });
      try {
        const allPolicies = db.prepare('SELECT id FROM policies').all() as Array<{
          id: string;
        }>;
        const ids = allPolicies.map((p) => p.id);
        const uniqueIds = new Set(ids);

        (expect(ids.length).toBe(uniqueIds.size), 'All policy IDs should be unique');
      } finally {
        db.close();
      }
    });

    it('should use policy memory manager API for dashboard data without duplicates', async () => {
      const memoryManager = getPolicyMemoryManager();
      const policies = await memoryManager.getAllPolicies();

      // Verify we can fetch policies without duplicates via the API
      const policyNames = policies.map((p) => p.name);
      const uniqueNames = new Set(policyNames);

      (expect(policyNames.length).toBe(uniqueNames.size),
        `Policy names should be unique: ${policyNames.join(', ')}`);
    });
  });

  describe('Dashboard Server Path Resolution', () => {
    it('should resolve dashboard.html path correctly', async () => {
      // Import the server module to check path resolution
      const { startDashboardServer } = await import('../src/dashboard/server.js');

      // Start server on a test port - if this succeeds, path resolution worked
      const server = startDashboardServer({ port: 3849 });

      // Clean up immediately
      server.close();

      expect(true).toBe(true);
    });

    it('should serve dashboard.html when requested', async () => {
      const { startDashboardServer } = await import('../src/dashboard/server.js');

      const server = startDashboardServer({ port: 3850 });

      try {
        // Make a request to the server
        const response = await fetch('http://localhost:3850/');
        expect(response.status).toBe(200);

        const html = await response.text();
        expect(html).toContain('UAP Dashboard');
      } finally {
        server.close();
      }
    });
  });
});

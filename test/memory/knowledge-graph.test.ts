import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { KnowledgeGraph } from '../../src/memory/knowledge-graph.js';
import { join } from 'path';
import { mkdirSync, existsSync, unlinkSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('KnowledgeGraph', () => {
  let graph: KnowledgeGraph;
  const tmpDir = join(tmpdir(), 'uap-test-kg-' + Date.now());
  const dbPath = join(tmpDir, 'test-knowledge.db');

  beforeEach(() => {
    if (!existsSync(tmpDir)) {
      mkdirSync(tmpDir, { recursive: true });
    }
    graph = new KnowledgeGraph(dbPath);
  });

  afterEach(() => {
    graph.close();
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  });

  describe('Entity Operations', () => {
    it('should create a new entity', () => {
      const entity = graph.upsertEntity('module', 'auth-service', 'Authentication service');
      expect(entity.id).toBeGreaterThan(0);
      expect(entity.type).toBe('module');
      expect(entity.name).toBe('auth-service');
      expect(entity.mentionCount).toBe(1);
    });

    it('should increment mention count on upsert', () => {
      graph.upsertEntity('module', 'auth-service');
      const updated = graph.upsertEntity('module', 'auth-service');
      expect(updated.mentionCount).toBe(2);
    });

    it('should update description on upsert', () => {
      graph.upsertEntity('module', 'auth-service', 'Old description');
      const updated = graph.upsertEntity('module', 'auth-service', 'New description');
      expect(updated.description).toBe('New description');
    });

    it('should get entity by type and name', () => {
      graph.upsertEntity('file', 'index.ts', 'Main entry');
      const found = graph.getEntity('file', 'index.ts');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('index.ts');
    });

    it('should return null for non-existent entity', () => {
      expect(graph.getEntity('file', 'nonexistent')).toBeNull();
    });

    it('should get entity by ID', () => {
      const created = graph.upsertEntity('module', 'test');
      const found = graph.getEntityById(created.id!);
      expect(found).not.toBeNull();
      expect(found!.name).toBe('test');
    });

    it('should return null for non-existent ID', () => {
      expect(graph.getEntityById(99999)).toBeNull();
    });

    it('should get entities by type', () => {
      graph.upsertEntity('module', 'a');
      graph.upsertEntity('module', 'b');
      graph.upsertEntity('file', 'c');
      const modules = graph.getEntitiesByType('module');
      expect(modules.length).toBe(2);
    });

    it('should search entities by name', () => {
      graph.upsertEntity('module', 'auth-service');
      graph.upsertEntity('module', 'user-service');
      graph.upsertEntity('module', 'deploy-batcher');
      const results = graph.searchEntities('service');
      expect(results.length).toBe(2);
    });

    it('should delete entity and its relationships', () => {
      const e1 = graph.upsertEntity('module', 'a');
      const e2 = graph.upsertEntity('module', 'b');
      graph.addRelationship(e1.id!, e2.id!, 'depends_on');
      const deleted = graph.deleteEntity(e1.id!);
      expect(deleted).toBe(true);
      expect(graph.getEntityById(e1.id!)).toBeNull();
      expect(graph.getRelationships(e2.id!)).toHaveLength(0);
    });
  });

  describe('Relationship Operations', () => {
    it('should create a relationship', () => {
      const e1 = graph.upsertEntity('module', 'a');
      const e2 = graph.upsertEntity('module', 'b');
      const rel = graph.addRelationship(e1.id!, e2.id!, 'depends_on');
      expect(rel.id).toBeGreaterThan(0);
      expect(rel.relation).toBe('depends_on');
      expect(rel.strength).toBe(1.0);
    });

    it('should strengthen existing relationships', () => {
      const e1 = graph.upsertEntity('module', 'a');
      const e2 = graph.upsertEntity('module', 'b');
      graph.addRelationship(e1.id!, e2.id!, 'depends_on', 1.0);
      const updated = graph.addRelationship(e1.id!, e2.id!, 'depends_on', 2.0);
      expect(updated.strength).toBe(3.0);
    });

    it('should cap strength at 10', () => {
      const e1 = graph.upsertEntity('module', 'a');
      const e2 = graph.upsertEntity('module', 'b');
      graph.addRelationship(e1.id!, e2.id!, 'depends_on', 8.0);
      const updated = graph.addRelationship(e1.id!, e2.id!, 'depends_on', 5.0);
      expect(updated.strength).toBe(10.0);
    });

    it('should get relationships for entity', () => {
      const e1 = graph.upsertEntity('module', 'a');
      const e2 = graph.upsertEntity('module', 'b');
      const e3 = graph.upsertEntity('module', 'c');
      graph.addRelationship(e1.id!, e2.id!, 'depends_on');
      graph.addRelationship(e3.id!, e1.id!, 'uses');
      const rels = graph.getRelationships(e1.id!);
      expect(rels.length).toBe(2);
    });

    it('should delete a relationship', () => {
      const e1 = graph.upsertEntity('module', 'a');
      const e2 = graph.upsertEntity('module', 'b');
      const rel = graph.addRelationship(e1.id!, e2.id!, 'depends_on');
      expect(graph.deleteRelationship(rel.id!)).toBe(true);
      expect(graph.getRelationships(e1.id!)).toHaveLength(0);
    });
  });

  describe('Graph Queries', () => {
    it('should query entity graph with relationships', () => {
      const e1 = graph.upsertEntity('module', 'auth');
      const e2 = graph.upsertEntity('module', 'users');
      graph.addRelationship(e1.id!, e2.id!, 'depends_on');
      const result = graph.queryEntityGraph('module', 'auth');
      expect(result).not.toBeNull();
      expect(result!.entity.name).toBe('auth');
      expect(result!.relationships.length).toBe(1);
      expect(result!.relationships[0].direction).toBe('outgoing');
    });

    it('should return null for non-existent entity in graph query', () => {
      expect(graph.queryEntityGraph('module', 'nonexistent')).toBeNull();
    });

    it('should traverse graph to find connected entities', () => {
      const e1 = graph.upsertEntity('module', 'a');
      const e2 = graph.upsertEntity('module', 'b');
      const e3 = graph.upsertEntity('module', 'c');
      graph.addRelationship(e1.id!, e2.id!, 'uses');
      graph.addRelationship(e2.id!, e3.id!, 'uses');
      const reachable = graph.traverseGraph(e1.id!, 2);
      expect(reachable.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('getStats', () => {
    it('should return correct counts', () => {
      graph.upsertEntity('module', 'a');
      graph.upsertEntity('file', 'b');
      const e1 = graph.upsertEntity('module', 'c');
      const e2 = graph.upsertEntity('module', 'a');
      graph.addRelationship(e1.id!, e2.id!, 'uses');
      const stats = graph.getStats();
      expect(stats.entityCount).toBe(3);
      expect(stats.relationshipCount).toBe(1);
      expect(stats.entityTypes).toContain('module');
      expect(stats.entityTypes).toContain('file');
    });

    it('should return zeros for empty graph', () => {
      const stats = graph.getStats();
      expect(stats.entityCount).toBe(0);
      expect(stats.relationshipCount).toBe(0);
    });
  });
});

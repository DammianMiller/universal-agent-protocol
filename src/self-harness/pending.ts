/**
 * Self-Harness — gated promotion queue (P3).
 *
 * Proposals mined from PRODUCTION traces are never auto-applied: they are
 * enqueued here as `PendingProposal`s awaiting validation + a human gate. The
 * promotion policy decides what may auto-promote after validation (low-risk env
 * knobs) vs what always needs human review (scaffold/middleware). docs/design/
 * SELF_HARNESS.md §9, §10.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import { Mod } from './mods.js';
import { FailureKind } from './weakness.js';

export type PromotionGate = 'auto-after-validation' | 'human';

/**
 * Promotion policy: env-knob Mods are low-risk and may auto-promote after they
 * pass validation; scaffold + middleware Mods change behavior more broadly and
 * always require a human gate. This is the safety boundary for online learning.
 */
export function promotionGate(mod: Mod): PromotionGate {
  return mod.kind === 'env' ? 'auto-after-validation' : 'human';
}

export interface PendingProposal {
  id: string;
  signature: string;
  kind: FailureKind;
  model: string;
  mod: Mod;
  gate: PromotionGate;
  /** Where it came from: 'halo' | 'proxy-log' | transfer source. */
  source: string;
  frequency: number;
  createdAt: string;
  status: 'pending' | 'validated' | 'rejected' | 'promoted';
  /** Set once validated. */
  validationDelta?: number;
  note?: string;
}

export class PendingQueue {
  private items: PendingProposal[] = [];

  constructor(private readonly path: string) {
    if (existsSync(path)) {
      try {
        this.items = JSON.parse(readFileSync(path, 'utf-8'));
      } catch {
        this.items = [];
      }
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.items, null, 2), 'utf-8');
  }

  /** Enqueue a proposal, de-duped by (model, signature, mod-shape) while pending. */
  enqueue(p: Omit<PendingProposal, 'gate' | 'status' | 'createdAt'> & { createdAt: string }): PendingProposal {
    const full: PendingProposal = { ...p, gate: promotionGate(p.mod), status: 'pending' };
    const exists = this.items.some(
      (x) =>
        x.status === 'pending' &&
        x.model === full.model &&
        x.signature === full.signature &&
        JSON.stringify(x.mod) === JSON.stringify(full.mod),
    );
    if (!exists) {
      this.items.push(full);
      this.persist();
    }
    return full;
  }

  list(status?: PendingProposal['status']): PendingProposal[] {
    return status ? this.items.filter((x) => x.status === status) : [...this.items];
  }

  update(id: string, patch: Partial<PendingProposal>): void {
    const it = this.items.find((x) => x.id === id);
    if (it) {
      Object.assign(it, patch);
      this.persist();
    }
  }
}

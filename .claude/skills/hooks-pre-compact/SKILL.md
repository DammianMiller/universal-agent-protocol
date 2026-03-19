---
name: hooks-pre-compact
description: Pre-compact hook for database optimization, cleanup, and CLAUDE.md compliance preservation
---

# Pre-Compact Hook

Automated hook that runs before database compaction operations, preserving CLAUDE.md adherence context.

## Purpose

Ensures database integrity, optimizes performance, and preserves critical architectural constraints before compaction.

This hook:
- Validates database state
- Runs integrity checks
- Prepares data for compaction
- Creates backup snapshots
- **PRESERVES CLAUDE.md adherence** - Explicitly logs architectural constraints, security rules, and quality gates to memory before context compaction

## Functions

- Validates database state
- Runs integrity checks
- Prepares data for compaction
- Creates backup snapshots

## Usage

Automatically invoked before compaction tasks.

## Location

`.forge/hooks/pre-compact.sh` (also mirrored at `.uap/omp/hooks/pre/pre-compact.sh`)

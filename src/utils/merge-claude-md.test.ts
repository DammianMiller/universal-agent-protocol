import { describe, it, expect } from 'vitest';
import { mergeClaudeMd } from './merge-claude-md.js';

describe('mergeClaudeMd', () => {
  it('should preserve custom sections from existing content', () => {
    const existing = `<coding_guidelines>

# CLAUDE.md - Test Project

## MEMORY SYSTEM

Old memory content

---

## Custom Section

This is a custom section added by the user.
It should be preserved during merge.

---

## Quick Reference

Old quick reference

---

</coding_guidelines>`;

    const newContent = `<coding_guidelines>

# CLAUDE.md - Test Project

## MEMORY SYSTEM

New memory system with updated instructions

---

## Quick Reference

New quick reference content

---

</coding_guidelines>`;

    const result = mergeClaudeMd(existing, newContent);

    // Should contain updated standard sections
    expect(result).toContain('New memory system with updated instructions');
    expect(result).toContain('New quick reference content');

    // Should preserve custom section
    expect(result).toContain('Custom Section');
    expect(result).toContain('This is a custom section added by the user');

    // Should not contain old standard section content
    expect(result).not.toContain('Old memory content');
    expect(result).not.toContain('Old quick reference');
  });

  it('should update preamble from new content', () => {
    const existing = `<coding_guidelines>

# CLAUDE.md - Old Project Name

> Old description

---

## Quick Reference

Content

---

</coding_guidelines>`;

    const newContent = `<coding_guidelines>

# CLAUDE.md - New Project Name

> New description with updated info

---

## Quick Reference

Content

---

</coding_guidelines>`;

    const result = mergeClaudeMd(existing, newContent);

    expect(result).toContain('New Project Name');
    expect(result).toContain('New description with updated info');
    expect(result).not.toContain('Old Project Name');
    expect(result).not.toContain('Old description');
  });

  it('should handle content without custom sections', () => {
    const existing = `<coding_guidelines>

# CLAUDE.md - Test

## MEMORY SYSTEM

Memory content

---

</coding_guidelines>`;

    const newContent = `<coding_guidelines>

# CLAUDE.md - Test

## MEMORY SYSTEM

Updated memory content

---

## Quick Reference

New section

---

</coding_guidelines>`;

    const result = mergeClaudeMd(existing, newContent);

    expect(result).toContain('Updated memory content');
    expect(result).toContain('Quick Reference');
    expect(result).toContain('New section');
  });

  it('should preserve multiple custom sections', () => {
    const existing = `<coding_guidelines>

# CLAUDE.md - Test

## MEMORY SYSTEM

Old content

---

## Custom Section 1

Custom content 1

---

## Custom Section 2

Custom content 2

---

## Quick Reference

Old ref

---

</coding_guidelines>`;

    const newContent = `<coding_guidelines>

# CLAUDE.md - Test

## MEMORY SYSTEM

New content

---

## Quick Reference

New ref

---

</coding_guidelines>`;

    const result = mergeClaudeMd(existing, newContent);

    expect(result).toContain('Custom Section 1');
    expect(result).toContain('Custom content 1');
    expect(result).toContain('Custom Section 2');
    expect(result).toContain('Custom content 2');
    expect(result).toContain('New content');
    expect(result).toContain('New ref');
  });
});

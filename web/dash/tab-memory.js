/**
 * tab-memory.js — Memory tab stub
 * Registers with UAP.registerTab and renders a "coming soon" message
 * (textContent only, per the module contract — no innerHTML).
 */

UAP.registerTab('memory', {
  label: 'Memory',
  render(root, state) {
    root.textContent = 'Memory — coming soon';
  }
});

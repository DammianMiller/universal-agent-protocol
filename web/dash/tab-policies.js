/**
 * tab-policies.js — Policies tab stub
 * Registers with UAP.registerTab and renders a "coming soon" message
 * (textContent only, per the module contract — no innerHTML).
 */

UAP.registerTab('policies', {
  label: 'Policies',
  render(root, state) {
    root.textContent = 'Policies — coming soon';
  }
});

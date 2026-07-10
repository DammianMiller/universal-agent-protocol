/**
 * tab-deliver.js — Deliver tab stub
 * Registers with UAP.registerTab and renders a "coming soon" message
 * (textContent only, per the module contract — no innerHTML).
 */

UAP.registerTab('deliver', {
  label: 'Deliver',
  render(root, state) {
    root.textContent = 'Deliver — coming soon';
  }
});

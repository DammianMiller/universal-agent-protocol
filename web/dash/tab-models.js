/**
 * tab-models.js — Models tab stub
 * Registers with UAP.registerTab and renders a "coming soon" message
 * (textContent only, per the module contract — no innerHTML).
 */

UAP.registerTab('models', {
  label: 'Models',
  render(root, state) {
    root.textContent = 'Models — coming soon';
  }
});

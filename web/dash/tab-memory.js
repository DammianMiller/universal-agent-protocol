// tab-memory.js — Memory tab stub
// Registers with UAP.registerTab and renders a 'coming soon' message.

(function () {
  'use strict';

  const TAB_ID = 'memory';
  const TAB_LABEL = 'Memory';

  function render(root, state) {
    root.innerHTML = '';

    const comingSoon = document.createElement('div');
    comingSoon.className = 'tab-coming-soon';
    comingSoon.textContent = 'Coming soon: Memory tab will display L1-L4 cache, compression, hit/miss gauge, and recent queries.';

    root.appendChild(comingSoon);
  }

  if (typeof UAP !== 'undefined' && typeof UAP.registerTab === 'function') {
    UAP.registerTab(TAB_ID, {
      label: TAB_LABEL,
      render: render
    });
  }
})();
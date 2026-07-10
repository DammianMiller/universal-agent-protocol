// tab-models.js — Models tab stub
// Registers with UAP.registerTab and renders a 'coming soon' message.

(function () {
  'use strict';

  const TAB_ID = 'models';
  const TAB_LABEL = 'Models';

  function render(root, state) {
    root.innerHTML = '';

    const comingSoon = document.createElement('div');
    comingSoon.className = 'tab-coming-soon';
    comingSoon.textContent = 'Coming soon: Models tab will display models/routing config, session usage, and routing decisions.';

    root.appendChild(comingSoon);
  }

  if (typeof UAP !== 'undefined' && typeof UAP.registerTab === 'function') {
    UAP.registerTab(TAB_ID, {
      label: TAB_LABEL,
      render: render
    });
  }
})();
/**
 * tab-tasks.js — Stub tab: Tasks
 * Registers with UAP.registerTab and renders a 'coming soon' message.
 */
(function () {
  'use strict';

  function render() {
    var el = document.createElement('div');
    el.className = 'coming-soon';
    el.innerHTML =
      '<div class="icon">📋</div>' +
      '<h2>Tasks</h2>' +
      '<p>Coming soon</p>';
    return el;
  }

  if (typeof UAP !== 'undefined' && typeof UAP.registerTab === 'function') {
    UAP.registerTab('tasks', { render: render });
  }
})();
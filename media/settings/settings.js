// @ts-check
(function () {
  const vscode = acquireVsCodeApi();
  const FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h'];
  const FIELD_LABELS = ['Input', 'Output', 'Cache read', 'Cache write 5m', 'Cache write 1h'];

  let payload = null;

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'settings') {
      payload = msg.payload;
      render();
    }
  });

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function relTime(ms) {
    const d = Date.now() - ms;
    const m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function set(key, value) {
    vscode.postMessage({ type: 'set', key, value });
  }

  function checkbox(key, label, hint) {
    const checked = payload.config[key] ? 'checked' : '';
    return (
      '<label><input type="checkbox" data-key="' + esc(key) + '" ' + checked + '> ' +
      esc(label) + (hint ? '<span class="hint">' + esc(hint) + '</span>' : '') + '</label>'
    );
  }

  function render() {
    const cfg = payload.config;

    if (cfg['appearance.accentColor']) {
      document.body.style.setProperty('--accent', cfg['appearance.accentColor']);
    }

    document.getElementById('statusbar-toggles').innerHTML = [
      checkbox('statusBar.showCost', "Today's cost"),
      checkbox('statusBar.showWorkspaceCost', 'Current workspace cost', "— today's cost for projects open in this window"),
      checkbox('statusBar.showSessionCost', 'Live session cost', '— running cost of the active conversation'),
      checkbox('statusBar.show5hQuota', '5-hour quota percentage'),
      checkbox('statusBar.show7dQuota', 'Weekly quota percentage'),
      checkbox('statusBar.showResetCountdown', '5-hour reset countdown'),
    ].join('');

    document.getElementById('appearance').innerHTML =
      '<label>Accent color <input type="color" id="accent-color" value="' +
      esc(cfg['appearance.accentColor']) + '"></label>' +
      '<label>Week card measures <select id="week-metric">' +
      '<option value="calendar"' + (cfg['dashboard.weekMetric'] === 'calendar' ? ' selected' : '') + '>Calendar week (since Sunday)</option>' +
      '<option value="rolling"' + (cfg['dashboard.weekMetric'] === 'rolling' ? ' selected' : '') + '>Rolling 7-day window</option>' +
      '</select></label>' +
      checkbox('stats.streakExcludesWeekends', 'Streak ignores weekends', '— Sat/Sun neither count toward nor break the streak');

    document.getElementById('budget').innerHTML =
      '<label>Monthly budget (USD, 0 = off) <input type="number" id="budget-input" min="0" step="10" value="' +
      esc(cfg['budget.monthly'] || 0) + '"></label>' +
      checkbox('alerts.enabled', 'Alerts', '— notify at 80%/95% quota and 80%/100% budget');

    document.getElementById('network').innerHTML = [
      checkbox('quota.enabled', 'Live quota', '— minimal request to api.anthropic.com using your Claude Code sign-in'),
      checkbox('pricing.autoUpdate', 'Auto-update pricing', '— daily anonymous fetch from models.dev'),
      '<label>Ledger location <input type="text" id="ledger-path" placeholder="default: extension storage" value="' +
      esc(cfg.ledgerPath || '') + '" spellcheck="false">' +
      '<span class="hint">— point at a synced folder (iCloud/Dropbox) for backup; existing data is merged</span></label>',
      '<label><button id="export-data">Export usage data…</button> <button id="import-data">Import…</button>' +
      '<span class="hint">— CSV/JSON export; import merges a JSON export from another machine</span></label>',
    ].join('');

    const meta = payload.pricingMeta;
    document.getElementById('pricing-meta').textContent =
      meta && meta.source === 'live'
        ? 'Using the live models.dev catalog' +
          (meta.fetchedAtMs ? ', fetched ' + relTime(meta.fetchedAtMs) : '') +
          '. Rows marked OVERRIDE use your values.'
        : 'Using the bundled pricing table. Rows marked OVERRIDE use your values.';

    renderPricingTable();
    wireToggleEvents();
  }

  function renderPricingTable() {
    const header =
      '<tr><th>Model</th><th>Source</th>' +
      FIELD_LABELS.map((l) => '<th>' + l + '</th>').join('') +
      '<th></th></tr>';

    const rows = payload.catalog
      .map((row) => {
        const inputs = FIELDS.map(
          (f) =>
            '<td><input type="number" min="0" step="any" data-field="' + f +
            '" value="' + row.pricing[f] + '"></td>'
        ).join('');
        const reset = row.source === 'override' ? '<button class="reset">Reset</button>' : '';
        return (
          '<tr data-model="' + esc(row.model) + '">' +
          '<td class="model">' + esc(row.model) + '</td>' +
          '<td><span class="badge badge-' + row.source + '">' + row.source + '</span></td>' +
          inputs +
          '<td class="actions"><button class="save" hidden>Save</button> ' + reset + '</td>' +
          '</tr>'
        );
      })
      .join('');

    document.getElementById('pricing-table').innerHTML = header + rows;
  }

  function wireToggleEvents() {
    document.querySelectorAll('input[type="checkbox"][data-key]').forEach((el) => {
      el.onchange = () => set(el.dataset.key, el.checked);
    });
    const accent = document.getElementById('accent-color');
    if (accent) accent.onchange = () => set('appearance.accentColor', accent.value);
    const week = document.getElementById('week-metric');
    if (week) week.onchange = () => set('dashboard.weekMetric', week.value);
    const budget = document.getElementById('budget-input');
    if (budget) {
      budget.onchange = () => {
        const v = parseFloat(budget.value);
        set('budget.monthly', Number.isFinite(v) && v >= 0 ? v : 0);
      };
    }
    const exportBtn = document.getElementById('export-data');
    if (exportBtn) exportBtn.onclick = () => vscode.postMessage({ type: 'exportData' });
    const importBtn = document.getElementById('import-data');
    if (importBtn) importBtn.onclick = () => vscode.postMessage({ type: 'importData' });
    const ledgerPath = document.getElementById('ledger-path');
    if (ledgerPath) ledgerPath.onchange = () => set('ledgerPath', ledgerPath.value.trim());
  }

  // Static elements — wire once. The table body is re-rendered, so use
  // delegation for row-level events.
  const table = document.getElementById('pricing-table');

  table.addEventListener('input', (e) => {
    const row = e.target.closest('tr');
    const save = row && row.querySelector('.save');
    if (save) save.hidden = false;
  });

  table.addEventListener('click', (e) => {
    const row = e.target.closest('tr');
    if (!row) return;
    const model = row.dataset.model;
    if (e.target.classList.contains('save')) {
      const pricing = {};
      row.querySelectorAll('input[type="number"]').forEach((input) => {
        const v = parseFloat(input.value);
        pricing[input.dataset.field] = Number.isFinite(v) && v >= 0 ? v : 0;
      });
      vscode.postMessage({ type: 'setOverride', model, pricing });
    } else if (e.target.classList.contains('reset')) {
      vscode.postMessage({ type: 'setOverride', model, pricing: null });
    }
  });

  document.getElementById('refresh-pricing').addEventListener('click', () => {
    vscode.postMessage({ type: 'refreshPricing' });
  });

  document.getElementById('add-override').addEventListener('click', () => {
    const input = document.getElementById('new-model');
    const model = input.value.trim();
    if (model) {
      vscode.postMessage({ type: 'addOverride', model });
      input.value = '';
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

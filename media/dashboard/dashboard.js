// @ts-check
(function () {
  const vscode = acquireVsCodeApi();

  // UI state survives re-renders (and tab switches via retainContext).
  let activeTab = 'overview';
  let chartGranularity = 'daily';
  let chartMetric = 'tokens';
  let calRange = '12m';
  let calMetric = 'tokens';
  let lastState = null;
  let lastConfig = {};
  const expandedProjects = new Set();
  const expandedModels = new Set();

  const TABS = [
    ['overview', 'Overview'],
    ['projects', 'Projects'],
    ['models', 'Models'],
    ['sessions', 'Sessions'],
  ];

  document.getElementById('tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    if (lastState) render();
  });

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg && msg.type === 'state') {
      lastState = msg.state;
      lastConfig = msg.config || {};
      document.getElementById('refresh').classList.remove('spin');
      render();
    }
  });

  document.getElementById('open-settings').addEventListener('click', () => {
    vscode.postMessage({ type: 'openSettings' });
  });

  document.getElementById('refresh').addEventListener('click', (e) => {
    e.currentTarget.classList.add('spin');
    vscode.postMessage({ type: 'refresh' });
  });

  document.getElementById('activity').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.gran) chartGranularity = btn.dataset.gran;
    if (btn.dataset.metric) chartMetric = btn.dataset.metric;
    if (lastState) render();
  });

  document.getElementById('calendar').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.calrange) calRange = btn.dataset.calrange;
    if (btn.dataset.calmetric) calMetric = btn.dataset.calmetric;
    if (lastState) render();
  });

  document.getElementById('projects').addEventListener('click', (e) => {
    const row = e.target.closest('tr.proj-row');
    if (!row) return;
    const path = row.dataset.path;
    if (expandedProjects.has(path)) expandedProjects.delete(path);
    else expandedProjects.add(path);
    if (lastState) render();
  });

  document.getElementById('models').addEventListener('click', (e) => {
    const row = e.target.closest('tr.model-row');
    if (!row) return;
    const model = row.dataset.model;
    if (expandedModels.has(model)) expandedModels.delete(model);
    else expandedModels.add(model);
    if (lastState) render();
  });

  // One global tooltip for anything carrying data-label (chart bars, heatmap
  // cells, sparklines) — instant, unlike native <title> tooltips.
  const tip = document.getElementById('tip');
  document.addEventListener('mousemove', (e) => {
    const target = e.target && e.target.closest ? e.target.closest('[data-label]') : null;
    if (!target) {
      tip.hidden = true;
      return;
    }
    tip.querySelector('b').textContent = target.dataset.label;
    tip.querySelector('span').textContent = target.dataset.value || '';
    tip.hidden = false;
    const pad = 14;
    let x = e.clientX + pad;
    if (x + tip.offsetWidth > document.documentElement.clientWidth - 10) {
      x = e.clientX - tip.offsetWidth - pad;
    }
    tip.style.left = Math.max(x, 4) + 'px';
    tip.style.top = Math.max(e.clientY - tip.offsetHeight - 12, 4) + 'px';
  });

  // Calendar cells are sized from the panel width — re-render on resize.
  let resizeTimer;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (lastState) render();
    }, 150);
  });

  vscode.postMessage({ type: 'ready' });

  /* ---------- helpers ---------- */

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtCost(usd) {
    if (usd === 0) return '$0.00';
    if (usd < 0.01) return (usd * 100).toFixed(2) + '¢';
    if (usd < 1) return '$' + usd.toFixed(3);
    if (usd < 100) return '$' + usd.toFixed(2);
    return '$' + Math.round(usd).toLocaleString();
  }

  function fmtTokens(n) {
    if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
    return String(n);
  }

  function fmtPct(v) {
    if (v > 1) return 'maxed';
    if (v <= 0) return '0%';
    if (v < 0.001) return '<0.1%';
    if (v < 0.1) return (v * 100).toFixed(1) + '%';
    return Math.round(v * 100) + '%';
  }

  function relTime(ms) {
    const d = Date.now() - ms;
    const m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    const dy = Math.floor(h / 24);
    if (dy < 30) return dy + 'd ago';
    return new Date(ms).toLocaleDateString();
  }

  function timeUntil(ms) {
    const diff = ms - Date.now();
    if (diff <= 0) return 'soon';
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    if (h >= 24) return 'in ' + Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
    if (h > 0) return 'in ' + h + 'h ' + m + 'm';
    return 'in ' + m + 'm';
  }

  function modelShortName(model) {
    const s = model
      .replace(/^claude-/, '')
      .replace(/\[[^\]]*\]$/, '') // claude-fable-5[1m] → fable-5
      .replace(/-\d{8,}$/, '') // dated ids → haiku-4-5
      .replace(/-(\d)/, ' $1');
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  function quotaLevel(pct) {
    if (pct >= 90) return 'danger';
    if (pct >= 70) return 'warn';
    return 'ok';
  }

  /** Round up to a "nice" axis ceiling: 1/2/2.5/5 × 10^k. */
  function niceCeil(v) {
    const pow = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / pow;
    const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
    return nice * pow;
  }

  function fmtMetric(v) {
    return chartMetric === 'cost' ? fmtCost(v) : fmtTokens(v);
  }

  /** Spend delta vs a reference period. Up = spending more (red-ish). */
  function delta(current, prev, title) {
    if (!(prev > 0) || current == null) return '';
    const pct = ((current - prev) / prev) * 100;
    if (!isFinite(pct)) return '';
    const up = pct >= 0;
    return (
      '<span class="delta ' + (up ? 'up' : 'down') + '" title="' +
      esc(title + ': ' + fmtCost(prev)) + '">' +
      (up ? '▲' : '▼') + Math.abs(Math.round(pct)) + '%</span>'
    );
  }

  /* ---------- render ---------- */

  function render() {
    const state = lastState;
    const config = lastConfig;
    const s = state.summary;
    const q = state.quota;

    if (config.accentColor) {
      document.body.style.setProperty('--accent', config.accentColor);
    }

    const pricingNote = state.pricing
      ? state.pricing.source === 'live'
        ? 'live pricing' + (state.pricing.fetchedAtMs ? ' · ' + relTime(state.pricing.fetchedAtMs) : '')
        : 'bundled pricing'
      : '';
    document.getElementById('last-updated').textContent = s
      ? 'Updated ' + relTime(s.lastUpdatedMs) + (pricingNote ? ' · ' + pricingNote : '')
      : '';

    if (!s) {
      document.getElementById('spend').innerHTML =
        '<p class="empty">No Claude Code usage found yet. Data appears here after your first Claude Code session.</p>';
      return;
    }

    // Tabs first, so sections are visible (and measurable) when they render.
    renderTabs(s);
    applyTab();

    renderSpend(s, config);
    renderActivity(s, config);
    renderCalendar(s, config);
    renderQuota(q, state.forecast, s);
    renderTokens(s);
    renderProjects(s);
    renderModels(s);
    renderTools(s);
    renderSessions(s);
  }

  function renderTabs(s) {
    const counts = {
      projects: s.byProject.length,
      models: s.byModel.length,
      sessions: s.byProject.reduce((a, p) => a + (p.sessionCount || 0), 0),
    };
    document.getElementById('tabs').innerHTML = TABS.map(
      ([id, label]) =>
        '<button data-tab="' + id + '" class="tab' + (activeTab === id ? ' active' : '') + '">' +
        label +
        (counts[id] ? ' <span class="count">' + counts[id] + '</span>' : '') +
        '</button>'
    ).join('');
  }

  function applyTab() {
    document.querySelectorAll('main > section').forEach((sec) => {
      sec.classList.toggle('hidden-tab', sec.dataset.tab !== activeTab);
    });
  }

  function card(label, qualifier, value, sub, opts) {
    opts = opts || {};
    return (
      '<div class="card' + (opts.cls ? ' ' + opts.cls : '') + '">' +
      '<div class="label">' + esc(label) +
      (qualifier ? ' <span class="qual">(' + esc(qualifier) + ')</span>' : '') +
      '</div>' +
      '<div class="value">' + value + (opts.delta || '') + '</div>' +
      (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
      (opts.extra || '') +
      '</div>'
    );
  }

  function renderSpend(s, config) {
    const rolling = config.weekMetric === 'rolling';
    const weekCost = rolling ? s.lastSevenDays.costUSD : s.weekCost;
    const weekPrev = rolling ? s.prevRolling7dCost : s.prevWeekCost;
    const weekTokens = rolling ? s.lastSevenDays.tokens : s.weekTokens || 0;
    const since = s.firstUsageMs ? new Date(s.firstUsageMs).toLocaleDateString() : null;

    document.getElementById('spend').innerHTML =
      '<div class="cards">' +
      card('Today', null, esc(fmtCost(s.todayCost)),
        fmtTokens(s.todayTokens) + ' tokens · ' + s.todayMessages + ' messages',
        { cls: 'accent', delta: delta(s.todayCost, s.yesterdayCost, 'yesterday') }) +
      card(rolling ? 'Last 7 Days' : 'This Week', rolling ? 'rolling window' : 'since Sunday',
        esc(fmtCost(weekCost)), fmtTokens(weekTokens) + ' tokens',
        { delta: delta(weekCost, weekPrev, rolling ? 'previous 7 days' : 'last week') }) +
      card('This Month', 'calendar month', esc(fmtCost(s.monthCost)),
        fmtTokens(s.monthTokens || 0) + ' tokens' +
          (s.monthProjectedCost != null ? ' · on pace for ' + fmtCost(s.monthProjectedCost) : ''),
        {
          delta: delta(s.monthProjectedCost, s.prevMonthCost, 'projected vs last month total'),
          extra: budgetBar(s.monthCost, config.budgetMonthly),
        }) +
      card('All Time', since ? 'since ' + since : null, esc(fmtCost(s.allTimeCost)),
        fmtTokens(s.allTimeTokens) + ' tokens') +
      '</div>';
  }

  function budgetBar(spent, budget) {
    if (!(budget > 0)) return '';
    const ratio = spent / budget;
    const lvl = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warn' : 'ok';
    return (
      '<div class="track"><div class="fill lvl-' + lvl + '" style="width:' +
      Math.min(ratio * 100, 100).toFixed(1) + '%"></div></div>' +
      '<div class="sub">' + fmtCost(spent) + ' of ' + fmtCost(budget) + ' budget (' +
      Math.round(ratio * 100) + '%)</div>'
    );
  }

  /* ---------- activity chart ---------- */

  const GRANULARITIES = [
    ['hourly', 'Hour'],
    ['daily', 'Day'],
    ['weekly', 'Week'],
    ['monthly', 'Month'],
  ];
  const METRICS = [
    ['tokens', 'Tokens'],
    ['cost', 'Cost'],
  ];

  function seg(options, active, attr) {
    return (
      '<div class="seg">' +
      options
        .map(
          ([value, label]) =>
            '<button data-' + attr + '="' + value + '"' +
            (value === active ? ' class="active"' : '') + '>' + label + '</button>'
        )
        .join('') +
      '</div>'
    );
  }

  function bucketLabel(startMs, long) {
    const d = new Date(startMs);
    switch (chartGranularity) {
      case 'hourly':
        return long
          ? d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
          : d.toLocaleTimeString(undefined, { hour: 'numeric' });
      case 'weekly':
        return (long ? 'Week of ' : '') +
          d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      case 'monthly':
        return d.toLocaleDateString(undefined, long ? { month: 'long', year: 'numeric' } : { month: 'short' });
      default:
        return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    }
  }

  function renderActivity(s, config) {
    const el = document.getElementById('activity');
    if (!s.series) {
      el.innerHTML = '';
      return;
    }
    const points = s.series[chartGranularity] || [];
    const head =
      '<div class="section-head"><h2>Activity</h2><div class="seg-group">' +
      seg(METRICS, chartMetric, 'metric') +
      seg(GRANULARITIES, chartGranularity, 'gran') +
      '</div></div>';

    const values = points.map((p) => (chartMetric === 'cost' ? p.costUSD : p.tokens));
    const max = Math.max.apply(null, values);
    if (!(max > 0)) {
      el.innerHTML = head + '<p class="empty">No activity in this range.</p>';
      return;
    }

    const W = 960;
    const H = 206;
    const padT = 8;
    const padL = 48; // y-axis label gutter — keeps labels clear of the bars
    const padB = 22;
    const innerH = H - padT - padB;
    const n = points.length;
    const gap = n > 32 ? 3 : 6;
    const bw = (W - padL - gap * (n - 1)) / n;
    const labelEvery = Math.ceil(n / 8);
    const yMax = niceCeil(max);
    const baseY = padT + innerH;

    let grid = '';
    for (const frac of [0.25, 0.5, 0.75, 1]) {
      const y = baseY - frac * innerH;
      grid +=
        '<line class="grid" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + W + '" y2="' + y.toFixed(1) + '"/>' +
        '<text class="ytick" x="' + (padL - 7) + '" y="' + (y + 3).toFixed(1) +
        '" text-anchor="end">' + esc(fmtMetric(yMax * frac)) + '</text>';
    }

    let bars = '';
    let labels = '';
    points.forEach((p, i) => {
      const total = values[i];
      const x = padL + i * (bw + gap);
      if (total > 0) {
        // Per-model breakdown lives in the tooltip, one line per model.
        const byModel = Object.entries(p.byModel || {})
          .map(([m, mb]) => [m, chartMetric === 'cost' ? mb.costUSD : mb.tokens])
          .filter(([, v]) => v > 0)
          .sort((a, b) => b[1] - a[1])
          .map(([m, v]) => modelShortName(m) + ' · ' + fmtMetric(v))
          .join('\n');
        const value =
          (chartMetric === 'cost'
            ? fmtCost(p.costUSD) + ' · ' + fmtTokens(p.tokens) + ' tokens'
            : fmtTokens(p.tokens) + ' tokens · ' + fmtCost(p.costUSD)) +
          (byModel ? '\n' + byModel : '');
        const h = Math.max((total / yMax) * innerH, 2);
        bars +=
          '<rect class="bar" x="' + x.toFixed(1) + '" y="' + (baseY - h).toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2"' +
          ' data-label="' + esc(bucketLabel(p.startMs, true)) +
          '" data-value="' + esc(value) + '"></rect>';
      }
      if (i % labelEvery === 0) {
        const cx = x + bw / 2;
        const anchor = cx < padL + 24 ? 'start' : cx > W - 28 ? 'end' : 'middle';
        labels +=
          '<text x="' + cx.toFixed(1) + '" y="' + (H - 6) + '" text-anchor="' + anchor + '">' +
          esc(bucketLabel(p.startMs, false)) + '</text>';
      }
    });

    el.innerHTML =
      head +
      '<div class="chart"><svg viewBox="0 0 ' + W + ' ' + H + '">' +
      grid +
      '<line class="base" x1="' + padL + '" y1="' + baseY + '" x2="' + W + '" y2="' + baseY + '"/>' +
      bars + labels +
      '</svg></div>';
  }

  /* ---------- contribution calendar ---------- */

  const CAL_RANGES = [
    ['3m', '3M'],
    ['6m', '6M'],
    ['12m', '12M'],
  ];
  const CAL_METRICS = [
    ['tokens', 'Tokens'],
    ['cost', 'Cost'],
  ];

  function renderCalendar(s, config) {
    const el = document.getElementById('calendar');
    const all = s.calendar;
    if (!all || !all.length) {
      el.innerHTML = '';
      return;
    }

    // Slice whole weeks off the front for shorter ranges.
    const weeksWanted = calRange === '3m' ? 13 : calRange === '6m' ? 26 : 53;
    const weeksTotal = Math.ceil(all.length / 7);
    const days = all.slice(Math.max(0, (weeksTotal - weeksWanted) * 7));

    // Square cells sized to fill the panel width (capped so short ranges
    // don't balloon); the grid is centered, so no lopsided margin.
    const nWeeksNow = Math.ceil(days.length / 7);
    const avail = (el.clientWidth || 960) - 40 /* section padding */ - 34 /* day labels */;
    const cap = calRange === '3m' ? 32 : calRange === '6m' ? 24 : 20;
    const cell = Math.max(9, Math.min(cap, Math.floor((avail - (nWeeksNow - 1) * 3) / nWeeksNow)));

    let max = 0;
    for (const d of days) max = Math.max(max, calMetric === 'cost' ? d.costUSD : d.tokens);

    const excludeWk = !!config.streakExcludesWeekends;
    const streak = (excludeWk ? s.streakDaysNoWeekends : s.streakDays) || 0;
    const maxStreak = (excludeWk ? s.maxStreakDaysNoWeekends : s.maxStreakDays) || 0;
    const head =
      '<div class="section-head"><h2>Activity Calendar</h2><div class="seg-group">' +
      seg(CAL_METRICS, calMetric, 'calmetric') +
      seg(CAL_RANGES, calRange, 'calrange') +
      '</div></div>';
    const foot =
      '<div class="cal-foot" title="Streaks count consecutive days of usage' +
      (excludeWk ? '; weekends neither count nor break them' : '') + '">' +
      '🔥 <b>' + streak + 'd</b> current streak<span class="sep">·</span><b>' + maxStreak +
      'd</b> longest streak<span class="sep">·</span><b>' + (s.totalActiveDays || 0) +
      '</b> active days</div>';

    const nWeeks = Math.ceil(days.length / 7);

    // Month labels above the column where the month changes.
    let months = '';
    let prevMonth = -1;
    for (let w = 0; w < nWeeks; w++) {
      const first = new Date(days[Math.min(w * 7, days.length - 1)].startMs);
      if (first.getMonth() !== prevMonth) {
        months +=
          '<span style="grid-column-start:' + (w + 1) + '">' +
          first.toLocaleDateString(undefined, { month: 'short' }) + '</span>';
        prevMonth = first.getMonth();
      }
    }

    let cells = '';
    for (const d of days) {
      const v = calMetric === 'cost' ? d.costUSD : d.tokens;
      const lvl = v === 0 || max === 0 ? 0 : Math.max(1, Math.ceil((v / max) * 4));
      const label = new Date(d.startMs).toLocaleDateString(undefined, {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      });
      const value =
        d.tokens === 0 ? 'no usage' : fmtTokens(d.tokens) + ' tokens · ' + fmtCost(d.costUSD);
      cells +=
        '<span class="cal-cell l' + lvl + '" data-label="' + esc(label) +
        '" data-value="' + esc(value) + '"></span>';
    }

    const rows = 'grid-template-rows:repeat(7,' + cell + 'px)';
    const dayLabels =
      '<span></span><span>Mon</span><span></span><span>Wed</span><span></span><span>Fri</span><span></span>';

    el.innerHTML =
      head +
      '<div class="cal"><div class="cal-days" style="' + rows + '">' + dayLabels + '</div>' +
      '<div class="cal-main">' +
      '<div class="cal-months" style="grid-template-columns:repeat(' + nWeeks + ',' + cell + 'px)">' + months + '</div>' +
      '<div class="cal-grid" style="' + rows + ';grid-auto-columns:' + cell + 'px">' + cells + '</div>' +
      '</div></div>' +
      foot;
  }

  /* ---------- quota ---------- */

  function atTime(ms) {
    const d = new Date(ms);
    const sameDay = d.toDateString() === new Date().toDateString();
    return sameDay
      ? 'at ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' });
  }

  function sinceLabel(ms) {
    const d = new Date(ms);
    return d.toDateString() === new Date().toDateString()
      ? d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  }

  function quotaCard(label, utilization, resetAtMs, paceHtml, windowUsage, windowMs) {
    const pct = Math.min(utilization * 100, 100);
    const lvl = quotaLevel(pct);
    const used = windowUsage
      ? '<div class="sub">used since ' + esc(sinceLabel(resetAtMs - windowMs)) + ' (window start): ' +
        fmtTokens(windowUsage.tokens) + ' tokens · ' + fmtCost(windowUsage.costUSD) + '</div>'
      : '';
    return (
      '<div class="card quota-card">' +
      '<div class="label">' + esc(label) + '</div>' +
      '<div class="quota-row"><span class="value lvl-' + lvl + '">' + fmtPct(utilization) + '</span>' +
      '<span class="sub">resets ' + timeUntil(resetAtMs) + (paceHtml || '') + '</span></div>' +
      '<div class="track"><div class="fill lvl-' + lvl + '" style="width:' + pct.toFixed(1) + '%"></div></div>' +
      used +
      '</div>'
    );
  }

  /** Some plans only enforce the 5h window — the 7d header never appears. */
  function noWeeklyLimitCard(s) {
    const rolling = s && s.lastSevenDays;
    return (
      '<div class="card quota-card">' +
      '<div class="label">Weekly (7d)</div>' +
      '<div class="quota-row"><span class="value dim">∞</span>' +
      '<span class="sub" title="Anthropic isn\'t returning a 7-day utilization header for your account, so there is no weekly percentage to show.">no weekly limit reported</span></div>' +
      '<div class="track na"></div>' +
      (rolling
        ? '<div class="sub">used in the last 7 days: ' + fmtTokens(rolling.tokens) + ' tokens · ' +
          fmtCost(rolling.costUSD) + '</div>'
        : '') +
      '</div>'
    );
  }

  function weeklyPaceHtml(weekly) {
    if (!weekly) return '';
    const title = weekly.usedWeekdayProfile
      ? 'Projection weights your average usage per weekday — quiet weekends count as quiet.'
      : 'Projection uses your flat daily average (weekday patterns kick in after ~2 weeks of history).';
    if (weekly.level === 'risk') {
      return (
        ' · <span class="lvl-danger" title="' + esc(title) + '">⚠ may run out ' +
        (weekly.runsOutAtMs ? esc(atTime(weekly.runsOutAtMs)) : 'before reset') + '</span>'
      );
    }
    const pct = Math.round(weekly.projectedUtilization * 100);
    if (weekly.level === 'tight') {
      return ' · <span class="lvl-warn" title="' + esc(title) + '">tight · ~' + pct + '% at reset</span>';
    }
    return ' · <span class="dim" title="' + esc(title) + '">on pace · ~' + pct + '% at reset</span>';
  }

  function renderQuota(q, forecast, s) {
    const f = forecast || {};
    const pace5 = f.fiveHourEtaMs
      ? ' · <span class="lvl-warn">on pace to max ' + esc(atTime(f.fiveHourEtaMs)) + '</span>'
      : '';
    const HOUR_MS = 3600000;
    const weeklyCard =
      q && q.sevenDayHeaderPresent === false
        ? noWeeklyLimitCard(s)
        : q
          ? quotaCard('Weekly (7d)', q.sevenDayUtilization, q.sevenDayResetAtMs,
              weeklyPaceHtml(f.weekly), s && s.sevenDayWindow, 7 * 24 * HOUR_MS)
          : '';
    document.getElementById('quota').innerHTML = q
      ? '<div class="section-head"><h2>Live Quota</h2></div><div class="cards two">' +
        quotaCard('Current Session (5h)', q.fiveHourUtilization, q.fiveHourResetAtMs, pace5,
          s && s.fiveHourWindow, 5 * HOUR_MS) +
        weeklyCard +
        '</div>'
      : '<div class="section-head"><h2>Live Quota</h2></div>' +
        '<p class="empty">Quota unavailable — requires a Claude Code OAuth sign-in and network access.</p>';
  }

  /* ---------- tokens (cost-weighted) ---------- */

  function renderTokens(s) {
    const el = document.getElementById('tokens');
    const tb = s.tokenBreakdown;
    const tc = s.tokenCostBreakdown;
    const totalTok = tb.input + tb.output + tb.cacheRead + tb.cacheWrite;
    if (totalTok === 0 || !tc) {
      el.innerHTML = '';
      return;
    }
    const costTotal = tc.input + tc.output + tc.cacheRead + tc.cacheWrite || 1;
    const classes = [
      ['Input', tb.input, tc.input, 'c-input'],
      ['Output', tb.output, tc.output, 'c-output'],
      ['Cache read', tb.cacheRead, tc.cacheRead, 'c-cread'],
      ['Cache write', tb.cacheWrite, tc.cacheWrite, 'c-cwrite'],
    ];

    const tiles = classes
      .map(
        ([name, tok, cost, cls]) =>
          '<div class="card mini"><div class="label"><i class="dot ' + cls + '"></i> ' + esc(name) + '</div>' +
          '<div class="value">' + fmtTokens(tok) + '</div>' +
          '<div class="sub">' + fmtCost(cost) + ' · ' + ((cost / costTotal) * 100).toFixed(1) + '% of cost</div></div>'
      )
      .join('');

    const stack = classes
      .filter(([, , cost]) => cost > 0)
      .map(
        ([name, tok, cost, cls]) =>
          '<div class="' + cls + '" style="flex-grow:' + cost + '" data-label="' + esc(name) +
          '" data-value="' + esc(fmtCost(cost) + ' (' + ((cost / costTotal) * 100).toFixed(1) +
          '% of cost) · ' + fmtTokens(tok) + ' tokens') + '"></div>'
      )
      .join('');

    el.innerHTML =
      '<div class="section-head"><h2>Tokens</h2><span class="meta">' +
      fmtTokens(totalTok) + ' tokens · sized by cost share</span></div>' +
      '<div class="cards minis">' + tiles + '</div>' +
      '<div class="stack">' + stack + '</div>';
  }

  /* ---------- projects (expandable) ---------- */

  function sparkSvg(values) {
    const recent = values.slice(-14);
    const max = Math.max.apply(null, recent);
    if (!(max > 0)) return '<span class="dim">–</span>';
    const bw = 4;
    const gap = 1;
    const H = 18;
    let rects = '';
    recent.forEach((v, i) => {
      if (v <= 0) return;
      const h = Math.max((v / max) * H, 1.5);
      rects +=
        '<rect x="' + i * (bw + gap) + '" y="' + (H - h).toFixed(1) +
        '" width="' + bw + '" height="' + h.toFixed(1) + '" rx="1"/>';
    });
    return '<svg class="spark" viewBox="0 0 ' + (14 * (bw + gap) - gap) + ' ' + H + '">' + rects + '</svg>';
  }

  function projectDetail(p) {
    // Tolerate summaries cached by older versions (models was cost-only).
    const models = Object.entries(p.models || {})
      .map(([m, v]) => [m, typeof v === 'number' ? { costUSD: v, tokens: 0 } : v])
      .sort((a, b) => b[1].costUSD - a[1].costUSD);
    const maxModelCost = models.length ? models[0][1].costUSD : 0;

    const modelRows = models
      .map(
        ([m, v]) =>
          '<div class="dm-row"><span class="dm-name">' + esc(modelShortName(m)) + '</span>' +
          '<div class="share"><div style="width:' +
          (maxModelCost > 0 ? Math.max((v.costUSD / maxModelCost) * 100, 2) : 0).toFixed(1) +
          '%"></div></div>' +
          '<span class="dm-val">' + fmtCost(v.costUSD) +
          (v.tokens ? ' <span class="dim">· ' + fmtTokens(v.tokens) + '</span>' : '') + '</span></div>'
      )
      .join('');

    // 30-day mini chart with axes
    const spark = p.spark || [];
    const max = Math.max.apply(null, spark.concat([0]));
    let chart = '<p class="empty">No activity in the last 30 days.</p>';
    if (max > 0) {
      const W = 360;
      const H = 96;
      const padT = 6;
      const padL = 32; // y-axis label gutter
      const padB = 15;
      const innerH = H - padT - padB;
      const baseY = padT + innerH;
      const n = spark.length;
      const gap = 2;
      const bw = (W - padL - gap * (n - 1)) / n;
      const yMax = niceCeil(max);

      const dayLabel = (i) =>
        new Date(Date.now() - (n - 1 - i) * 86400000).toLocaleDateString(undefined, {
          month: 'short',
          day: 'numeric',
        });

      let svg = '';
      for (const frac of [0.5, 1]) {
        const y = baseY - frac * innerH;
        svg +=
          '<line class="grid" x1="' + padL + '" y1="' + y.toFixed(1) + '" x2="' + W + '" y2="' + y.toFixed(1) + '"/>' +
          '<text class="ytick" x="' + (padL - 5) + '" y="' + (y + 3).toFixed(1) +
          '" text-anchor="end">' + esc(fmtCost(yMax * frac)) + '</text>';
      }
      svg += '<line class="base" x1="' + padL + '" y1="' + baseY + '" x2="' + W + '" y2="' + baseY + '"/>';

      spark.forEach((v, i) => {
        if (v <= 0) return;
        const h = Math.max((v / yMax) * innerH, 1.5);
        svg +=
          '<rect x="' + (padL + i * (bw + gap)).toFixed(1) + '" y="' + (baseY - h).toFixed(1) +
          '" width="' + bw.toFixed(1) + '" height="' + h.toFixed(1) + '" rx="1.5" data-label="' +
          esc(dayLabel(i)) + '" data-value="' + esc(fmtCost(v)) + '"></rect>';
      });

      for (const i of [0, Math.floor((n - 1) / 2), n - 1]) {
        const cx = padL + i * (bw + gap) + bw / 2;
        const anchor = i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle';
        svg +=
          '<text class="xtick" x="' + cx.toFixed(1) + '" y="' + (H - 3) + '" text-anchor="' + anchor + '">' +
          esc(dayLabel(i)) + '</text>';
      }

      chart = '<svg class="detail-chart-svg" viewBox="0 0 ' + W + ' ' + H + '">' + svg + '</svg>';
    }

    const avgSession = p.sessionCount > 0 ? fmtCost(p.costUSD / p.sessionCount) : '—';
    return (
      '<tr class="detail"><td colspan="5"><div class="detail-grid">' +
      '<div class="detail-col"><h3>Last 30 days</h3>' + chart + '</div>' +
      '<div class="detail-col"><h3>By model</h3><div class="dm">' + (modelRows || '<p class="empty">—</p>') + '</div></div>' +
      '<div class="detail-col"><h3>Stats</h3><div class="detail-stats">' +
      '<div><span>Sessions</span><b>' + (p.sessionCount || '–') + '</b></div>' +
      '<div><span>Avg / session</span><b>' + avgSession + '</b></div>' +
      '<div><span>Tokens</span><b>' + fmtTokens(p.totalTokens) + '</b></div>' +
      '<div><span>Last active</span><b>' + (p.lastActivityMs ? relTime(p.lastActivityMs) : '–') + '</b></div>' +
      '</div></div>' +
      '</div></td></tr>'
    );
  }

  function renderProjects(s) {
    const rows = s.byProject.slice(0, 12);
    const maxCost = rows.length ? rows[0].costUSD : 0;
    const more = s.byProject.length - rows.length;
    const roots = lastConfig.workspaceRoots || [];
    const isOpen = (p) =>
      roots.some((root) => p.projectPath === root || p.projectPath.indexOf(root + '/') === 0);
    document.getElementById('projects').innerHTML =
      '<div class="section-head"><h2>Projects</h2><span class="meta">' +
      (more > 0 ? 'top 12 of ' + s.byProject.length + ' · ' : '') + 'click a row for details</span></div>' +
      (rows.length
        ? '<table><tr><th>Project</th><th class="num">Tokens</th><th class="num">Cost</th><th class="sharecol"></th><th class="sparkcol">14d</th></tr>' +
          rows
            .map((p) => {
              const open = expandedProjects.has(p.projectPath);
              return (
                '<tr class="proj-row' + (open ? ' open' : '') + '" data-path="' + esc(p.projectPath) + '">' +
                '<td title="' + esc(p.projectPath) + '"><span class="chev">' + (open ? '▾' : '▸') + '</span> ' +
                esc(p.displayName) +
                (isOpen(p) ? ' <span class="pill ws-pill" title="Open in this VS Code window">open</span>' : '') +
                '</td>' +
                '<td class="num dim">' + fmtTokens(p.totalTokens) + '</td>' +
                '<td class="num">' + fmtCost(p.costUSD) + '</td>' +
                '<td class="sharecol"><div class="share"><div style="width:' +
                (maxCost > 0 ? Math.max((p.costUSD / maxCost) * 100, 1.5) : 0).toFixed(1) + '%"></div></div></td>' +
                '<td class="sparkcol">' + sparkSvg(p.spark || []) + '</td></tr>' +
                (open ? projectDetail(p) : '')
              );
            })
            .join('') +
          '</table>'
        : '<p class="empty">No projects yet.</p>');
  }

  /* ---------- models & sessions ---------- */

  function modelDetail(m) {
    const tb = m.breakdown || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const cb = m.costBreakdown || { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const classes = [
      ['Input', tb.input, cb.input, 'c-input'],
      ['Output', tb.output, cb.output, 'c-output'],
      ['Cache read', tb.cacheRead, cb.cacheRead, 'c-cread'],
      ['Cache write', tb.cacheWrite, cb.cacheWrite, 'c-cwrite'],
    ];
    const maxCost = Math.max.apply(null, classes.map((c) => c[2]));
    const rows = classes
      .map(
        ([name, tok, cost, cls]) =>
          '<div class="dm-row"><span class="dm-name"><i class="dot ' + cls + '"></i> ' + esc(name) + '</span>' +
          '<div class="share"><div style="width:' +
          (maxCost > 0 ? Math.max((cost / maxCost) * 100, 1.5) : 0).toFixed(1) + '%"></div></div>' +
          '<span class="dm-val">' + fmtTokens(tok) + ' <span class="dim">· ' + fmtCost(cost) + '</span></span></div>'
      )
      .join('');
    const avg = m.requestCount > 0 ? fmtCost(m.costUSD / m.requestCount) : '—';
    return (
      '<tr class="detail"><td colspan="5"><div class="detail-grid two-col">' +
      '<div class="detail-col"><h3>Token types · sized by cost</h3><div class="dm">' + rows + '</div></div>' +
      '<div class="detail-col"><h3>Stats</h3><div class="detail-stats">' +
      '<div><span>Requests</span><b>' + m.requestCount.toLocaleString() + '</b></div>' +
      '<div><span>Avg / request</span><b>' + avg + '</b></div>' +
      '<div><span>Tokens</span><b>' + fmtTokens(m.totalTokens) + '</b></div>' +
      '<div><span>Pricing</span><b>' + esc(m.pricingSource || 'bundled') + '</b></div>' +
      '</div></div>' +
      '</div></td></tr>'
    );
  }

  function renderModels(s) {
    const maxCost = s.byModel.length ? s.byModel[0].costUSD : 0;
    document.getElementById('models').innerHTML =
      '<div class="section-head"><h2>By Model</h2><span class="meta">click a row for token types</span></div>' +
      (s.byModel.length
        ? '<table><tr><th>Model</th><th class="num">Requests</th><th class="num">Tokens</th><th class="num">Cost</th><th class="sharecol"></th></tr>' +
          s.byModel
            .map((m) => {
              const open = expandedModels.has(m.model);
              return (
                '<tr class="model-row" data-model="' + esc(m.model) + '">' +
                '<td><span class="chev">' + (open ? '▾' : '▸') + '</span> ' +
                '<span class="pill">' + esc(modelShortName(m.model)) + '</span>' +
                (m.pricingSource === 'default'
                  ? ' <span class="warn-badge" title="No exact pricing known for ' + esc(m.model) +
                    ' — costs use the Sonnet-tier default. Add an override in Claudometer Settings.">⚠ est.</span>'
                  : '') +
                '</td>' +
                '<td class="num dim">' + m.requestCount.toLocaleString() + '</td>' +
                '<td class="num dim">' + fmtTokens(m.totalTokens) + '</td>' +
                '<td class="num">' + fmtCost(m.costUSD) + '</td>' +
                '<td class="sharecol"><div class="share"><div style="width:' +
                (maxCost > 0 ? Math.max((m.costUSD / maxCost) * 100, 1.5) : 0).toFixed(1) + '%"></div></div></td></tr>' +
                (open ? modelDetail(m) : '')
              );
            })
            .join('') +
          '</table>'
        : '<p class="empty">No model usage yet.</p>');
  }

  function renderTools(s) {
    const el = document.getElementById('tools');
    const tools = s.toolUsage || [];
    if (!tools.length) {
      el.innerHTML = '';
      return;
    }
    const total = tools.reduce((a, t) => a + t.count, 0);
    const max = tools[0].count;
    const rows = tools
      .slice(0, 12)
      .map(
        (t) =>
          '<div class="dm-row"><span class="dm-name" title="' + esc(t.name) + '">' + esc(t.name) + '</span>' +
          '<div class="share"><div style="width:' + Math.max((t.count / max) * 100, 1.5).toFixed(1) + '%"></div></div>' +
          '<span class="dm-val">' + t.count.toLocaleString() + '</span></div>'
      )
      .join('');
    el.innerHTML =
      '<div class="section-head"><h2>Tool Usage</h2><span class="meta">' +
      total.toLocaleString() + ' tool calls all time</span></div>' +
      '<div class="dm tools-list">' + rows + '</div>';
  }

  function renderSessions(s) {
    const rows = s.recentSessions.slice(0, 12);
    document.getElementById('sessions').innerHTML =
      '<div class="section-head"><h2>Recent Sessions</h2></div>' +
      (rows.length
        ? '<table><tr><th>Project</th><th>Model</th><th class="num">Tokens</th><th class="num">Cost</th><th class="num">When</th></tr>' +
          rows
            .map(
              (x) =>
                '<tr><td>' + esc(x.displayName) + '</td>' +
                '<td><span class="pill">' + esc(modelShortName(x.model)) + '</span></td>' +
                '<td class="num dim">' + fmtTokens(x.totalTokens) + '</td>' +
                '<td class="num">' + fmtCost(x.costUSD) + '</td>' +
                '<td class="num dim">' + relTime(x.timestampMs) + '</td></tr>'
            )
            .join('') +
          '</table>'
        : '<p class="empty">No sessions yet.</p>');
  }
})();

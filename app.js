/**
 * Fleet Voice Alerts — Add-In App Logic
 * Day 1: Scaffold, auth, config load/save, view/tab switching, session refresh
 *
 * Replace CONFIG_API_BASE with your deployed Cloud Function URL.
 */

// ─── Configuration ────────────────────────────────────────────────────────────
const CONFIG_API_BASE = 'https://us-central1-geotabvibecode2026.cloudfunctions.net'
const SESSION_REFRESH_INTERVAL_MS = 25 * 60 * 1000; // 25 minutes
const STATUS_POLL_INTERVAL_MS     = 10 * 1000;       // 10 seconds

// ─── Default config shape ─────────────────────────────────────────────────────
const DEFAULT_CONFIG = {
  language:           'en',
  twilioAccountSid:   '',
  twilioAuthToken:    '',  // masked on load after first save
  twilioFromNumber:   '',
  webhookBaseUrl:     '',
  // Geotab service account — used by backend Cloud Functions to call the
  // Geotab API independently (sessionId is not available to add-ins).
  geotabUser:         '',
  geotabPassword:     '',  // encrypted at rest, same as twilioAuthToken
  geotabServer:       '',  // e.g. my.geotab.com — auto-populated from URL
  exceptionRules:     [],  // [{ id, name, enabled, severity, cooldownMinutes }]
  escalationContacts: [],  // [{ name, phone, role, escalationDelayMinutes }]
  schedule: {
    enabled:   false,
    days:      [1, 2, 3, 4, 5],  // 0=Sun … 6=Sat
    startTime: '07:00',
    endTime:   '22:00',
    timezone:  Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Mexico_City'
  }
};

// ─── App state ────────────────────────────────────────────────────────────────
const FVA = {
  api:                  null,
  state:                null,
  dbName:               null,
  userName:             null,
  server:               null,
  sessionId:            null,
  config:               null,
  lang:                 'en',
  exceptionDefinitions: [],
  statusPollTimer:      null,
  sessionRefreshTimer:  null,
  _dirty:               false,   // unsaved changes flag
  logPage:              0,       // current page index for call log (0-based)
  LOG_PAGE_SIZE:        10,
  queuePage:            0,       // current page index for call queue (0-based)
  QUEUE_PAGE_SIZE:      5,
};

// ─── i18n helpers ─────────────────────────────────────────────────────────────
function t(key) {
  const strings = window.FVA_I18N?.[FVA.lang] || window.FVA_I18N?.en || {};
  return strings[key] ?? key;
}

function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    el.placeholder = t(el.getAttribute('data-i18n-placeholder'));
  });
}

// ─── Toast notifications ──────────────────────────────────────────────────────
function toast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('fva-toast-container');
  const icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };

  const el = document.createElement('div');
  el.className = `fva-toast ${type}`;
  el.innerHTML = `
    <span class="fva-toast-icon">${icons[type] || '•'}</span>
    <span class="fva-toast-msg">${message}</span>
  `;
  container.appendChild(el);

  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 220);
  }, duration);
}

// ─── Loading overlay ──────────────────────────────────────────────────────────
function showLoading(show) {
  document.getElementById('fva-loading').classList.toggle('hidden', !show);
}

// ─── View switching ───────────────────────────────────────────────────────────
function switchView(viewName) {
  document.querySelectorAll('.fva-view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.fva-nav-btn').forEach(b => b.classList.remove('active'));

  document.getElementById(`view-${viewName}`)?.classList.add('active');
  document.querySelector(`.fva-nav-btn[data-view="${viewName}"]`)?.classList.add('active');

  if (viewName === 'status') {
    loadStatus();
    startStatusPolling();
  } else {
    stopStatusPolling();
  }
}

function switchTab(tabName) {
  document.querySelectorAll('.fva-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.fva-panel').forEach(p => p.classList.remove('active'));

  document.querySelector(`.fva-tab[data-tab="${tabName}"]`)?.classList.add('active');
  document.getElementById(`tab-${tabName}`)?.classList.add('active');
}

// ─── Cloud Function API calls ─────────────────────────────────────────────────
async function apiFetch(path, options = {}) {
  const url = `${CONFIG_API_BASE}/${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json', ...options.headers },
    ...options
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

async function loadConfig() {
  const data = await apiFetch(`getConfig?db=${encodeURIComponent(FVA.dbName)}`);
  FVA.config = data.exists
    ? { ...DEFAULT_CONFIG, ...data.config }
    : { ...DEFAULT_CONFIG };
}

async function saveConfig(patch) {
  // Merge patch into FVA.config, then POST
  FVA.config = { ...FVA.config, ...patch };
  await apiFetch('saveConfig', {
    method: 'POST',
    body: JSON.stringify({ dbName: FVA.dbName, config: FVA.config })
  });
}

async function pushSession() {
  // Lightweight heartbeat — records that the add-in is active.
  // The backend poller authenticates using geotabUser/geotabPassword
  // from config, not a session token. api.getSession() only gives
  // us { userName, database } — no sessionId or server.
  try {
    const session = await new Promise((resolve) => {
      FVA.api.getSession(resolve);
    });
    await apiFetch('saveSession', {
      method: 'POST',
      body: JSON.stringify({
        dbName:   FVA.dbName,
        userName: session.userName || FVA.userName
      })
    });
    updateSessionIndicator('ok');
    document.getElementById('bar-last-poll').textContent =
      `Session active · ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    console.warn('Session push failed:', err);
    updateSessionIndicator('stale');
    toast(t('toast_session_error'), 'warning');
  }
}

function updateSessionIndicator(state) {
  const dot   = document.getElementById('session-dot');
  const barDot = document.getElementById('bar-session-dot');
  ['ok', 'stale', 'error'].forEach(s => {
    dot?.classList.toggle(s, s !== 'ok' && s === state);
    barDot?.classList.toggle(s, s !== 'ok' && s === state);
  });
}

// ─── Session refresh loop ─────────────────────────────────────────────────────
function startSessionRefresh() {
  pushSession(); // immediate
  FVA.sessionRefreshTimer = setInterval(pushSession, SESSION_REFRESH_INTERVAL_MS);
}

function stopSessionRefresh() {
  if (FVA.sessionRefreshTimer) {
    clearInterval(FVA.sessionRefreshTimer);
    FVA.sessionRefreshTimer = null;
  }
}

// ─── Geotab Exception Definitions ────────────────────────────────────────────
async function loadExceptionDefinitions() {
  // The correct Geotab API typeName for exception rule definitions is 'Rule'.
  // 'ExceptionRuleBase' and 'ExceptionRule' are SDK class hierarchy names —
  // they do not exist in the API type registry and throw MissingMethodException.
  try {
    const results = await new Promise((resolve, reject) => {
      FVA.api.call('Get', {
        typeName:     'Rule',
        resultsLimit: 1000
      }, resolve, reject);
    });
    FVA.exceptionDefinitions = (results || []).sort((a, b) =>
      (a.name || '').localeCompare(b.name || '')
    );
    console.log(`Loaded ${FVA.exceptionDefinitions.length} exception rules`);
  } catch (err) {
    console.warn('Could not load exception definitions:', err);
    FVA.exceptionDefinitions = [];
    const tbody = document.getElementById('rules-tbody');
    if (tbody) {
      tbody.innerHTML = `<tr><td colspan="4" class="fva-table-empty" style="color:var(--danger);">
        Failed to load rules: ${err.message || err}
      </td></tr>`;
    }
  }
}

// ─── Render: Twilio tab ───────────────────────────────────────────────────────
function renderTwilioTab() {
  const c = FVA.config;
  document.getElementById('twilio-sid').value   = c.twilioAccountSid || '';
  const tokenEl = document.getElementById('twilio-token');
  tokenEl.value = '';
  tokenEl.placeholder = c.twilioAuthToken
    ? t('twilio_token_placeholder')
    : '';
  document.getElementById('twilio-from').value   = c.twilioFromNumber  || '';
  document.getElementById('webhook-base').value  = c.webhookBaseUrl    || '';

  // Geotab service account
  document.getElementById('geotab-user').value = c.geotabUser || '';

  // Password: always clear the field value and show a placeholder when a
  // password is already saved. Never pre-fill with the masked value — that
  // would send the placeholder back to saveConfig on the next Save click.
  const geotabPwEl = document.getElementById('geotab-password');
  geotabPwEl.value = '';
  geotabPwEl.placeholder = c.geotabPassword
    ? t('password_saved_placeholder')
    : t('password_empty_placeholder');

  const serverEl = document.getElementById('geotab-server');
  serverEl.value = c.geotabServer || 'my.geotab.com';
}

// Bullet character used by the backend as a masked-value sentinel
const MASKED_CHAR = '\u2022'; // •

/** True if a string is empty, whitespace-only, or the masked placeholder */
function looksLikeMasked(value) {
  if (!value) return true;
  return value.split('').every(ch => ch === MASKED_CHAR || ch === ' ');
}

function collectTwilioValues() {
  const rawToken    = document.getElementById('twilio-token').value.trim();
  const rawPassword = document.getElementById('geotab-password').value.trim();
  return {
    twilioAccountSid: document.getElementById('twilio-sid').value.trim(),
    // Send undefined when empty or masked — backend will preserve existing value
    twilioAuthToken:  looksLikeMasked(rawToken)    ? undefined : rawToken,
    twilioFromNumber: document.getElementById('twilio-from').value.trim(),
    webhookBaseUrl:   document.getElementById('webhook-base').value.trim(),
    geotabUser:       document.getElementById('geotab-user').value.trim(),
    geotabPassword:   looksLikeMasked(rawPassword) ? undefined : rawPassword,
    geotabServer:     document.getElementById('geotab-server').value.trim()
  };
}

// ─── Render: Exception Rules tab ─────────────────────────────────────────────
function renderRulesTab(filter = '') {
  const tbody = document.getElementById('rules-tbody');

  if (!FVA.exceptionDefinitions.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="fva-table-empty">${t('rules_loading')}</td></tr>`;
    return;
  }

  // Build a lookup: existing config rules by Geotab exception id
  const configMap = {};
  (FVA.config.exceptionRules || []).forEach(r => { configMap[r.id] = r; });

  const defs = FVA.exceptionDefinitions.filter(d =>
    !filter || d.name.toLowerCase().includes(filter.toLowerCase())
  );

  if (!defs.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="fva-table-empty">${t('rules_empty')}</td></tr>`;
    return;
  }

  tbody.innerHTML = defs.map(def => {
    const rule = configMap[def.id] || {
      id: def.id, name: def.name, enabled: false, severity: 'medium', cooldownMinutes: 30
    };

    return `
      <tr data-rule-id="${def.id}">
        <td>
          <label class="fva-toggle">
            <input type="checkbox" class="rule-enabled" data-id="${def.id}" ${rule.enabled ? 'checked' : ''} />
            <span class="fva-toggle-slider"></span>
          </label>
        </td>
        <td style="font-weight:500;">${def.name}</td>
        <td>
          <select class="fva-select rule-severity" data-id="${def.id}" style="width:auto;padding:4px 28px 4px 8px;">
            <option value="high"   ${rule.severity === 'high'   ? 'selected' : ''}>${t('rules_severity_high')}</option>
            <option value="medium" ${rule.severity === 'medium' ? 'selected' : ''}>${t('rules_severity_medium')}</option>
            <option value="low"    ${rule.severity === 'low'    ? 'selected' : ''}>${t('rules_severity_low')}</option>
          </select>
        </td>
        <td>
          <input
            type="number"
            class="fva-input rule-cooldown"
            data-id="${def.id}"
            value="${rule.cooldownMinutes ?? 30}"
            min="1" max="1440"
            style="width:80px;"
            title="Minutes before this vehicle+rule can trigger another call"
          />
        </td>
      </tr>
    `;
  }).join('');
}

function collectRulesValues() {
  const rules = [];
  document.querySelectorAll('#rules-tbody tr[data-rule-id]').forEach(row => {
    const id = row.getAttribute('data-rule-id');
    const def = FVA.exceptionDefinitions.find(d => d.id === id);
    rules.push({
      id,
      name:            def?.name || id,
      enabled:         row.querySelector('.rule-enabled')?.checked || false,
      severity:        row.querySelector('.rule-severity')?.value  || 'medium',
      cooldownMinutes: parseInt(row.querySelector('.rule-cooldown')?.value || '30', 10)
    });
  });
  // Only persist enabled rules + any others already in config
  return rules;
}

// ─── Render: Escalation Contacts tab ─────────────────────────────────────────
function renderContactsTab() {
  const list = document.getElementById('contacts-list');
  const contacts = FVA.config.escalationContacts || [];

  if (!contacts.length) {
    list.innerHTML = `<p style="color:var(--muted);font-size:13px;padding:8px 0;">${t('contacts_desc')}</p>`;
    return;
  }

  list.innerHTML = contacts.map((c, idx) => `
    <div class="fva-contact-row" data-idx="${idx}" draggable="true">
      <span class="fva-contact-order">${idx + 1}</span>
      <input class="fva-input contact-name"  value="${c.name  || ''}" placeholder="${t('contacts_placeholder_name')}"  data-idx="${idx}" />
      <input class="fva-input contact-phone" value="${c.phone || ''}" placeholder="${t('contacts_placeholder_phone')}" data-idx="${idx}" type="tel" />
      <input class="fva-input contact-role"  value="${c.role  || ''}" placeholder="${t('contacts_placeholder_role')}"  data-idx="${idx}" />
      <input class="fva-input contact-delay" value="${c.escalationDelayMinutes ?? 5}" type="number" min="1" max="60" data-idx="${idx}" title="${t('contacts_col_delay')}" />
      <button class="fva-btn danger sm contact-remove" data-idx="${idx}">✕</button>
    </div>
  `).join('');

  // Remove buttons
  list.querySelectorAll('.contact-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-idx'), 10);
      FVA.config.escalationContacts.splice(idx, 1);
      renderContactsTab();
    });
  });

  // Simple drag-and-drop reorder
  setupContactsDrag();
}

function setupContactsDrag() {
  const list = document.getElementById('contacts-list');
  let dragSrc = null;

  list.querySelectorAll('.fva-contact-row').forEach(row => {
    row.addEventListener('dragstart', () => { dragSrc = row; row.style.opacity = '0.5'; });
    row.addEventListener('dragend',   () => { row.style.opacity = ''; });
    row.addEventListener('dragover',  e => e.preventDefault());
    row.addEventListener('drop', () => {
      if (dragSrc && dragSrc !== row) {
        const allRows = [...list.querySelectorAll('.fva-contact-row')];
        const srcIdx  = parseInt(dragSrc.getAttribute('data-idx'), 10);
        const dstIdx  = parseInt(row.getAttribute('data-idx'), 10);
        const contacts = FVA.config.escalationContacts;
        const [moved] = contacts.splice(srcIdx, 1);
        contacts.splice(dstIdx, 0, moved);
        renderContactsTab();
      }
    });
  });
}

function addContact() {
  if (!FVA.config.escalationContacts) FVA.config.escalationContacts = [];
  FVA.config.escalationContacts.push({
    name: '', phone: '', role: '', escalationDelayMinutes: 5
  });
  renderContactsTab();
}

function collectContactsValues() {
  const contacts = [];
  document.querySelectorAll('.fva-contact-row').forEach(row => {
    contacts.push({
      name:                    row.querySelector('.contact-name')?.value.trim()  || '',
      phone:                   row.querySelector('.contact-phone')?.value.trim() || '',
      role:                    row.querySelector('.contact-role')?.value.trim()  || '',
      escalationDelayMinutes:  parseInt(row.querySelector('.contact-delay')?.value || '5', 10)
    });
  });
  return contacts.filter(c => c.name || c.phone);
}

// ─── Render: Schedule tab ─────────────────────────────────────────────────────
function renderScheduleTab() {
  const s = FVA.config.schedule || DEFAULT_CONFIG.schedule;

  const enabledEl = document.getElementById('schedule-enabled');
  const configEl  = document.getElementById('schedule-config');
  enabledEl.checked = s.enabled;
  configEl.style.display = s.enabled ? 'block' : 'none';

  enabledEl.onchange = () => {
    configEl.style.display = enabledEl.checked ? 'block' : 'none';
  };

  // Days
  const dayNames = t('schedule_days_list');
  const grid = document.getElementById('days-grid');
  grid.innerHTML = dayNames.map((name, i) => `
    <button class="fva-day-btn ${s.days?.includes(i) ? 'active' : ''}" data-day="${i}">${name}</button>
  `).join('');

  grid.querySelectorAll('.fva-day-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('active'));
  });

  document.getElementById('schedule-start').value = s.startTime || '07:00';
  document.getElementById('schedule-end').value   = s.endTime   || '22:00';

  // Populate timezone select
  const tzSelect = document.getElementById('schedule-tz');
  const commonTimezones = [
    'America/Mexico_City', 'America/Monterrey', 'America/Bogota',
    'America/Lima', 'America/Sao_Paulo', 'America/Buenos_Aires',
    'America/Santiago', 'America/New_York', 'America/Chicago',
    'America/Los_Angeles', 'Europe/Madrid', 'UTC'
  ];
  tzSelect.innerHTML = commonTimezones.map(tz =>
    `<option value="${tz}" ${s.timezone === tz ? 'selected' : ''}>${tz}</option>`
  ).join('');
}

function collectScheduleValues() {
  const activeDays = [...document.querySelectorAll('.fva-day-btn.active')]
    .map(btn => parseInt(btn.getAttribute('data-day'), 10));

  return {
    schedule: {
      enabled:   document.getElementById('schedule-enabled').checked,
      days:      activeDays,
      startTime: document.getElementById('schedule-start').value,
      endTime:   document.getElementById('schedule-end').value,
      timezone:  document.getElementById('schedule-tz').value
    }
  };
}

// ─── Render: Language tab ─────────────────────────────────────────────────────
function renderLanguageTab() {
  document.querySelectorAll('.fva-lang-option').forEach(opt => {
    opt.classList.toggle('selected', opt.getAttribute('data-lang') === FVA.lang);
  });
}

function getSelectedLanguage() {
  return document.querySelector('.fva-lang-option.selected')?.getAttribute('data-lang') || 'en';
}

// ─── Status view ──────────────────────────────────────────────────────────────
// ─── Log pagination ───────────────────────────────────────────────────────────
function renderLogPagination(currentPage, totalPages) {
  let el = document.getElementById('log-pagination');
  if (!el) {
    const section = document.querySelector('.fva-status-section-full');
    if (!section) return;
    el = document.createElement('div');
    el.id = 'log-pagination';
    el.className = 'fva-pagination';
    section.appendChild(el);
  }

  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const prevDisabled = currentPage === 0 ? 'disabled' : '';
  const nextDisabled = currentPage >= totalPages - 1 ? 'disabled' : '';

  el.innerHTML = `
    <button class="fva-btn secondary sm" id="log-prev" ${prevDisabled}>‹ Prev</button>
    <span class="fva-pagination-info">Page ${currentPage + 1} of ${totalPages}</span>
    <button class="fva-btn secondary sm" id="log-next" ${nextDisabled}>Next ›</button>
  `;

  document.getElementById('log-prev')?.addEventListener('click', () => {
    if (FVA.logPage > 0) { FVA.logPage--; loadStatus(); }
  });
  document.getElementById('log-next')?.addEventListener('click', () => {
    FVA.logPage++; loadStatus();
  });
}

// ─── Queue pagination ──────────────────────────────────────────────────────────
function renderQueuePagination(currentPage, totalPages) {
  const el = document.getElementById('queue-pagination');
  if (!el) return;

  if (totalPages <= 1) { el.innerHTML = ''; return; }

  const prevDisabled = currentPage === 0 ? 'disabled' : '';
  const nextDisabled = currentPage >= totalPages - 1 ? 'disabled' : '';

  el.innerHTML = `
    <button class="fva-btn secondary sm" id="queue-prev" ${prevDisabled}>‹ Prev</button>
    <span class="fva-pagination-info">Page ${currentPage + 1} of ${totalPages}</span>
    <button class="fva-btn secondary sm" id="queue-next" ${nextDisabled}>Next ›</button>
  `;

  document.getElementById('queue-prev')?.addEventListener('click', () => {
    if (FVA.queuePage > 0) { FVA.queuePage--; loadStatus(); }
  });
  document.getElementById('queue-next')?.addEventListener('click', () => {
    FVA.queuePage++; loadStatus();
  });
}

async function loadStatus() {
  try {
    const data = await apiFetch(`getStatus?db=${encodeURIComponent(FVA.dbName)}`);
    renderStatus(data);
  } catch (err) {
    console.warn('Status load failed:', err);
    // Status view will show cached/empty state — not fatal
  }
}

function renderStatus(data = {}) {
  const calls = data.calls || [];
  const stats = data.stats || {};

  // ── KPI Cards ────────────────────────────────────────────────────────────────
  document.getElementById('kpi-today').textContent       = stats.todayTotal          ?? '0';
  document.getElementById('kpi-active').textContent      = stats.activeNow           ?? '0';
  document.getElementById('kpi-escalations').textContent = stats.escalations         ?? '0';
  document.getElementById('kpi-avg-dur').textContent     = formatDuration(stats.avgDurationSeconds);

  // Sub-labels
  const todaySub = document.getElementById('kpi-today-sub');
  if (todaySub) todaySub.textContent = stats.acknowledged
    ? `${stats.acknowledged} ${t('kpi_acknowledged')}`
    : '';

  const activeSub = document.getElementById('kpi-active-sub');
  const dialingCount = calls.filter(c => c.status === 'dialing').length;
  if (activeSub) activeSub.textContent = dialingCount > 0
    ? `${dialingCount} ${t('kpi_dialing_now')}`
    : '';

  const escSub = document.getElementById('kpi-esc-sub');
  if (escSub) escSub.textContent = stats.smsFallbacks > 0
    ? `${stats.smsFallbacks} ${t('kpi_sms_fallbacks')}`
    : '';

  const durSub = document.getElementById('kpi-dur-sub');
  if (durSub) durSub.textContent = stats.avgDurationSeconds != null
    ? `${t('kpi_of_total')} ${stats.todayTotal}`
    : '';

  // ── Bucket calls by status ────────────────────────────────────────────────
  const LIVE  = ['active', 'dialing'];
  const QUEUE = ['queued', 'scheduled', 'hold'];
  const LOG   = ['completed', 'escalated', 'no-answer', 'escalation-exhausted', 'dismissed'];

  const active    = calls.filter(c => LIVE.includes(c.status));
  const queued    = calls.filter(c => QUEUE.includes(c.status));
  const completed = calls.filter(c => LOG.includes(c.status));

  document.getElementById('active-count').textContent = active.length;
  document.getElementById('queue-count').textContent  = queued.length;
  document.getElementById('log-count').textContent    = completed.length;

  // ── Active Calls ──────────────────────────────────────────────────────────
  const activeTbody = document.getElementById('active-tbody');
  activeTbody.innerHTML = active.length
    ? active.map(c => {
        const chainLabel = c.totalContacts > 1
          ? `<br><small style="color:var(--muted);font-size:11px;">${
              t('status_contact_of')
                .replace('{n}',     (c.contactIndex ?? 0) + 1)
                .replace('{total}', c.totalContacts)
            }</small>`
          : '';
        const isDialing = c.status === 'dialing';
        return `<tr>
          <td>
            <span class="fva-live-dot${isDialing ? ' dialing' : ''}"></span>
            ${esc(c.vehicleName || c.vehicleId)}
            ${c.ruleSeverity ? `<br><small class="fva-severity-tag ${c.ruleSeverity}">${esc(c.ruleSeverity)}</small>` : ''}
          </td>
          <td>${esc(c.exceptionName)}</td>
          <td>${esc(c.currentContactName || '—')}${chainLabel}</td>
          <td>${isDialing ? `<span class="fva-status-badge dialing">${t('badge_dialing')}</span>` : formatElapsed(c.startedAt)}</td>
          <td>
            <button class="fva-btn danger sm" onclick="dismissCall('${c.id}')">${t('btn_dismiss')}</button>
          </td>
        </tr>`;
      }).join('')
    : `<tr><td colspan="5" class="fva-table-empty">${t('status_empty_active')}</td></tr>`;

  // ── Call Queue ────────────────────────────────────────────────────────────
  const queueTbody = document.getElementById('queue-tbody');
  if (!queued.length) {
    queueTbody.innerHTML = `<tr><td colspan="5" class="fva-table-empty">${t('status_empty_queue')}</td></tr>`;
    renderQueuePagination(0, 0);
  } else {
    const qPageSize   = FVA.QUEUE_PAGE_SIZE;
    const qTotalPages = Math.ceil(queued.length / qPageSize);
    if (FVA.queuePage >= qTotalPages) FVA.queuePage = qTotalPages - 1;
    const queueSlice  = queued.slice(FVA.queuePage * qPageSize, (FVA.queuePage + 1) * qPageSize);
    queueTbody.innerHTML = queueSlice.map(c => {
        const holdInfo = c.holdNote
          ? `<br><small style="color:var(--warning);font-size:11px;">⏸ ${esc(c.holdNote)}</small>`
          : '';
        const badgeKey = c.status === 'scheduled' ? 'badge_scheduled'
                       : c.status === 'hold'       ? 'badge_hold'
                       : 'badge_queued';
        return `<tr>
          <td>${esc(c.vehicleName || c.vehicleId)}</td>
          <td>${esc(c.exceptionName)}${holdInfo}</td>
          <td><span class="fva-status-badge ${c.status}">${t(badgeKey)}</span></td>
          <td>${c.createdAt ? (() => { const d = new Date(c.createdAt); return d.toLocaleDateString([], {day:'numeric',month:'short'}) + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); })() : '—'}</td>
          <td>
            <button class="fva-btn ghost sm" onclick="dismissCall('${c.id}')">${t('btn_dismiss')}</button>
          </td>
        </tr>`;
      }).join('');
    renderQueuePagination(FVA.queuePage, qTotalPages);
  }

  // ── Call Log ──────────────────────────────────────────────────────────────
  const logTbody = document.getElementById('log-tbody');
  if (!completed.length) {
    logTbody.innerHTML = `<tr><td colspan="8" class="fva-table-empty">${t('status_empty_log')}</td></tr>`;
    renderLogPagination(0, 0);
  } else {
    // Paginate — keep FVA.logPage in range
    const pageSize  = FVA.LOG_PAGE_SIZE;
    const totalPages = Math.ceil(completed.length / pageSize);
    if (FVA.logPage >= totalPages) FVA.logPage = totalPages - 1;
    const pageSlice = completed.slice(FVA.logPage * pageSize, (FVA.logPage + 1) * pageSize);

    logTbody.innerHTML = pageSlice.map(c => {
      const statusKey = {
        completed:            'badge_completed',
        escalated:            'badge_escalated',
        'no-answer':          'badge_no_answer',
        'escalation-exhausted':'badge_escalation_exhausted',
        dismissed:            'badge_dismissed',
      }[c.status] || ('badge_' + c.status.replace(/-/g, '_'));

      const smsBadge = c.smsFallbackSent
        ? `<span class="fva-sms-badge" title="${t('status_sms_sent').replace('{phone}', c.smsFallbackTo || '')}">📱 SMS</span>`
        : '';

      const canRetry   = ['no-answer', 'failed', 'escalated', 'escalation-exhausted'].includes(c.status);
      const canDismiss = ['no-answer', 'failed', 'escalated', 'escalation-exhausted'].includes(c.status);

      return `<tr class="fva-log-row" data-call-id="${c.id}">
        <td>${esc(c.vehicleName || c.vehicleId)}</td>
        <td>${esc(c.exceptionName)}</td>
        <td>${esc(c.currentContactName || '—')}</td>
        <td>
          <span class="fva-status-badge ${c.status.replace(/-/g, '_')}">${t(statusKey)}</span>
          ${smsBadge}
        </td>
        <td>${c.startedAt ? new Date(c.startedAt).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : (c.createdAt ? (() => { const d = new Date(c.createdAt); return d.toLocaleDateString([], {day:'numeric',month:'short'}) + ' ' + d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); })() : '—')}</td>
        <td>${formatDuration(c.durationSeconds)}</td>
        <td style="white-space:nowrap">
          ${canRetry   ? `<button class="fva-btn secondary sm" onclick="retryCall('${c.id}')" title="Re-queue from contact 1">${t('btn_retry')}</button> ` : ''}
          ${canDismiss ? `<button class="fva-btn ghost sm"     onclick="dismissCall('${c.id}')">${t('btn_dismiss')}</button>` : ''}
        </td>
        <td>
          <button class="fva-btn ghost sm transcript-btn" data-call-id="${c.id}">${t('status_transcript')}</button>
        </td>
      </tr>
      <tr class="fva-transcript-row hidden" id="transcript-${c.id}">
        <td colspan="8">
          <div class="fva-transcript-panel" id="transcript-panel-${c.id}">
            <span class="fva-transcript-loading">${t('status_transcript_loading')}</span>
          </div>
        </td>
      </tr>`;
    }).join('');

    renderLogPagination(FVA.logPage, totalPages);

    // Wire transcript toggle buttons
    logTbody.querySelectorAll('.transcript-btn').forEach(btn => {
      btn.addEventListener('click', () => toggleTranscript(btn.getAttribute('data-call-id'), btn));
    });

    // Re-open any transcripts that were open before this re-render
    restoreOpenTranscripts();
  }

  // Last updated indicator
  const lastUpdated = document.getElementById('bar-last-poll');
  if (lastUpdated) {
    lastUpdated.textContent = t('status_last_updated').replace('{time}', new Date().toLocaleTimeString());
  }
}

// ─── Transcript expand / collapse ────────────────────────────────────────────
// Transcript rows are hidden by default. On first open we fetch from
// getConversation and render. Subsequent toggles just show/hide — no re-fetch.

const _transcriptLoaded = new Set(); // callIds already fetched from backend
const _transcriptOpen   = new Set(); // callIds currently visible

async function toggleTranscript(callId, btn) {
  const row   = document.getElementById(`transcript-${callId}`);
  const panel = document.getElementById(`transcript-panel-${callId}`);
  if (!row || !panel) return;

  const isOpen = !row.classList.contains('hidden');
  if (isOpen) {
    row.classList.add('hidden');
    btn.textContent = t('status_transcript');
    _transcriptOpen.delete(callId);
    return;
  }

  // Open
  row.classList.remove('hidden');
  btn.textContent = t('status_transcript_hide');
  _transcriptOpen.add(callId);

  if (_transcriptLoaded.has(callId)) return; // already loaded

  try {
    const data = await apiFetch(`getConversation?callId=${encodeURIComponent(callId)}`);
    renderTranscript(panel, data.conversation || [], data.script || '');
    _transcriptLoaded.add(callId);
  } catch (err) {
    panel.innerHTML = `<span style="color:var(--danger);font-size:12px;">Failed to load: ${esc(err.message)}</span>`;
  }
}

/**
 * After re-rendering the log table, re-open any transcripts that were open.
 * Called at the end of renderStatus() after wiring transcript buttons.
 */
async function restoreOpenTranscripts() {
  for (const callId of _transcriptOpen) {
    const row = document.getElementById(`transcript-${callId}`);
    const btn = document.querySelector(`.transcript-btn[data-call-id="${callId}"]`);
    if (!row) continue; // call scrolled off current page — skip
    row.classList.remove('hidden');
    if (btn) btn.textContent = t('status_transcript_hide');
    if (!_transcriptLoaded.has(callId)) {
      try {
        const panel = document.getElementById(`transcript-panel-${callId}`);
        const data  = await apiFetch(`getConversation?callId=${encodeURIComponent(callId)}`);
        renderTranscript(panel, data.conversation || [], data.script || '');
        _transcriptLoaded.add(callId);
      } catch (err) { /* non-fatal */ }
    }
  }
}

function renderTranscript(panel, turns, script) {
  if (!turns.length && !script) {
    panel.innerHTML = `<p class="fva-transcript-empty">${t('status_no_transcript')}</p>`;
    return;
  }

  // Speaker label lookup
  const speakerLabel = {
    system:               t('transcript_speaker_system'),
    supervisor:           t('transcript_speaker_supervisor'),
    ace:                  t('transcript_speaker_ace'),
    'supervisor-question': t('transcript_speaker_supervisor_question'),
  };

  // Speaker CSS modifier
  const speakerClass = {
    system:               'system',
    supervisor:           'supervisor',
    ace:                  'ace',
    'supervisor-question': 'supervisor',
  };

  const rows = turns.map(turn => {
    const speaker = turn.role || turn.speaker || 'system';
    const label   = speakerLabel[speaker] || speaker;
    const cls     = speakerClass[speaker] || 'system';
    const ts      = turn.timestamp
      ? new Date(turn.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      : '';
    return `<div class="fva-transcript-turn ${cls}">
      <span class="speaker">${esc(label)}</span>
      ${ts ? `<span class="fva-transcript-ts">${ts}</span>` : ''}
      <span class="text">${esc(turn.text || turn.message || '')}</span>
    </div>`;
  }).join('');

  panel.innerHTML = `<div class="fva-transcript">${rows}</div>`;
}

async function retryCall(callId) {
  try {
    await apiFetch('retryCall', {
      method: 'POST',
      body: JSON.stringify({ callId, dbName: FVA.dbName })
    });
    toast(t('toast_saved'), 'success');
    loadStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function dismissCall(callId) {
  try {
    await apiFetch('dismissCall', {
      method: 'POST',
      body: JSON.stringify({ callId, dbName: FVA.dbName })
    });
    loadStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function startStatusPolling() {
  stopStatusPolling();
  FVA.statusPollTimer = setInterval(loadStatus, STATUS_POLL_INTERVAL_MS);
}

function stopStatusPolling() {
  if (FVA.statusPollTimer) {
    clearInterval(FVA.statusPollTimer);
    FVA.statusPollTimer = null;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function formatDuration(seconds) {
  if (!seconds && seconds !== 0) return '—';
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function formatElapsed(startedAt) {
  if (!startedAt) return '—';
  const elapsed = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
  return formatDuration(elapsed);
}

// ─── Save handlers ────────────────────────────────────────────────────────────
async function handleSaveTwilio() {
  const btn = document.getElementById('btn-save-twilio');
  btn.textContent = t('btn_saving');
  btn.disabled = true;
  try {
    await saveConfig(collectTwilioValues());
    toast(t('toast_saved'), 'success');
    renderTwilioTab(); // refresh to show masked token
  } catch (err) {
    toast(t('toast_save_error'), 'error');
    console.error(err);
  } finally {
    btn.textContent = t('btn_save');
    btn.disabled = false;
  }
}

async function handleTestTwilio() {
  const resultEl = document.getElementById('twilio-test-result');
  resultEl.style.color = 'var(--muted)';
  resultEl.textContent = 'Testing…';
  try {
    await apiFetch('testTwilio', {
      method: 'POST',
      body: JSON.stringify({ dbName: FVA.dbName })
    });
    resultEl.style.color = 'var(--success)';
    resultEl.textContent = t('toast_connected');
  } catch (err) {
    resultEl.style.color = 'var(--danger)';
    resultEl.textContent = err.message || t('toast_connect_error');
  }
}

async function handleSaveRules() {
  const btn = document.getElementById('btn-save-rules');
  btn.disabled = true;
  try {
    await saveConfig({ exceptionRules: collectRulesValues() });
    toast(t('toast_saved'), 'success');
  } catch (err) {
    toast(t('toast_save_error'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleSaveContacts() {
  const btn = document.getElementById('btn-save-contacts');
  btn.disabled = true;
  try {
    await saveConfig({ escalationContacts: collectContactsValues() });
    toast(t('toast_saved'), 'success');
  } catch (err) {
    toast(t('toast_save_error'), 'error');
  } finally {
    btn.disabled = false;
  }
}

async function handleSaveSchedule() {
  try {
    await saveConfig(collectScheduleValues());
    toast(t('toast_saved'), 'success');
  } catch (err) {
    toast(t('toast_save_error'), 'error');
  }
}

async function handleSaveLanguage() {
  const lang = getSelectedLanguage();
  try {
    await saveConfig({ language: lang });
    FVA.lang = lang;
    applyI18n();
    renderAllSetupTabs();
    toast(t('toast_saved'), 'success');
  } catch (err) {
    toast(t('toast_save_error'), 'error');
  }
}

// ─── Wire event listeners ─────────────────────────────────────────────────────
function wireEventListeners() {
  // Nav
  document.querySelectorAll('.fva-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.getAttribute('data-view')));
  });

  // Setup tabs
  document.querySelectorAll('.fva-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.getAttribute('data-tab')));
  });

  // Save buttons
  document.getElementById('btn-save-twilio')?.addEventListener('click', handleSaveTwilio);
  document.getElementById('btn-test-twilio')?.addEventListener('click', handleTestTwilio);
  document.getElementById('btn-save-rules')?.addEventListener('click', handleSaveRules);
  document.getElementById('btn-save-contacts')?.addEventListener('click', handleSaveContacts);
  document.getElementById('btn-add-contact')?.addEventListener('click', () => {
    addContact(); 
  });
  document.getElementById('btn-save-schedule')?.addEventListener('click', handleSaveSchedule);
  document.getElementById('btn-save-language')?.addEventListener('click', handleSaveLanguage);

  // Language options
  document.querySelectorAll('.fva-lang-option').forEach(opt => {
    opt.addEventListener('click', () => {
      document.querySelectorAll('.fva-lang-option').forEach(o => o.classList.remove('selected'));
      opt.classList.add('selected');
    });
  });

  // Rules search
  document.getElementById('rules-search')?.addEventListener('input', e => {
    renderRulesTab(e.target.value);
  });

  // Status refresh
  document.getElementById('btn-refresh-status')?.addEventListener('click', () => {
    FVA.logPage = 0;
  FVA.queuePage = 0;
    loadStatus();
  });
}

// ─── Render all setup tabs (after language change) ────────────────────────────
function renderAllSetupTabs() {
  renderTwilioTab();
  renderRulesTab();
  renderContactsTab();
  renderScheduleTab();
  renderLanguageTab();
}

// ─── Header info ──────────────────────────────────────────────────────────────
function updateHeaderInfo() {
  const dbBadge = document.getElementById('db-badge');
  if (dbBadge) dbBadge.innerHTML = `<span>${FVA.dbName}</span>`;

  const barDb = document.getElementById('bar-db-name');
  if (barDb) barDb.textContent = `${t('db_label')}: ${FVA.dbName} · ${t('user_label')}: ${FVA.userName}`;
}

// ─── Initialization ───────────────────────────────────────────────────────────
async function initialize(api, state, callback) {
  FVA.api   = api;
  FVA.state = state;

  showLoading(true);

  try {
    // 1. Get Geotab session
    // api.getSession(callback) — single callback only.
    // Returns: { userName, database }
    // Does NOT return: sessionId, server — those are unavailable from the add-in.
    const session = await new Promise((resolve) => {
      api.getSession(resolve);
    });
    FVA.dbName   = session.database;
    FVA.userName = session.userName;
    // FVA.server not used — geotabServer is entered directly by the user in Setup

    // 2. Load config from Cloud Functions / Firestore
    await loadConfig();
    FVA.lang = FVA.config.language || 'en';

    // 3. Apply translations
    applyI18n();

    // 4. Update header
    updateHeaderInfo();

    // 5. Load Geotab exception definitions (for rules tab)
    await loadExceptionDefinitions();

    // 6. Render all panels
    renderAllSetupTabs();

    // 7. Wire event listeners
    wireEventListeners();

    // 8. Start session refresh loop
    startSessionRefresh();

    showLoading(false);
    callback();
  } catch (err) {
    console.error('FleetVoiceAlerts init error:', err);
    showLoading(false);
    document.getElementById('fva-app').innerHTML = `
      <div class="fva-error-state">
        <div class="icon">⚠</div>
        <h3>${t('error_init')}</h3>
        <p>${err.message}</p>
        <p style="margin-top:8px;font-size:12px;font-family:var(--mono);color:var(--muted);">
          Check that CONFIG_API_BASE is set correctly in app.js and Cloud Functions are deployed.
        </p>
      </div>
    `;
    callback();
  }
}

function onFocus(api, state) {
  FVA.api   = api;
  FVA.state = state;
  // Re-render rules tab if exception definitions loaded after blur
  if (FVA.exceptionDefinitions.length) renderRulesTab();
}

function onBlur() {
  stopStatusPolling();
}

// ─── Geotab Add-In Entry Point ────────────────────────────────────────────────
// eslint-disable-next-line no-undef
geotab.addin.FleetVoiceAlerts = function (api, state) {
  return {
    initialize(freshApi, freshState, callback) {
      initialize(freshApi, freshState, callback);
    },
    focus(freshApi, freshState) {
      onFocus(freshApi, freshState);
    },
    blur() {
      onBlur();
    }
  };
};
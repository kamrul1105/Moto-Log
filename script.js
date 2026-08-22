'use strict';

/* =========================================================
   Storage
   ========================================================= */
const STORAGE_KEY = 'motolog.v2';
const LEGACY_STORAGE_KEY = 'motolog.v1';

function emptyProfileData() {
  return { fuel: [], oil: [] };
}

function createInitialState(name) {
  const id = uid();
  return {
    profiles: [{ id, name: name || 'My Motorcycle', createdAt: todayISO() }],
    activeProfileId: id,
    data: { [id]: emptyProfileData() },
  };
}

function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed.profiles) && parsed.profiles.length && parsed.data) {
        parsed.profiles.forEach(p => {
          if (!parsed.data[p.id]) parsed.data[p.id] = emptyProfileData();
          const d = parsed.data[p.id];
          if (!Array.isArray(d.fuel)) d.fuel = [];
          if (!Array.isArray(d.oil)) d.oil = [];
        });
        if (!parsed.activeProfileId || !parsed.profiles.some(p => p.id === parsed.activeProfileId)) {
          parsed.activeProfileId = parsed.profiles[0].id;
        }
        return parsed;
      }
    }

    // Migrate legacy single-profile data (pre-profiles version) if present.
    const legacyRaw = localStorage.getItem(LEGACY_STORAGE_KEY);
    if (legacyRaw) {
      const legacy = JSON.parse(legacyRaw);
      const fresh = createInitialState('My Motorcycle');
      const id = fresh.activeProfileId;
      fresh.data[id].fuel = Array.isArray(legacy.fuel) ? legacy.fuel : [];
      fresh.data[id].oil = Array.isArray(legacy.oil) ? legacy.oil : [];
      return fresh;
    }

    return createInitialState();
  } catch (e) {
    console.warn('MotoLog: could not read saved data, starting fresh.', e);
    return createInitialState();
  }
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

const state = loadData();

// The fuel/oil records for whichever profile is currently active.
function activeData() {
  return state.data[state.activeProfileId];
}

function activeProfile() {
  return state.profiles.find(p => p.id === state.activeProfileId) || state.profiles[0];
}

/* =========================================================
   Utilities
   ========================================================= */
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function todayISO() {
  const d = new Date();
  const off = d.getTimezoneOffset();
  return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isFiniteNumber(n) {
  return typeof n === 'number' && Number.isFinite(n);
}

// Safe formatter: never renders NaN / Infinity / undefined
function fmt(n, decimals = 1) {
  if (!isFiniteNumber(n)) return '—';
  return n.toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function fmtInt(n) {
  if (!isFiniteNumber(n)) return '—';
  return Math.round(n).toLocaleString('en-US');
}

function fmtMoney(n) {
  if (!isFiniteNumber(n)) return '—';
  return '৳' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
}

let toastTimer = null;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.classList.remove('is-visible');
    setTimeout(() => { el.hidden = true; }, 250);
  }, 2200);
}

/* =========================================================
   Odometer sequence validation
   ========================================================= */
function getCombinedRecords(excludeId) {
  const fuelR = activeData().fuel.map(r => ({ id: r.id, date: r.date, odometer: r.odometer }));
  const oilR = activeData().oil.map(r => ({ id: r.id, date: r.date, odometer: r.odometer }));
  return fuelR.concat(oilR)
    .filter(r => r.id !== excludeId)
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.odometer - b.odometer));
}

// Ensures a new/edited reading keeps the odometer non-decreasing over time.
function validateOdometerSequence(dateStr, odo, excludeId) {
  const combined = getCombinedRecords(excludeId);
  let preceding = null;
  let following = null;
  for (const r of combined) {
    if (r.date <= dateStr) preceding = r;
  }
  for (const r of combined) {
    if (r.date >= dateStr) { following = r; break; }
  }
  if (preceding && odo < preceding.odometer) {
    return `Odometer can't be lower than ${fmtInt(preceding.odometer)} km, recorded on ${fmtDate(preceding.date)}.`;
  }
  if (following && odo > following.odometer) {
    return `Odometer can't be higher than ${fmtInt(following.odometer)} km — that's from a later record on ${fmtDate(following.date)}.`;
  }
  return null;
}

/* =========================================================
   Derived calculations
   ========================================================= */
function sortChrono(arr) {
  return [...arr].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.odometer - b.odometer));
}

function computeFuelDerived() {
  const sorted = sortChrono(activeData().fuel);

  // First pass: resolve each record's own cost/price fields (with fallbacks between
  // totalCost and pricePerLiter), independent of neighbours.
  const base = sorted.map(rec => {
    const pricePerLiter = isFiniteNumber(rec.pricePerLiter)
      ? rec.pricePerLiter
      : (isFiniteNumber(rec.totalCost) && rec.liters > 0 ? rec.totalCost / rec.liters : null);
    const totalCost = isFiniteNumber(rec.totalCost)
      ? rec.totalCost
      : (isFiniteNumber(rec.pricePerLiter) ? rec.pricePerLiter * rec.liters : null);
    return { ...rec, pricePerLiter, totalCost };
  });

  // Second pass: the distance covered since the previous fill-up was powered by the fuel
  // (and paid for by the cost) bought AT that previous fill-up — not the fuel being added
  // now, which hasn't been ridden on yet.
  const derived = base.map((rec, i) => {
    const prev = i > 0 ? base[i - 1] : null;
    let distance = null;
    if (prev) {
      const d = rec.odometer - prev.odometer;
      distance = d > 0 ? d : null;
    }
    const consumption = (distance && prev && prev.liters > 0) ? distance / prev.liters : null;
    const costPerKm = (distance && prev && isFiniteNumber(prev.totalCost)) ? prev.totalCost / distance : null;
    return { ...rec, distance, consumption, costPerKm, isFirst: i === 0 };
  });

  // Average mileage: total applicable distance / total applicable fuel.
  // Excludes the LAST fill's litres, since that fuel hasn't produced a measured distance yet.
  let avgMileage = null;
  if (sorted.length >= 2) {
    const totalDistance = sorted[sorted.length - 1].odometer - sorted[0].odometer;
    const totalFuel = base.slice(0, -1).reduce((sum, r) => sum + (isFiniteNumber(r.liters) ? r.liters : 0), 0);
    avgMileage = (totalDistance > 0 && totalFuel > 0) ? totalDistance / totalFuel : null;
  }

  const lastMileage = derived.length ? derived[derived.length - 1].consumption : null;

  return { ascending: derived, descending: [...derived].reverse(), avgMileage, lastMileage };
}

function getCurrentOdometer() {
  const all = [...activeData().fuel, ...activeData().oil].map(r => r.odometer).filter(isFiniteNumber);
  return all.length ? Math.max(...all) : null;
}

function computeOilStatusFor(rec, currentOdometer) {
  const next = rec.odometer + rec.interval;
  const remaining = isFiniteNumber(currentOdometer) ? next - currentOdometer : null;
  return { next, remaining };
}

function getLatestOil() {
  const sorted = sortChrono(activeData().oil);
  return sorted.length ? sorted[sorted.length - 1] : null;
}

/* =========================================================
   Profiles
   ========================================================= */
const profileOverlay = document.getElementById('profileOverlay');
const profileChipName = document.getElementById('profileChipName');
const profileList = document.getElementById('profileList');
const newProfileForm = document.getElementById('newProfileForm');
const newProfileName = document.getElementById('newProfileName');
const profileFormError = document.getElementById('profileFormError');

function renderProfileChip() {
  profileChipName.textContent = activeProfile().name;
}

function profileCounts(id) {
  const d = state.data[id] || emptyProfileData();
  return { fuel: d.fuel.length, oil: d.oil.length };
}

function renderProfileList() {
  const rows = state.profiles.map(p => {
    const isActive = p.id === state.activeProfileId;
    const counts = profileCounts(p.id);
    const canDelete = state.profiles.length > 1;
    return `
      <div class="profile-row ${isActive ? 'is-active' : ''}" data-id="${p.id}">
        <button type="button" class="profile-row-main" data-action="switch-profile" data-id="${p.id}">
          <span class="profile-row-dot" aria-hidden="true"></span>
          <span class="profile-row-info">
            <span class="profile-row-name">${escapeHtml(p.name)}</span>
            <span class="profile-row-meta">${counts.fuel} fuel · ${counts.oil} oil record${counts.oil === 1 ? '' : 's'}</span>
          </span>
        </button>
        <div class="profile-row-actions">
          <button type="button" class="icon-btn" data-action="rename-profile" data-id="${p.id}" aria-label="Rename profile">
            <svg viewBox="0 0 24 24" fill="none"><path d="M4 20l1-4.2L15.5 5.3a1.7 1.7 0 0 1 2.4 0l.8.8a1.7 1.7 0 0 1 0 2.4L8.2 19 4 20z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
          </button>
          ${canDelete ? `
          <button type="button" class="icon-btn" data-action="delete-profile" data-id="${p.id}" aria-label="Delete profile">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>` : ''}
        </div>
      </div>`;
  }).join('');
  profileList.innerHTML = rows;
}

document.getElementById('openProfiles').addEventListener('click', () => {
  renderProfileList();
  newProfileForm.reset();
  profileFormError.hidden = true;
  openSheet(profileOverlay);
});
document.getElementById('closeProfileSheet').addEventListener('click', () => closeSheet(profileOverlay));
profileOverlay.addEventListener('click', e => { if (e.target === profileOverlay) closeSheet(profileOverlay); });

function switchProfile(id) {
  if (id === state.activeProfileId) { closeSheet(profileOverlay); return; }
  state.activeProfileId = id;
  saveData();
  document.getElementById('chartFromDate').value = '';
  document.getElementById('chartToDate').value = '';
  renderProfileChip();
  renderProfileList();
  renderAll();
  closeSheet(profileOverlay);
  showToast(`Switched to ${activeProfile().name}`);
}

function startRenameProfile(id) {
  const row = profileList.querySelector(`.profile-row[data-id="${id}"]`);
  const profile = state.profiles.find(p => p.id === id);
  if (!row || !profile) return;
  const main = row.querySelector('.profile-row-main');
  main.outerHTML = `
    <form class="profile-row-main" data-action="rename-form" data-id="${id}" style="cursor:default;">
      <input type="text" class="profile-rename-input" id="renameInput-${id}" value="${escapeHtml(profile.name)}" maxlength="40" required>
    </form>`;
  const input = document.getElementById(`renameInput-${id}`);
  input.focus();
  input.select();
  input.addEventListener('blur', () => commitRenameProfile(id, input.value));
  row.querySelector('form[data-action="rename-form"]').addEventListener('submit', e => {
    e.preventDefault();
    commitRenameProfile(id, input.value);
  });
}

let renameCommitted = new Set();
function commitRenameProfile(id, rawValue) {
  if (renameCommitted.has(id)) return; // avoid double-commit from blur + submit
  renameCommitted.add(id);
  setTimeout(() => renameCommitted.delete(id), 0);

  const name = rawValue.trim();
  const profile = state.profiles.find(p => p.id === id);
  if (profile && name) {
    profile.name = name;
    saveData();
    renderProfileChip();
  }
  renderProfileList();
}

profileList.addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'switch-profile') switchProfile(id);
  if (btn.dataset.action === 'rename-profile') startRenameProfile(id);
  if (btn.dataset.action === 'delete-profile') {
    const profile = state.profiles.find(p => p.id === id);
    askDelete('profile', id, null, `Delete "${profile ? profile.name : 'this profile'}"?`);
    confirmBody.textContent = `This permanently deletes all fuel and oil records for this profile. This can't be undone.`;
  }
});

newProfileForm.addEventListener('submit', e => {
  e.preventDefault();
  profileFormError.hidden = true;
  const name = newProfileName.value.trim();
  if (!name) {
    profileFormError.textContent = 'Enter a name for the new profile.';
    profileFormError.hidden = false;
    return;
  }
  const id = uid();
  state.profiles.push({ id, name, createdAt: todayISO() });
  state.data[id] = emptyProfileData();
  state.activeProfileId = id;
  saveData();
  renderProfileChip();
  renderProfileList();
  renderAll();
  newProfileForm.reset();
  newProfileName.focus();
  showToast(`"${name}" created`);
});

/* =========================================================
   Dashboard
   ========================================================= */
function renderDashboard() {
  const currentOdometer = getCurrentOdometer();
  const { avgMileage, lastMileage } = computeFuelDerived();

  document.getElementById('statOdometer').textContent = isFiniteNumber(currentOdometer) ? fmtInt(currentOdometer) : '—';
  document.getElementById('statAvgMileage').textContent = fmt(avgMileage, 1);
  document.getElementById('statLastMileage').textContent = fmt(lastMileage, 1);

  renderOilGaugeAndBanner(currentOdometer);
}

function renderOilGaugeAndBanner(currentOdometer) {
  const gaugeFill = document.getElementById('gaugeFill');
  const gaugeValue = document.getElementById('oilGaugeValue');
  const gaugeUnit = document.getElementById('oilGaugeUnit');
  const statusText = document.getElementById('oilStatusText');
  const banner = document.getElementById('oilBanner');
  const statNextOilOdo = document.getElementById('statNextOilOdo');
  const statOilRunSince = document.getElementById('statOilRunSince');

  const latest = getLatestOil();
  const ARC_LEN = 157;

  if (!latest) {
    gaugeFill.style.strokeDashoffset = ARC_LEN;
    gaugeFill.style.stroke = 'var(--surface-3)';
    gaugeValue.textContent = '—';
    gaugeUnit.textContent = '';
    statusText.textContent = 'No oil change logged';
    banner.hidden = true;
    statNextOilOdo.textContent = '—';
    statOilRunSince.textContent = 'No oil change logged';
    return;
  }

  const { next, remaining } = computeOilStatusFor(latest, currentOdometer);
  const interval = latest.interval;
  const sinceChange = isFiniteNumber(currentOdometer) ? currentOdometer - latest.odometer : null;
  const fractionUsed = isFiniteNumber(remaining) && interval > 0
    ? Math.min(Math.max((interval - remaining) / interval, 0), 1)
    : 0;

  gaugeFill.style.strokeDashoffset = String(ARC_LEN * (1 - fractionUsed));

  const warnThreshold = Math.min(300, interval * 0.15);
  let level = 'ok';
  if (!isFiniteNumber(remaining)) level = 'ok';
  else if (remaining <= 0) level = 'danger';
  else if (remaining <= warnThreshold) level = 'warn';

  const colors = { ok: 'var(--accent-2)', warn: 'var(--warning)', danger: 'var(--danger)' };
  gaugeFill.style.stroke = colors[level];

  statNextOilOdo.textContent = fmtInt(next);
  statOilRunSince.textContent = isFiniteNumber(sinceChange) ? `${fmtInt(sinceChange)} km run since last change` : '';

  if (!isFiniteNumber(remaining)) {
    gaugeValue.textContent = '—';
    gaugeUnit.textContent = '';
    statusText.textContent = `Next change at ${fmtInt(next)} km`;
    banner.hidden = true;
    return;
  }

  if (remaining <= 0) {
    gaugeValue.textContent = fmtInt(Math.abs(remaining));
    gaugeUnit.textContent = 'km overdue';
    statusText.textContent = `Change was due at ${fmtInt(next)} km`;
  } else {
    gaugeValue.textContent = fmtInt(remaining);
    gaugeUnit.textContent = 'km left';
    statusText.textContent = `Next change at ${fmtInt(next)} km`;
  }

  if (level === 'danger') {
    banner.hidden = false;
    banner.className = 'oil-banner is-danger';
    banner.innerHTML = warningIcon() + `<span>Engine oil is overdue — ${fmtInt(Math.abs(remaining))} km past the ${fmtInt(interval)} km interval. Change it soon.</span>`;
  } else if (level === 'warn') {
    banner.hidden = false;
    banner.className = 'oil-banner is-warning';
    banner.innerHTML = warningIcon() + `<span>Oil change due soon — only ${fmtInt(remaining)} km left before the next service.</span>`;
  } else {
    banner.hidden = true;
  }
}

function warningIcon() {
  return `<svg viewBox="0 0 24 24" fill="none"><path d="M12 3.5 22 20.5H2L12 3.5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 10v4.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="17.3" r="1" fill="currentColor"/></svg>`;
}

/* =========================================================
   Rendering — Fuel list
   ========================================================= */
function renderFuelList() {
  const { descending } = computeFuelDerived();
  const list = document.getElementById('fuelList');
  const empty = document.getElementById('fuelEmpty');

  if (!descending.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = descending.map(rec => {
    const distanceStr = rec.isFirst ? '—' : (isFiniteNumber(rec.distance) ? `${fmtInt(rec.distance)} km` : '—');
    const consumptionStr = fmt(rec.consumption, 1);
    const costPerKmStr = isFiniteNumber(rec.costPerKm) ? fmtMoney(rec.costPerKm) : '—';
    const totalCostStr = isFiniteNumber(rec.totalCost) ? fmtMoney(rec.totalCost) : '—';

    return `
      <article class="record-card" data-id="${rec.id}">
        <div class="record-top">
          <div>
            <div class="record-date">${fmtDate(rec.date)}</div>
            <div class="record-odo">${fmtInt(rec.odometer)} km · ${fmt(rec.liters, 2)} L</div>
          </div>
          <div class="record-actions">
            <button class="icon-btn" data-action="edit-fuel" data-id="${rec.id}" aria-label="Edit record">
              <svg viewBox="0 0 24 24" fill="none"><path d="M4 20l1-4.2L15.5 5.3a1.7 1.7 0 0 1 2.4 0l.8.8a1.7 1.7 0 0 1 0 2.4L8.2 19 4 20z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-btn" data-action="delete-fuel" data-id="${rec.id}" aria-label="Delete record">
              <svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
        <div class="record-grid">
          <div class="record-metric">
            <div class="record-metric-label">Distance</div>
            <div class="record-metric-value">${distanceStr}</div>
          </div>
          <div class="record-metric">
            <div class="record-metric-label">Mileage</div>
            <div class="record-metric-value is-accent">${consumptionStr}${isFiniteNumber(rec.consumption) ? ' km/L' : ''}</div>
          </div>
          <div class="record-metric">
            <div class="record-metric-label">Cost / km</div>
            <div class="record-metric-value">${costPerKmStr}</div>
          </div>
          <div class="record-metric">
            <div class="record-metric-label">Total cost</div>
            <div class="record-metric-value">${totalCostStr}</div>
          </div>
        </div>
      </article>`;
  }).join('');
}

/* =========================================================
   Rendering — Oil list
   ========================================================= */
function renderOilList() {
  const currentOdometer = getCurrentOdometer();
  const sortedDesc = [...sortChrono(activeData().oil)].reverse();
  const list = document.getElementById('oilList');
  const empty = document.getElementById('oilEmpty');

  if (!sortedDesc.length) {
    list.innerHTML = '';
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  const latestId = sortedDesc[0].id;

  list.innerHTML = sortedDesc.map(rec => {
    const { next, remaining } = computeOilStatusFor(rec, currentOdometer);
    let badge = '';
    if (isFiniteNumber(remaining)) {
      if (remaining <= 0) {
        badge = `<span class="record-badge danger">${fmtInt(Math.abs(remaining))} km overdue</span>`;
      } else if (remaining <= Math.min(300, rec.interval * 0.15)) {
        badge = `<span class="record-badge warn">${fmtInt(remaining)} km left</span>`;
      } else {
        badge = `<span class="record-badge ok">${fmtInt(remaining)} km left</span>`;
      }
    }
    const subParts = [];
    if (rec.brand) subParts.push(escapeHtml(rec.brand));
    if (isFiniteNumber(rec.quantity)) subParts.push(`${fmt(rec.quantity, 1)} L`);

    return `
      <article class="record-card" data-id="${rec.id}">
        <div class="record-top">
          <div>
            <div class="record-date">${fmtDate(rec.date)} ${rec.id === latestId ? '<span style="color:var(--text-faint);font-weight:600;">· latest</span>' : ''}</div>
            <div class="record-odo">${fmtInt(rec.odometer)} km${subParts.length ? ' · ' + subParts.join(' · ') : ''}</div>
          </div>
          <div class="record-actions">
            <button class="icon-btn" data-action="edit-oil" data-id="${rec.id}" aria-label="Edit record">
              <svg viewBox="0 0 24 24" fill="none"><path d="M4 20l1-4.2L15.5 5.3a1.7 1.7 0 0 1 2.4 0l.8.8a1.7 1.7 0 0 1 0 2.4L8.2 19 4 20z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
            </button>
            <button class="icon-btn" data-action="delete-oil" data-id="${rec.id}" aria-label="Delete record">
              <svg viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-9 0 1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
            </button>
          </div>
        </div>
        <div class="record-grid">
          <div class="record-metric">
            <div class="record-metric-label">Interval</div>
            <div class="record-metric-value">${fmtInt(rec.interval)} km</div>
          </div>
          <div class="record-metric">
            <div class="record-metric-label">Next change</div>
            <div class="record-metric-value">${fmtInt(next)} km</div>
          </div>
          <div class="record-metric">
            <div class="record-metric-label">Cost</div>
            <div class="record-metric-value">${fmtMoney(rec.cost)}</div>
          </div>
          <div class="record-metric">
            <div class="record-metric-label">Status</div>
            <div class="record-metric-value">${badge || '—'}</div>
          </div>
        </div>
      </article>`;
  }).join('');
}

/* =========================================================
   Rendering — Chart
   ========================================================= */
function renderChart() {
  const wrap = document.getElementById('chartWrap');
  const fromInput = document.getElementById('chartFromDate');
  const toInput = document.getElementById('chartToDate');

  const { ascending } = computeFuelDerived();
  const allPoints = ascending
    .map(r => ({ date: r.date, value: r.consumption }))
    .filter(p => isFiniteNumber(p.value));

  if (allPoints.length < 2) {
    wrap.innerHTML = `
      <div class="chart-empty">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 19V5M4 19h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 15l3.5-4 3 2.5L18 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div>Add a couple more fuel records to see your mileage trend.</div>
      </div>`;
    return;
  }

  // Keep the date pickers' bounds in sync with the data that actually exists.
  const minDate = allPoints[0].date;
  const maxDate = allPoints[allPoints.length - 1].date;
  fromInput.min = minDate; fromInput.max = maxDate;
  toInput.min = minDate; toInput.max = maxDate;

  const fromVal = fromInput.value;
  const toVal = toInput.value;
  const points = allPoints.filter(p => (!fromVal || p.date >= fromVal) && (!toVal || p.date <= toVal));

  if (points.length < 2) {
    wrap.innerHTML = `
      <div class="chart-empty">
        <svg viewBox="0 0 24 24" fill="none"><path d="M4 19V5M4 19h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><path d="M7 15l3.5-4 3 2.5L18 7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <div>No mileage data in this date range.</div>
      </div>`;
    return;
  }

  const W = 600, H = 220, padL = 38, padR = 14, padT = 16, padB = 26;
  const values = points.map(p => p.value);
  let minV = Math.min(...values), maxV = Math.max(...values);
  if (minV === maxV) { minV -= 1; maxV += 1; }
  const rangePad = (maxV - minV) * 0.15;
  minV = Math.max(0, minV - rangePad);
  maxV += rangePad;

  const xStep = (W - padL - padR) / (points.length - 1);
  const yFor = v => padT + (H - padT - padB) * (1 - (v - minV) / (maxV - minV));
  const xFor = i => padL + i * xStep;

  const linePath = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(i).toFixed(1)} ${yFor(p.value).toFixed(1)}`).join(' ');
  const areaPath = `${linePath} L ${xFor(points.length - 1).toFixed(1)} ${(H - padB).toFixed(1)} L ${xFor(0).toFixed(1)} ${(H - padB).toFixed(1)} Z`;

  const gridLines = [0, 0.5, 1].map(t => {
    const y = padT + (H - padT - padB) * t;
    const val = maxV - (maxV - minV) * t;
    return `<line class="chart-gridline" x1="${padL}" y1="${y.toFixed(1)}" x2="${W - padR}" y2="${y.toFixed(1)}" />
            <text class="chart-axis-label" x="4" y="${(y + 3).toFixed(1)}">${fmt(val, 0)}</text>`;
  }).join('');

  const dots = points.map((p, i) => `<circle class="chart-dot" cx="${xFor(i).toFixed(1)}" cy="${yFor(p.value).toFixed(1)}" r="3.5"><title>${fmtDate(p.date)}: ${fmt(p.value, 1)} km/L</title></circle>`).join('');

  const labelEvery = Math.ceil(points.length / 5);
  const xLabels = points.map((p, i) => {
    if (i % labelEvery !== 0 && i !== points.length - 1) return '';
    return `<text class="chart-axis-label" x="${xFor(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">${fmtDate(p.date).replace(/ \d{4}$/, '')}</text>`;
  }).join('');

  wrap.innerHTML = `
    <svg class="chart-svg" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">
      <defs>
        <linearGradient id="chartGradient" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#ff7a1a" stop-opacity="0.45" />
          <stop offset="100%" stop-color="#ff7a1a" stop-opacity="0" />
        </linearGradient>
      </defs>
      ${gridLines}
      <path class="chart-area" d="${areaPath}" />
      <path class="chart-line" d="${linePath}" />
      ${dots}
      ${xLabels}
    </svg>`;
}

document.getElementById('chartFromDate').addEventListener('change', renderChart);
document.getElementById('chartToDate').addEventListener('change', renderChart);
document.getElementById('chartRangeReset').addEventListener('click', () => {
  document.getElementById('chartFromDate').value = '';
  document.getElementById('chartToDate').value = '';
  renderChart();
});

/* =========================================================
   Render everything
   ========================================================= */
function renderAll() {
  renderProfileChip();
  renderDashboard();
  renderFuelList();
  renderOilList();
  renderChart();
}

/* =========================================================
   Sheets (bottom modals)
   ========================================================= */
function openSheet(overlay) {
  overlay.hidden = false;
  document.body.style.overflow = 'hidden';
}
function closeSheet(overlay) {
  overlay.hidden = true;
  document.body.style.overflow = '';
}

/* ---------- Fuel sheet ---------- */
const fuelOverlay = document.getElementById('fuelOverlay');
const fuelForm = document.getElementById('fuelForm');
const fuelFormError = document.getElementById('fuelFormError');

function resetFuelForm() {
  fuelForm.reset();
  document.getElementById('fuelId').value = '';
  document.getElementById('fuelDate').value = todayISO();
  fuelFormError.hidden = true;
  document.getElementById('fuelSheetTitle').textContent = 'Add fuel';
  document.getElementById('saveFuelBtn').textContent = 'Save fuel record';
}

document.getElementById('openAddFuel').addEventListener('click', () => {
  resetFuelForm();
  openSheet(fuelOverlay);
});
document.getElementById('closeFuelSheet').addEventListener('click', () => closeSheet(fuelOverlay));
document.getElementById('cancelFuel').addEventListener('click', () => closeSheet(fuelOverlay));
fuelOverlay.addEventListener('click', e => { if (e.target === fuelOverlay) closeSheet(fuelOverlay); });

function openEditFuel(id) {
  const rec = activeData().fuel.find(r => r.id === id);
  if (!rec) return;
  resetFuelForm();
  document.getElementById('fuelSheetTitle').textContent = 'Edit fuel record';
  document.getElementById('saveFuelBtn').textContent = 'Save changes';
  document.getElementById('fuelId').value = rec.id;
  document.getElementById('fuelDate').value = rec.date;
  document.getElementById('fuelOdometer').value = rec.odometer;
  document.getElementById('fuelLiters').value = rec.liters;
  document.getElementById('fuelCost').value = isFiniteNumber(rec.totalCost) ? rec.totalCost : '';
  document.getElementById('fuelPrice').value = isFiniteNumber(rec.pricePerLiter) ? rec.pricePerLiter : '';
  openSheet(fuelOverlay);
}

fuelForm.addEventListener('submit', e => {
  e.preventDefault();
  fuelFormError.hidden = true;

  const id = document.getElementById('fuelId').value || uid();
  const date = document.getElementById('fuelDate').value;
  const odometer = parseFloat(document.getElementById('fuelOdometer').value);
  const liters = parseFloat(document.getElementById('fuelLiters').value);
  const costRaw = document.getElementById('fuelCost').value;
  const priceRaw = document.getElementById('fuelPrice').value;
  const totalCost = costRaw === '' ? null : parseFloat(costRaw);
  const pricePerLiter = priceRaw === '' ? null : parseFloat(priceRaw);

  if (!date) return showFuelError('Please choose a date.');
  if (!isFiniteNumber(odometer) || odometer < 0) return showFuelError('Enter a valid odometer reading (0 or more).');
  if (!isFiniteNumber(liters) || liters <= 0) return showFuelError('Enter a fuel quantity greater than 0.');
  if (totalCost !== null && (!isFiniteNumber(totalCost) || totalCost < 0)) return showFuelError('Total cost can\'t be negative.');
  if (pricePerLiter !== null && (!isFiniteNumber(pricePerLiter) || pricePerLiter < 0)) return showFuelError('Price per litre can\'t be negative.');

  const seqError = validateOdometerSequence(date, odometer, id);
  if (seqError) return showFuelError(seqError);

  const existingIdx = activeData().fuel.findIndex(r => r.id === id);
  const record = { id, date, odometer, liters, totalCost, pricePerLiter };
  if (existingIdx >= 0) activeData().fuel[existingIdx] = record;
  else activeData().fuel.push(record);

  saveData();
  renderAll();
  closeSheet(fuelOverlay);
  showToast(existingIdx >= 0 ? 'Fuel record updated' : 'Fuel record added');
});

function showFuelError(msg) {
  fuelFormError.textContent = msg;
  fuelFormError.hidden = false;
}

/* ---------- Oil sheet ---------- */
const oilOverlay = document.getElementById('oilOverlay');
const oilForm = document.getElementById('oilForm');
const oilFormError = document.getElementById('oilFormError');

function resetOilForm() {
  oilForm.reset();
  document.getElementById('oilId').value = '';
  document.getElementById('oilDate').value = todayISO();
  oilFormError.hidden = true;
  document.getElementById('oilSheetTitle').textContent = 'Add oil change';
  document.getElementById('saveOilBtn').textContent = 'Save oil record';
}

document.getElementById('openAddOil').addEventListener('click', () => {
  resetOilForm();
  openSheet(oilOverlay);
});
document.getElementById('closeOilSheet').addEventListener('click', () => closeSheet(oilOverlay));
document.getElementById('cancelOil').addEventListener('click', () => closeSheet(oilOverlay));
oilOverlay.addEventListener('click', e => { if (e.target === oilOverlay) closeSheet(oilOverlay); });

function openEditOil(id) {
  const rec = activeData().oil.find(r => r.id === id);
  if (!rec) return;
  resetOilForm();
  document.getElementById('oilSheetTitle').textContent = 'Edit oil record';
  document.getElementById('saveOilBtn').textContent = 'Save changes';
  document.getElementById('oilId').value = rec.id;
  document.getElementById('oilDate').value = rec.date;
  document.getElementById('oilOdometer').value = rec.odometer;
  document.getElementById('oilCost').value = isFiniteNumber(rec.cost) ? rec.cost : '';
  document.getElementById('oilInterval').value = rec.interval;
  document.getElementById('oilBrand').value = rec.brand || '';
  document.getElementById('oilQuantity').value = isFiniteNumber(rec.quantity) ? rec.quantity : '';
  openSheet(oilOverlay);
}

oilForm.addEventListener('submit', e => {
  e.preventDefault();
  oilFormError.hidden = true;

  const id = document.getElementById('oilId').value || uid();
  const date = document.getElementById('oilDate').value;
  const odometer = parseFloat(document.getElementById('oilOdometer').value);
  const costRaw = document.getElementById('oilCost').value;
  const cost = costRaw === '' ? null : parseFloat(costRaw);
  const interval = parseFloat(document.getElementById('oilInterval').value);
  const brand = document.getElementById('oilBrand').value.trim();
  const quantityRaw = document.getElementById('oilQuantity').value;
  const quantity = quantityRaw === '' ? null : parseFloat(quantityRaw);

  if (!date) return showOilError('Please choose a date.');
  if (!isFiniteNumber(odometer) || odometer < 0) return showOilError('Enter a valid odometer reading (0 or more).');
  if (cost !== null && (!isFiniteNumber(cost) || cost < 0)) return showOilError('Cost can\'t be negative.');
  if (!isFiniteNumber(interval) || interval <= 0) return showOilError('Enter a change interval greater than 0 km.');
  if (quantity !== null && (!isFiniteNumber(quantity) || quantity < 0)) return showOilError('Oil quantity can\'t be negative.');

  const seqError = validateOdometerSequence(date, odometer, id);
  if (seqError) return showOilError(seqError);

  const existingIdx = activeData().oil.findIndex(r => r.id === id);
  const record = { id, date, odometer, cost, interval, brand: brand || null, quantity };
  if (existingIdx >= 0) activeData().oil[existingIdx] = record;
  else activeData().oil.push(record);

  saveData();
  renderAll();
  closeSheet(oilOverlay);
  showToast(existingIdx >= 0 ? 'Oil record updated' : 'Oil record added');
});

function showOilError(msg) {
  oilFormError.textContent = msg;
  oilFormError.hidden = false;
}

/* =========================================================
   Delete confirmation
   ========================================================= */
const confirmOverlay = document.getElementById('confirmOverlay');
const confirmTitleEl = document.getElementById('confirmTitle');
const confirmBody = document.getElementById('confirmBody');
let pendingDelete = null;

function askDelete(type, id, label, title) {
  pendingDelete = { type, id };
  confirmTitleEl.textContent = title || 'Delete this record?';
  confirmBody.textContent = label ? `This will remove the record from ${label}. This can't be undone.` : "This can't be undone.";
  openSheet(confirmOverlay);
}

document.getElementById('confirmCancel').addEventListener('click', () => {
  pendingDelete = null;
  closeSheet(confirmOverlay);
});
confirmOverlay.addEventListener('click', e => {
  if (e.target === confirmOverlay) { pendingDelete = null; closeSheet(confirmOverlay); }
});
document.getElementById('confirmDelete').addEventListener('click', () => {
  if (!pendingDelete) return;
  const { type, id } = pendingDelete;
  if (type === 'fuel') activeData().fuel = activeData().fuel.filter(r => r.id !== id);
  if (type === 'oil') activeData().oil = activeData().oil.filter(r => r.id !== id);
  if (type === 'profile') {
    state.profiles = state.profiles.filter(p => p.id !== id);
    delete state.data[id];
    if (state.activeProfileId === id) {
      state.activeProfileId = state.profiles[0].id;
    }
    saveData();
    renderProfileChip();
    renderProfileList();
    renderAll();
    closeSheet(confirmOverlay);
    showToast('Profile deleted');
    pendingDelete = null;
    return;
  }
  saveData();
  renderAll();
  closeSheet(confirmOverlay);
  showToast('Record deleted');
  pendingDelete = null;
});

/* =========================================================
   Delegated click handling for record cards
   ========================================================= */
document.getElementById('fuelList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'edit-fuel') openEditFuel(id);
  if (btn.dataset.action === 'delete-fuel') askDelete('fuel', id, 'your fuel log');
});

document.getElementById('oilList').addEventListener('click', e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'edit-oil') openEditOil(id);
  if (btn.dataset.action === 'delete-oil') askDelete('oil', id, 'your oil change history');
});

/* Escape key closes any open sheet */
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  [fuelOverlay, oilOverlay, confirmOverlay].forEach(o => { if (!o.hidden) closeSheet(o); });
});

/* =========================================================
   Collapsible panels
   ========================================================= */
const PANEL_STATE_KEY = 'motolog.panels.v1';

// true = expanded. Fuel/oil open by default since they're the core content;
// chart/data start collapsed to keep the main page uncluttered.
function loadPanelState() {
  try {
    const raw = localStorage.getItem(PANEL_STATE_KEY);
    if (raw) return { fuel: true, oil: true, chart: false, data: false, ...JSON.parse(raw) };
  } catch (e) { /* fall through to defaults */ }
  return { fuel: true, oil: true, chart: false, data: false };
}

const panelState = loadPanelState();

function savePanelState() {
  localStorage.setItem(PANEL_STATE_KEY, JSON.stringify(panelState));
}

function applyPanelState(key, toggleId, bodyId, collapsedLabel, expandedLabel) {
  const btn = document.getElementById(toggleId);
  const body = document.getElementById(bodyId);
  const expanded = !!panelState[key];
  body.hidden = !expanded;
  btn.setAttribute('aria-expanded', String(expanded));
  btn.setAttribute('aria-label', expanded ? collapsedLabel : expandedLabel);
  btn.classList.toggle('is-open', expanded);
}

function setupCollapsible(key, toggleId, bodyId, collapsedLabel, expandedLabel) {
  applyPanelState(key, toggleId, bodyId, collapsedLabel, expandedLabel);
  document.getElementById(toggleId).addEventListener('click', () => {
    panelState[key] = !panelState[key];
    savePanelState();
    applyPanelState(key, toggleId, bodyId, collapsedLabel, expandedLabel);
  });
}

setupCollapsible('fuel', 'toggleFuel', 'fuelBody', 'Collapse fuel log', 'Expand fuel log');
setupCollapsible('oil', 'toggleOil', 'oilBody', 'Collapse engine oil', 'Expand engine oil');
setupCollapsible('chart', 'toggleChart', 'chartBody', 'Collapse mileage trend', 'Expand mileage trend');
setupCollapsible('data', 'toggleData', 'dataBody', 'Collapse backup and export', 'Expand backup and export');

/* =========================================================
   Backup & export
   ========================================================= */
function csvEscape(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function buildCsv() {
  const profile = activeProfile();
  const { ascending: fuelRows } = computeFuelDerived();
  const oilRows = sortChrono(activeData().oil);
  const lines = [];

  lines.push(csvEscape(`MotoLog export — ${profile.name} — ${todayISO()}`));
  lines.push('');
  lines.push('FUEL LOG');
  lines.push(['Date', 'Odometer (km)', 'Fuel (L)', 'Distance (km)', 'Mileage (km/L)', 'Cost per km', 'Total cost', 'Price per L']
    .map(csvEscape).join(','));
  fuelRows.forEach(r => {
    lines.push([
      r.date,
      r.odometer,
      r.liters,
      isFiniteNumber(r.distance) ? r.distance : '',
      isFiniteNumber(r.consumption) ? r.consumption.toFixed(2) : '',
      isFiniteNumber(r.costPerKm) ? r.costPerKm.toFixed(2) : '',
      isFiniteNumber(r.totalCost) ? r.totalCost.toFixed(2) : '',
      isFiniteNumber(r.pricePerLiter) ? r.pricePerLiter.toFixed(2) : '',
    ].map(csvEscape).join(','));
  });

  lines.push('');
  lines.push('ENGINE OIL');
  lines.push(['Date', 'Odometer (km)', 'Interval (km)', 'Next change (km)', 'Cost', 'Brand', 'Quantity (L)']
    .map(csvEscape).join(','));
  oilRows.forEach(r => {
    lines.push([
      r.date,
      r.odometer,
      r.interval,
      r.odometer + r.interval,
      isFiniteNumber(r.cost) ? r.cost.toFixed(2) : '',
      r.brand || '',
      isFiniteNumber(r.quantity) ? r.quantity : '',
    ].map(csvEscape).join(','));
  });

  return lines.join('\n');
}

function downloadFile(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  // Leading BOM so Excel correctly reads UTF-8 characters like ৳.
  const csv = '\uFEFF' + buildCsv();
  const filename = `motolog-${slugify(activeProfile().name)}-${todayISO()}.csv`;
  downloadFile(filename, csv, 'text/csv;charset=utf-8;');
  showToast('Excel file downloaded');
});

// Full CSV parser (handles quoted fields containing commas, quotes, or newlines) —
// a simple split('\n') would break on any field that was quoted for that reason.
// Also auto-detects ',' vs ';' since Excel sometimes re-saves CSVs with a
// semicolon delimiter depending on the system's regional settings.
function detectDelimiter(text) {
  const headerLine = text.split(/\r?\n/).find(l => /odometer/i.test(l) || /date/i.test(l));
  if (!headerLine) return ',';
  const commas = (headerLine.match(/,/g) || []).length;
  const semicolons = (headerLine.match(/;/g) || []).length;
  return semicolons > commas ? ';' : ',';
}

function parseCsv(rawText) {
  // Strip a leading byte-order-mark, which some editors/OSes add to UTF-8 files.
  const text = rawText.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === delimiter) {
      row.push(field); field = '';
    } else if (c === '\r') {
      // ignore; row break is handled on \n
    } else if (c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
    } else {
      field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sectionRows(rows, sectionLabel) {
  const start = rows.findIndex(r => r[0] && r[0].trim().toUpperCase().replace(/["']/g, '') === sectionLabel);
  if (start === -1) return [];
  const dataRows = [];
  // start+1 is the header row; data begins at start+2 and runs until a blank row or EOF.
  for (let i = start + 2; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every(cell => cell.trim() === '')) break;
    dataRows.push(r);
  }
  return dataRows;
}

function parseFuelCsvRows(rows) {
  const out = [];
  let skipped = 0;
  sectionRows(rows, 'FUEL LOG').forEach(r => {
    const date = (r[0] || '').trim();
    const odometer = parseFloat(r[1]);
    const liters = parseFloat(r[2]);
    const totalCostRaw = (r[6] || '').trim();
    const priceRaw = (r[7] || '').trim();
    if (!date || !isFiniteNumber(odometer) || odometer < 0 || !isFiniteNumber(liters) || liters <= 0) {
      skipped++; return;
    }
    out.push({
      id: uid(),
      date,
      odometer,
      liters,
      totalCost: totalCostRaw === '' ? null : parseFloat(totalCostRaw),
      pricePerLiter: priceRaw === '' ? null : parseFloat(priceRaw),
    });
  });
  return { records: out, skipped };
}

function parseOilCsvRows(rows) {
  const out = [];
  let skipped = 0;
  sectionRows(rows, 'ENGINE OIL').forEach(r => {
    const date = (r[0] || '').trim();
    const odometer = parseFloat(r[1]);
    const interval = parseFloat(r[2]);
    const costRaw = (r[4] || '').trim();
    const brand = (r[5] || '').trim();
    const qtyRaw = (r[6] || '').trim();
    if (!date || !isFiniteNumber(odometer) || odometer < 0 || !isFiniteNumber(interval) || interval <= 0) {
      skipped++; return;
    }
    out.push({
      id: uid(),
      date,
      odometer,
      interval,
      cost: costRaw === '' ? null : parseFloat(costRaw),
      brand: brand || null,
      quantity: qtyRaw === '' ? null : parseFloat(qtyRaw),
    });
  });
  return { records: out, skipped };
}

document.getElementById('importCsvBtn').addEventListener('click', () => {
  document.getElementById('importCsvInput').click();
});

document.getElementById('importCsvInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const rows = parseCsv(reader.result);
      const fuelResult = parseFuelCsvRows(rows);
      const oilResult = parseOilCsvRows(rows);

      if (!fuelResult.records.length && !oilResult.records.length) {
        throw new Error('No valid rows found');
      }

      const profileName = activeProfile().name;
      const ok = window.confirm(
        `This replaces all fuel and oil records in "${profileName}" with the contents of this file. This can't be undone. Continue?`
      );
      if (!ok) return;

      activeData().fuel = fuelResult.records;
      activeData().oil = oilResult.records;
      saveData();
      document.getElementById('chartFromDate').value = '';
      document.getElementById('chartToDate').value = '';
      renderAll();

      const skippedTotal = fuelResult.skipped + oilResult.skipped;
      showToast(
        `Imported ${fuelResult.records.length} fuel, ${oilResult.records.length} oil record(s)` +
        (skippedTotal ? ` — ${skippedTotal} row(s) skipped` : '')
      );
    } catch (err) {
      console.error('MotoLog CSV import failed:', err);
      if (err && err.message === 'No valid rows found') {
        showToast('No fuel or oil rows found — check the file has "FUEL LOG" / "ENGINE OIL" section headers.');
      } else {
        showToast('Could not read that file as a MotoLog Excel export.');
      }
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

document.getElementById('exportJsonBtn').addEventListener('click', () => {
  const json = JSON.stringify(state, null, 2);
  downloadFile(`motolog-backup-${todayISO()}.json`, json, 'application/json');
  showToast('Backup downloaded');
});

document.getElementById('importJsonBtn').addEventListener('click', () => {
  document.getElementById('importJsonInput').click();
});

document.getElementById('importJsonInput').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(reader.result);
      if (!Array.isArray(parsed.profiles) || !parsed.profiles.length || !parsed.data) {
        throw new Error('Invalid backup file');
      }
      const ok = window.confirm('This replaces all current data on this device with the backup file. This can\'t be undone. Continue?');
      if (!ok) return;

      state.profiles = parsed.profiles;
      state.data = parsed.data;
      state.activeProfileId = parsed.activeProfileId;
      state.profiles.forEach(p => { if (!state.data[p.id]) state.data[p.id] = emptyProfileData(); });
      if (!state.activeProfileId || !state.profiles.some(p => p.id === state.activeProfileId)) {
        state.activeProfileId = state.profiles[0].id;
      }

      saveData();
      document.getElementById('chartFromDate').value = '';
      document.getElementById('chartToDate').value = '';
      renderProfileChip();
      renderAll();
      showToast('Backup restored');
    } catch (err) {
      showToast('That file doesn\'t look like a valid MotoLog backup.');
    } finally {
      e.target.value = '';
    }
  };
  reader.readAsText(file);
});

/* =========================================================
   Init
   ========================================================= */
renderAll();

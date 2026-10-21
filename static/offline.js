// Offline support: logging a template workout and saving picks as a session go to a per-user queue in localStorage
// first and are sent in order when there's a connection. (Building/editing templates needs a connection.)

function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

const store = {
  key: name => `templates:${ME.username}:${name}`,
  get(name, fallback) {
    try { return JSON.parse(localStorage.getItem(store.key(name))) ?? fallback; } catch { return fallback; }
  },
  set(name, value) {
    try { localStorage.setItem(store.key(name), JSON.stringify(value)); } catch {}
  },
};

const drafts = {
  get: id => store.get('drafts', {})[id] || null,
  set(id, value) { const all = store.get('drafts', {}); all[id] = value; store.set('drafts', all); },
  clear(id) { const all = store.get('drafts', {}); delete all[id]; store.set('drafts', all); },
};

const SyncQueue = {
  load: () => store.get('queue', []),
  save: queue => store.set('queue', queue),
  push(op) {
    const queue = SyncQueue.load();
    queue.push({ id: uuid(), queued_at: new Date().toISOString(), ...op });
    SyncQueue.save(queue);
  },
};

// Exercise history with workouts that haven't synced yet, so the next run starts from their values.
function withQueuedLogs(history, queue) {
  const merged = { ...history };
  queue.filter(op => op.kind === 'template_log').forEach(op => {
    for (const [id, instances] of Object.entries(roundsByExercise(op.body.supersets))) {
      merged[id] = { target_streak: 0, ...merged[id], last_logged_at: op.body.logged_at, previous: { created_at: op.body.logged_at, instances } };
    }
  });
  return merged;
}

// Send queued operations one at a time, in order. Stops at the first network/server failure and retries later.
let flushing = null;
// onNotice(message) reports problems; onRecords(prs) gets the personal records a synced workout set.
function flushQueue(onNotice, onRecords = () => {}) {
  flushing = flushing || (async () => {
    let queue = SyncQueue.load();
    while (queue.length) {
      const op = queue[0];
      let result = null;
      let drop = false;
      try {
        result = await sendOp(op);
      } catch (err) {
        if (err.status === 0 || err.status === 401 || err.status >= 500) break; // offline, logged out, or server down
        onNotice(err.message);
        drop = true;
      }
      queue = SyncQueue.load().filter(next => next.id !== op.id); // re-read: it may have changed while awaiting
      SyncQueue.save(queue);
      if (!drop && op.kind === 'template_log') {
        if (result.template_deleted) onNotice(`"${op.body.session_name}" was deleted before your workout synced. The workout was still recorded.`);
        if (result.prs?.length) onRecords(result.prs);
      }
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

function sendOp(op) {
  const id = encodeURIComponent(op.template_id);
  switch (op.kind) {
    case 'template_log': return api('POST', `/api/templates/${id}/log`, { ...op.body, client_id: op.id });
    case 'template_save': return api('POST', `/api/templates/${id}/save-as-session`, { ...op.body, client_id: op.id });
  }
  return Promise.resolve();
}

const openKeys = new Set();

// Bottom banner: shows while offline or while changes wait to sync (after a short delay, to avoid flicker).
let bannerTimer = null;
function updateSyncBanner(offline) {
  const banner = document.getElementById('sync-status') || document.body.appendChild(el('div', { id: 'sync-status', class: 'status-banner' }));
  const describe = () => {
    const count = SyncQueue.load().length;
    if (count) return `${count} change${count === 1 ? '' : 's'} waiting to sync${offline ? ' (offline)' : ''}…`;
    return offline ? 'Offline: showing saved data' : '';
  };
  if (!describe()) {
    clearTimeout(bannerTimer);
    bannerTimer = null;
    banner.classList.remove('visible');
    return;
  }
  if (banner.classList.contains('visible')) { banner.textContent = describe(); return; }
  if (bannerTimer) return;
  bannerTimer = setTimeout(() => {
    bannerTimer = null;
    const text = describe();
    banner.textContent = text;
    banner.classList.toggle('visible', !!text);
  }, 3000);
}

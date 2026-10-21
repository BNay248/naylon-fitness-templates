// Running a template: rank exercises for each slot, let the user pick, then train it in the workout view
// (workout-ui.js), so previous values, swaps and PR toasts all work. Needs library-ui.js (matchesRules).

// Open-slot rule key -> the exercise field it's compared with.
const SLOT_FIT_FIELDS = { muscle_group_ids: 'primary_group_ids', muscle_ids: 'primary_muscle_ids', movement_pattern_ids: 'movement_pattern_ids', pattern_kinds: 'pattern_kinds' };
const SUGGESTIONS_SHOWN = 4;

const forEachSlot = (template, fn) => template.supersets.forEach(superset => superset.slots.forEach(slot => fn(slot, superset)));

function slotCandidates(slot, catalog) {
  if (slot.mode === 'locked') return [catalog.byId[slot.exercise_id]].filter(Boolean);
  if (slot.mode === 'shortlist') return slot.shortlist_ids.map(id => catalog.byId[id]).filter(Boolean);
  return catalog.list.filter(exercise => matchesRules(slot.rules, exercise));
}

// 0..1: how squarely an exercise fits its slot (proportional, so focused matches win; shortlists keep the author's order).
function slotFit(slot, exercise) {
  if (slot.mode === 'shortlist') return 1 - 0.5 * slot.shortlist_ids.indexOf(exercise.id) / slot.shortlist_ids.length;
  if (slot.mode !== 'open') return 1;
  const overlap = (a = [], b = []) => {
    const union = new Set([...a, ...b]);
    return union.size ? a.filter(id => b.includes(id)).length / union.size : 0;
  };
  const keys = Object.keys(SLOT_FIT_FIELDS).filter(key => (slot.rules[key] || []).length);
  return keys.length ? keys.reduce((sum, key) => sum + overlap(slot.rules[key], exercise[SLOT_FIT_FIELDS[key]]), 0) / keys.length : 1;
}

const daysSince = iso => Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 864e5));
const agoText = days => days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;

// Ranked options for a slot: [{exercise, score, reason, closest}], best first.
// ctx: {catalog, equipment: Set (empty = not set, no filter), equipmentNames, history, taken: Set of ids already picked}
function rankSlot(slot, ctx) {
  const all = slotCandidates(slot, ctx.catalog);
  const fitsEquipment = exercise => !ctx.equipment.size || (exercise.equipment_ids || []).every(id => ctx.equipment.has(id));
  const usable = all.filter(fitsEquipment);
  const closest = !usable.length && all.length > 0; // nothing fits their equipment: show the closest anyway
  // Exercises whose last couple of logs hit every target: their next steps get a boost.
  const readyFrom = id => ctx.catalog.list.find(other => (ctx.history[other.id]?.target_streak || 0) >= 2 && (other.progression_ids || []).includes(id));
  return (closest ? all : usable).map(exercise => {
    const done = ctx.history[exercise.id];
    const days = done ? daysSince(done.last_logged_at) : null;
    const from = readyFrom(exercise.id);
    const taken = ctx.taken.has(exercise.id);
    const score = 3 * slotFit(slot, exercise) + (done ? 2 * Math.max(0, 1 - days / 56) : 0) + (from ? 2 : 0) - (taken ? 3 : 0);
    const missing = (exercise.equipment_ids || []).filter(id => !ctx.equipment.has(id)).map(id => ctx.equipmentNames[id]).filter(Boolean);
    const reason = closest ? `Needs ${missing.join(', ')}`
      : taken ? 'Already in this workout'
        : from ? `Next step from ${from.name}`
          : done ? `You did this ${agoText(days)}`
            : slot.mode === 'locked' ? 'Set in this template'
              : slot.mode === 'shortlist' ? "From the template's list" : 'Fits this slot';
    return { exercise, score, reason, closest };
  }).sort((a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name));
}

// Fills every slot not in `fixed` with its best option, in order, avoiding repeats. A remembered pick is used if it
// still fits its slot.
function autoPicks(template, ctx, picks = {}, fixed = new Set()) {
  const next = {};
  const taken = new Set();
  forEachSlot(template, slot => {
    const candidates = slotCandidates(slot, ctx.catalog);
    const keep = fixed.has(slot.slot_id) ? picks[slot.slot_id] : (template.reopen === 'remember' ? template.remembered_picks?.[slot.slot_id] : null);
    const pick = keep && candidates.some(exercise => exercise.id === keep) ? keep : rankSlot(slot, { ...ctx, taken })[0]?.exercise.id;
    if (pick) {
      next[slot.slot_id] = pick;
      taken.add(pick);
    }
  });
  return next;
}

// The workout a set of picks describes, for workoutCard.
function templateSession(template, picks, ctx) {
  const supersets = template.supersets.map(superset => ({ repeats: superset.repeats, exercises: superset.slots.map(slot => {
    const exercise = ctx.catalog.byId[picks[slot.slot_id]];
    return { exercise_id: exercise.id, name: exercise.name, metrics: exercise.metrics, note: slot.note || '',
      targets: cleanTargets(slot.targets, exercise.metrics), instances: [] };
  }) }));
  const previous = Object.fromEntries(Object.values(picks).map(id => [id, ctx.history[id]?.previous]).filter(([, value]) => value));
  return { key: `tpl:${template.id}`, name: template.name, previous, supersets };
}

// One template: fill the slots, train, then optionally keep the picks as your own session.
// actions: {log(template, supersets, picks), saveAsSession(template, body)}
// state: an object owned by the page that outlives re-renders (background syncs rebuild the cards):
//   picks (slot_id -> exercise_id), fixed (slots the user chose themselves; auto picks re-rank around them),
//   mode ('fill' | 'run' | 'saved' | a key of `views`).
// tools(setMode): optional buttons above the slots (e.g. Edit, Delete); views: {mode: setMode => node} for those modes.
function templateRunCard(template, { ctx, actions, drafts, openKeys, state, tools = () => null, views = {}, tags = [] }) {
  const key = `tpl:${template.id}`; // the workout draft's key (same as the run session's)
  state.fixed = state.fixed || new Set();
  state.picks = autoPicks(template, ctx, state.picks || {}, state.fixed);
  state.mode = state.mode || (drafts.get(key) ? 'run' : 'fill'); // resume a half-logged workout
  const body = el('div', {});
  const card = trackedDetails(`template:${template.id}`, openKeys, { class: 'card' },
    el('summary', {}, el('span', {}, template.name), tags), body);
  const setMode = mode => { state.mode = mode; render(); };

  const choose = (slot, id) => {
    state.picks[slot.slot_id] = id;
    state.fixed.add(slot.slot_id);
    state.picks = autoPicks(template, ctx, state.picks, state.fixed);
    render();
  };

  function slotView(slot) {
    const taken = new Set(Object.entries(state.picks).filter(([slotId]) => slotId !== slot.slot_id).map(([, id]) => id));
    const ranked = rankSlot(slot, { ...ctx, taken });
    const current = ranked.find(option => option.exercise.id === state.picks[slot.slot_id]) || ranked[0];
    const targets = Object.entries(slot.targets || {}).map(([metric, value]) => `${metric} ${value}`).join(', ');
    const shown = ranked.slice(0, SUGGESTIONS_SHOWN);
    if (current && !shown.includes(current)) shown.push(current);
    return el('div', { class: 'exercise-log' },
      el('div', { class: 'name' }, slot.label || 'Exercise', targets && el('span', { class: 'tag' }, targets)),
      slot.note && el('div', { class: 'exercise-note' }, slot.note),
      !ranked.length ? el('p', { class: 'error' }, template.can_edit ? 'No exercises fit this slot any more. Edit the template to fix it.'
        : `No exercises fit this slot any more. Ask ${template.owner_name} to update the template.`)
        : el('div', {},
          ranked[0].closest && el('p', { class: 'muted' }, 'Nothing here fits your equipment, so these are the closest options.'),
          slot.mode === 'locked' ? el('div', {}, current.exercise.name)
            : el('div', { class: 'chips field' }, shown.map(option => el('span', {
              class: `chip ${option === current ? 'on' : ''}`, title: option.reason, onclick: () => choose(slot, option.exercise.id),
            }, option.exercise.name))),
          el('div', { class: 'muted' }, current.reason),
          ranked.length > shown.length && el('select', { class: 'field', onchange: e => e.target.value && choose(slot, e.target.value) },
            el('option', { value: '' }, `More options (${ranked.length})…`),
            ranked.map(option => el('option', { value: option.exercise.id }, option.exercise.name)))));
  }

  function fillView() {
    const complete = template.supersets.every(superset => superset.slots.every(slot => state.picks[slot.slot_id]));
    return el('div', {},
      tools(setMode),
      template.description && el('p', { class: 'pre-wrap field' }, template.description),
      !ctx.equipment.size && el('p', { class: 'info' }, 'Tip: set your equipment on your ',
        ME.trainer_url ? el('a', { href: `${ME.trainer_url.replace(/\/$/, '')}/profile` }, 'trainer profile') : 'trainer profile',
        ' so suggestions only use what you have.'),
      template.supersets.map((superset, idx) => el('div', { class: 'superset' },
        el('div', { class: 'superset-head' }, `Superset ${idx + 1} · ${superset.repeats} round(s)`),
        superset.slots.map(slotView))),
      el('div', { class: 'buttons' },
        el('button', { class: 'primary', disabled: !complete, onclick: () => { state.mode = 'run'; render(); } }, 'Start Workout')));
  }

  function runView() {
    const session = templateSession(template, state.picks, ctx);
    openKeys.add(session.key);
    return el('div', {},
      workoutCard(session, { catalog: ctx.catalog, drafts, openKeys, onLog: supersets => {
        drafts.clear(key);
        state.mode = 'saved';
        render();
        return actions.log(template, supersets, state.picks);
      } }),
      el('div', { class: 'buttons' }, el('button', { onclick: () => { drafts.clear(key); state.mode = 'fill'; render(); } }, 'Change Picks')));
  }

  function savedView() {
    const session = templateSession(template, state.picks, ctx);
    return el('div', { class: 'confirm' },
      el('div', {}, 'Workout saved. Keep these picks as your own session to reuse? Changes to the template won\'t affect it.'),
      el('div', { class: 'buttons' },
        el('button', { class: 'primary', onclick: e => withBusy(e.currentTarget, async () => {
          await actions.saveAsSession(template, { name: template.name, supersets: session.supersets.map(superset => ({
            repeats: superset.repeats, exercises: superset.exercises.map(({ instances, ...exercise }) => exercise),
          })) });
          state.mode = 'fill';
          render();
        }) }, 'Save as My Session'),
        el('button', { onclick: () => { state.mode = 'fill'; render(); } }, 'No Thanks')));
  }

  function render() {
    const view = views[state.mode];
    mount(body, view ? view(setMode) : state.mode === 'run' ? runView() : state.mode === 'saved' ? savedView() : fillView());
  }
  const ensureBody = () => { if (card.open && !body.childElementCount) render(); };
  card.addEventListener('toggle', ensureBody);
  ensureBody();
  return card;
}

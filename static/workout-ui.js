// The workout view a template run is trained in: rounds, previous values, targets, one-off swaps.
// Taken from the trainer's session-ui.js (sessionCard in run-only mode); keep the logged shape in step with it.

const MAX_REPEATS = 20;
const clone = value => JSON.parse(JSON.stringify(value));

function roundCount(superset) {
  return Math.min(MAX_REPEATS, Math.max(1, Number(superset.repeats) || 1));
}

function toCount(value) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) && number > 0 ? number : 0;
}

// A metric value: non-negative, up to 2 decimal places (22.5 stays 22.5, 10.0 becomes 10), like the server's to_amount.
function toAmount(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number * 100) / 100 : 0;
}

// Positive targets for the exercise's metrics only, like the server's clean_targets.
function cleanTargets(targets, metrics) {
  return Object.fromEntries(metrics.filter(metric => toAmount((targets || {})[metric]) > 0).map(metric => [metric, toAmount(targets[metric])]));
}

function targetText(exercise) {
  const targets = exercise.targets || {};
  return (exercise.metrics || []).filter(metric => targets[metric]).map(metric => `${metric} ${targets[metric]}`).join(', ');
}

// Identifies a workout's layout, so a saved draft is only resumed while the picks are unchanged.
function structureKey(supersets) {
  return JSON.stringify(supersets.map(superset => [roundCount(superset), superset.exercises.map(exercise => exercise.exercise_id)]));
}

// The rounds done as each exercise in one logged workout, by id (a swapped round counts as its substitute).
function roundsByExercise(supersets) {
  const found = {};
  supersets.forEach(superset => superset.exercises.forEach(exercise => {
    const here = {};
    exercise.instances.forEach(instance => {
      const id = instance.swap?.exercise_id || exercise.exercise_id;
      (here[id] = here[id] || []).push({ metrics: clone(instance.metrics) });
    });
    Object.entries(here).forEach(([id, instances]) => { if (!found[id]) found[id] = instances; });
  }));
  return found;
}

function youtubeEmbed(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([A-Za-z0-9_-]{11})/);
  return match ? `https://www.youtube.com/embed/${match[1]}` : null;
}

function exerciseVideo(exercise, catalog) {
  const details = catalog.byId[exercise.exercise_id];
  if (!details) return null;
  return youtubeEmbed(details.video_url) || youtubeEmbed(details.instructions);
}

// How well `to` stands in for `from`, 0 = not a match. Similarity is proportional (shared / combined), so a focused
// match beats one that merely works more muscles: movement patterns weigh most, then primary muscles, then all
// muscles. A substitute must be the same type of exercise (strength, mobility or cardio), work one of the
// original's primary muscles, and share a metric.
function swapScore(from, to) {
  const similarity = (a = [], b = []) => {
    const union = new Set([...a, ...b]);
    return union.size ? a.filter(id => b.includes(id)).length / union.size : 0;
  };
  const sharesAny = (a = [], b = []) => a.some(id => b.includes(id));
  const type = item => {
    const kinds = item.pattern_kinds || [];
    if (kinds.length && kinds.every(kind => kind === 'Mobility')) return 'mobility';
    if (kinds.length && kinds.every(kind => kind === 'Conditioning')) return 'cardio';
    return 'strength';
  };
  const allMuscles = item => [...(item.primary_muscle_ids || []), ...(item.secondary_muscle_ids || [])];
  if (type(from) !== type(to) || !sharesAny(from.primary_muscle_ids, allMuscles(to)) || !sharesAny(from.metrics, to.metrics)) return 0;
  return similarity(from.movement_pattern_ids, to.movement_pattern_ids) * 3
    + similarity(from.primary_muscle_ids, to.primary_muscle_ids) * 2
    + similarity(allMuscles(from), allMuscles(to));
}

// The closest substitutes for an exercise, best first.
function swapSuggestions(from, list, limit = 8) {
  return list.filter(item => item.id !== from.id)
    .map(item => ({ item, score: swapScore(from, item) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name))
    .slice(0, limit).map(({ item }) => item);
}

// "New PR! Bench Press (Barbell): 105 Weight (was 100)" for one record from the log endpoint.
function recordText(record) {
  const sameWeight = record.metric === 'Weight' && record.value === record.previous;
  const what = sameWeight ? `${record.reps} reps at ${record.value} (was ${record.previous_reps})`
    : record.metric === 'Reps' ? `${record.value} reps (was ${record.previous})`
      : `${record.metric} ${record.value} (was ${record.previous})`;
  return `🏆 New PR! ${record.name}: ${what}`;
}

// The exercise list plus the library (muscles, equipment, …) the builder and suggestions work from.
function makeCatalog(exercises, library = null) {
  return {
    list: exercises,
    byId: Object.fromEntries(exercises.map(item => [item.id, item])),
    library: library || { muscle_groups: [], muscles: [], equipment: [], movement_patterns: [], equipment_types: [], pattern_kinds: [] },
  };
}

// `value` may be null when a `placeholder` is given: the field stays blank showing the placeholder,
// and the −/+ buttons step from the placeholder's value. Decimals are allowed unless `integer` is set.
function numberInput(value, onChange, { min = 0, max = Infinity, placeholder = null, integer = false } = {}) {
  const parse = integer ? toCount : toAmount;
  const input = el('input', { type: 'number', class: 'number-input', inputmode: integer ? 'numeric' : 'decimal', step: integer ? '1' : 'any', min, value: value == null ? '' : String(value) });
  if (placeholder != null) input.placeholder = String(placeholder);
  input.addEventListener('change', () => {
    if (input.value === '' && placeholder != null) return onChange(null);
    const clamped = Math.min(max, Math.max(min, parse(input.value)));
    input.value = String(clamped);
    onChange(clamped);
  });
  input.addEventListener('focus', () => input.select());
  return input;
}

// A row of metric fields, at most 3 per line (more wrap onto further lines).
const metricGrid = (items, extraClass = '') => el('div', { class: `metric-grid ${extraClass}`.trim(), style: `--cols: ${Math.min(3, Math.max(1, items.length))}` }, items);

// Tracks which <details> are open (by key) so re-renders from background sync don't collapse anything.
function trackedDetails(key, openKeys, props, ...children) {
  const node = el('details', { ...props, open: openKeys.has(key) }, ...children);
  node.addEventListener('toggle', () => { node.open ? openKeys.add(key) : openKeys.delete(key); });
  return node;
}

// A swapped round carries its substitute's previous values (fetched when swapping), since the workout doesn't list it.
function previousValues(session, exercise, round) {
  const swap = (exercise.instances || [])[round]?.swap;
  return roundValues(swap ? exercise.instances[round].previous : session.previous?.[exercise.exercise_id], swap ? swap.metrics : exercise.metrics, round);
}

function roundValues(previous, metrics, round) {
  if (!previous || !previous.instances?.length) return {};
  const values = previous.instances[Math.min(round, previous.instances.length - 1)].metrics || {};
  return Object.fromEntries(metrics.filter(metric => values[metric]).map(metric => [metric, values[metric]]));
}

// Working copy of the workout: one instance per round. Metrics with a target start blank (the target shows
// as a placeholder); the rest are prefilled from previous values.
function workoutDraft(session) {
  return session.supersets.map(superset => ({
    repeats: roundCount(superset),
    exercises: superset.exercises.map(exercise => draftExercise(session, exercise, roundCount(superset))),
  }));
}

function draftExercise(session, exercise, rounds) {
  return {
    exercise_id: exercise.exercise_id,
    name: exercise.name,
    metrics: exercise.metrics || [],
    note: exercise.note || '',
    targets: exercise.targets || {},
    instances: Array.from({ length: rounds }, (_, round) => {
      const previous = previousValues(session, exercise, round);
      return { metrics: Object.fromEntries((exercise.metrics || []).map(metric => [metric,
        (exercise.targets || {})[metric] ? null : toAmount(previous[metric] ?? 0)])) };
    }),
  };
}

// One round done as `chosen` instead of the planned exercise, this time only. Prefilled from `previous` ({instances}
// from /api/previous, or null); the planned exercise's targets don't carry over, since its weights etc. may not apply.
function swappedRound(chosen, round, previous) {
  const metrics = chosen.metrics || [];
  const values = roundValues(previous, metrics, round);
  return {
    swap: { exercise_id: chosen.id, name: chosen.name, metrics },
    previous: previous?.instances?.length ? previous : null,
    metrics: Object.fromEntries(metrics.map(metric => [metric, toAmount(values[metric] ?? 0)])),
  };
}

// The workout as it gets logged: fields left blank count as having hit the target, and fetched previous values are dropped.
function withTargetsFilled(draft) {
  const filled = clone(draft);
  filled.forEach(superset => superset.exercises.forEach(exercise => exercise.instances.forEach(instance => {
    delete instance.previous;
    for (const metric of Object.keys(instance.metrics)) {
      if (instance.metrics[metric] == null) instance.metrics[metric] = toAmount((exercise.targets || {})[metric]);
    }
  })));
  return filled;
}

// The workout to train: session is {key, name, supersets, previous (exercise id -> {instances})}.
// drafts: {get(key), set(key, supersets), clear(key)} — unsaved values, kept across reloads.
// onLog(supersets) gets the finished workout.
function workoutCard(session, { catalog, drafts, openKeys, onLog }) {
  const key = session.key;
  const body = el('div', {});
  let showVideos = false;
  let swapping = null; // {at: "superset:exercise", rounds: Set} while a swap picker is open
  const card = trackedDetails(key, openKeys, { class: 'card' },
    el('summary', {}, el('span', {}, session.name), el('span', { class: 'tag' }, `${session.supersets.length} superset(s)`)),
    body);
  const ensureBody = () => { if (card.open && !body.childElementCount) render(); };
  card.addEventListener('toggle', ensureBody);
  ensureBody();

  function render() {
    mount(body,
      el('label', { class: 'check' },
        el('input', { type: 'checkbox', checked: showVideos, onchange: e => { showVideos = e.target.checked; render(); } }),
        'Show videos'),
      logView());
  }

  function logView() {
    // Resume an unsaved draft only if the picks haven't changed underneath it.
    const stored = drafts.get(key);
    const draft = stored && structureKey(stored) === structureKey(session.supersets) ? stored : workoutDraft(session);
    draft.forEach((superset, s) => superset.exercises.forEach((exercise, e) => {
      const current = session.supersets[s].exercises[e];
      exercise.note = current.note || '';
      exercise.targets = current.targets || {};
    }));
    const saveDraft = () => drafts.set(key, draft);
    const saveButton = el('button', { class: 'primary', onclick: () => withBusy(saveButton, () => onLog(withTargetsFilled(draft))) }, 'Save Workout');

    return el('div', {},
      draft.map((superset, supersetIdx) => trackedDetails(`${key}:superset:${supersetIdx}`, openKeys, { class: 'card' },
        el('summary', {}, `Superset ${supersetIdx + 1} • ${superset.repeats} round(s)`),
        superset.exercises.map((exercise, exerciseIdx) => {
          const at = `${supersetIdx}:${exerciseIdx}`;
          const original = session.supersets[supersetIdx].exercises[exerciseIdx];
          const change = (rounds, instanceFor) => {
            rounds.forEach(round => { exercise.instances[round] = instanceFor(round); });
            swapping = null;
            saveDraft();
            render();
          };
          return exerciseLog(exercise, superset.repeats, saveDraft, {
            picker: swapping?.at === at ? swapping : null,
            // Every round starts picked; the picker's round chips choose which ones to swap.
            open: () => {
              swapping = { at, rounds: new Set(Array.from({ length: superset.repeats }, (_, round) => round)) };
              render();
            },
            close: () => { swapping = null; render(); },
            apply: (chosen, rounds, previous) => change(rounds, round => swappedRound(chosen, round, previous)),
            undo: rounds => change(rounds, round => draftExercise(session, original, superset.repeats).instances[round]),
          });
        }),
      )),
      el('div', { class: 'buttons' }, saveButton),
    );
  }

  // One block per exercise: name/note/video once, then a row of inputs for each round.
  function exerciseLog(exercise, rounds, onEdit, swap) {
    const swappedRounds = exercise.instances.map((instance, round) => instance.swap ? round : null).filter(round => round != null);
    const substitutes = [...new Map(swappedRounds.map(round => exercise.instances[round].swap).map(item => [item.exercise_id, item])).values()];
    const videos = showVideos ? [exercise, ...substitutes]
      .map(item => [item.name, exerciseVideo(item, catalog)]).filter(([, video]) => video) : [];
    const target = targetText(exercise);
    return el('div', { class: 'exercise-log' },
      el('div', { class: 'row' },
        el('div', { class: 'name grow' }, exercise.name || 'Untitled', swappedRounds.length > 0 && el('span', { class: 'tag swapped' }, 'Swapped')),
        !swap.picker && swappedRounds.length > 0 && el('button', { type: 'button', class: 'small', onclick: () => swap.undo(swappedRounds) }, 'Undo swaps'),
        !swap.picker && el('button', { type: 'button', class: 'small', onclick: () => swap.open() }, 'Swap'),
      ),
      swap.picker && swapPicker(exercise, rounds, swap),
      exercise.note && el('div', { class: 'exercise-note' }, exercise.note),
      target && el('div', { class: 'muted' }, `Target: ${target}`),
      videos.map(([name, video]) => el('div', { class: 'video' }, el('iframe', { src: video, allowfullscreen: true, loading: 'lazy', title: name }))),
      Array.from({ length: rounds }, (_, round) => roundRow(exercise, round, onEdit, swap)),
    );
  }

  // Choose a substitute for some rounds of this workout only (machine taken, injury, …).
  function swapPicker(exercise, rounds, swap) {
    const picked = swap.picker.rounds;
    const planned = catalog.byId[exercise.exercise_id];
    const matches = planned ? swapSuggestions(planned, catalog.list) : [];
    const options = items => items.filter(item => item.id !== exercise.exercise_id).map(item => el('option', { value: item.id }, item.name));
    const select = el('select', {},
      el('option', { value: '' }, 'Do instead…'),
      matches.length ? [el('optgroup', { label: 'Best matches' }, options(matches)), el('optgroup', { label: 'All exercises' }, options(catalog.list))]
        : options(catalog.list),
    );
    const chips = rounds > 1 && el('div', { class: 'chips field' }, Array.from({ length: rounds }, (_, round) => {
      const chip = el('span', { class: `chip${picked.has(round) ? ' on' : ''}`, onclick: () => {
        picked.has(round) ? picked.delete(round) : picked.add(round);
        chip.classList.toggle('on', picked.has(round));
      } }, `Round ${round + 1}`);
      return chip;
    }));
    const choose = async () => {
      const chosen = catalog.byId[select.value];
      if (!chosen) return toast('Pick an exercise to swap in', 'error');
      if (!picked.size) return toast('Pick at least one round', 'error');
      let previous = null;
      try {
        previous = await api('GET', `/api/previous?exercise_id=${encodeURIComponent(chosen.id)}`);
      } catch (err) {
        if (err.status !== 0) throw err; // offline: swap anyway, just without previous values
      }
      swap.apply(chosen, [...picked], previous);
    };
    return el('div', { class: 'confirm' },
      el('div', { class: 'field' }, `Swap ${exercise.name} for this workout only:`),
      el('div', { class: 'field' }, select),
      chips,
      el('div', { class: 'buttons' },
        el('button', { type: 'button', class: 'primary', onclick: e => withBusy(e.currentTarget, choose) }, 'Swap'),
        el('button', { type: 'button', onclick: swap.close }, 'Cancel'),
      ),
    );
  }

  function roundRow(exercise, round, onEdit, swap) {
    const instance = exercise.instances[round];
    const metrics = instance.swap ? instance.swap.metrics : exercise.metrics;
    const previous = previousValues(session, exercise, round);
    const previousText = metrics.filter(metric => metric in previous).map(metric => `${metric}: ${previous[metric]}`).join(', ');
    const targets = instance.swap ? {} : exercise.targets || {};
    return el('div', { class: 'round-row' },
      el('div', { class: 'row' },
        el('div', { class: 'round-title grow' }, `Round ${round + 1}`, instance.swap && el('span', { class: 'swapped-name' }, ` · ${instance.swap.name} instead`)),
        !swap.picker && instance.swap && el('button', { type: 'button', class: 'small', onclick: () => swap.undo([round]) }, 'Undo'),
      ),
      metrics.length
        ? metricGrid(metrics.map(metric => el('div', {},
          el('label', {}, metric),
          numberInput(instance.metrics[metric], value => { instance.metrics[metric] = value; onEdit(); }, { placeholder: targets[metric] || null }),
        )))
        : el('div', { class: 'muted' }, 'No metrics configured for this exercise'),
      previousText && el('div', { class: 'muted' }, `Previous: ${previousText}`),
    );
  }

  return card;
}

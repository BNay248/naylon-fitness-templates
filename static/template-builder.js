// The template editor: a recipe of slots, each locked to one exercise, a shortlist, or open to anything matching its rules.
const MODES = [
  { key: 'open', label: 'Open', help: 'Pick any exercise matching the rules when you run it; the best matches are suggested first.' },
  { key: 'shortlist', label: 'Shortlist', help: 'Pick from the exercises you list.' },
  { key: 'locked', label: 'Locked', help: 'Always this exact exercise.' },
];
const TARGET_METRICS = ['Reps', 'Weight', 'Duration', 'Distance'];
const RULE_KEYS = ['muscle_group_ids', 'muscle_ids', 'movement_pattern_ids', 'equipment_ids', 'pattern_kinds'];

const blankRules = () => Object.fromEntries(RULE_KEYS.map(key => [key, []]));
const blankSlot = () => ({ slot_id: '', label: '', mode: 'open', exercise_id: '', shortlist_ids: [], rules: blankRules(), note: '', targets: {} });
const blankTemplate = () => ({ name: '', description: '', reopen: 'remember', published: false, supersets: [{ repeats: 3, slots: [blankSlot()] }] });

// Sections for each rule picker, built from the library.
function ruleSections(catalog) {
  const lib = catalog.library;
  return {
    muscle_group_ids: ['Muscle groups', [{ label: 'Groups', items: lib.muscle_groups }]],
    muscle_ids: ['Muscles', lib.muscle_groups.map(group => ({ label: group.name, items: lib.muscles.filter(muscle => muscle.group_id === group.id) }))],
    movement_pattern_ids: ['Movement patterns', bySection(lib.movement_patterns, 'kind', lib.pattern_kinds)],
    equipment_ids: ['Equipment (uses only these)', [{ label: 'None', items: [{ id: NO_EQUIPMENT, name: 'No equipment', description: 'Bodyweight exercises that need nothing at all' }] },
      ...bySection(lib.equipment, 'type', lib.equipment_types)]],
    pattern_kinds: ['Exercise kinds', [{ label: 'Kinds', items: lib.pattern_kinds.map(kind => ({ id: kind, name: kind })) }]],
  };
}

const matching = (rules, catalog) => catalog.list.filter(exercise => matchesRules(rules, exercise));
const nameOf = (id, catalog) => (catalog.byId[id] || {}).name || 'Unknown exercise';

// ---------- Builder ----------

function templateBuilder({ catalog, initial, saveLabel, onSave, onCancel }) {
  const state = initial ? clone(initial) : blankTemplate();
  state.supersets.forEach(superset => superset.slots.forEach(slot => { slot.rules = { ...blankRules(), ...slot.rules }; }));
  const root = el('div', { class: 'builder' });
  const exerciseOptions = (selected, exclude = []) => [
    el('option', { value: '' }, 'Choose exercise…'),
    catalog.list.filter(item => !exclude.includes(item.id)).map(item => el('option', { value: item.id, selected: item.id === selected }, item.name)),
  ];

  function preview(slot) {
    const node = el('p', { class: 'muted field' });
    const draw = () => {
      if (slot.mode !== 'open') return mount(node);
      if (!RULE_KEYS.some(key => slot.rules[key].length)) return mount(node, 'Add at least one rule.');
      const found = matching(slot.rules, catalog);
      node.classList.toggle('error', !found.length);
      mount(node, found.length
        ? `${found.length} exercise${found.length === 1 ? '' : 's'} match: ${found.slice(0, 6).map(item => item.name).join(', ')}${found.length > 6 ? ', …' : ''}`
        : 'No exercises match these rules.');
    };
    draw();
    return { node, draw };
  }

  function modeBody(slot, refresh) {
    if (slot.mode === 'locked') {
      return el('div', { class: 'field' }, el('select', { onchange: e => { slot.exercise_id = e.target.value; } }, exerciseOptions(slot.exercise_id)));
    }
    if (slot.mode === 'shortlist') {
      const chips = el('div', { class: 'chips field' }, slot.shortlist_ids.map(id => el('span', { class: 'chip on', title: 'Remove', onclick: () => {
        slot.shortlist_ids = slot.shortlist_ids.filter(other => other !== id);
        refresh();
      } }, `${nameOf(id, catalog)} ✕`)));
      return el('div', {}, chips, el('select', { onchange: e => {
        if (e.target.value) slot.shortlist_ids.push(e.target.value);
        refresh();
      } }, exerciseOptions('', slot.shortlist_ids)));
    }
    const shown = preview(slot);
    const sections = ruleSections(catalog);
    return el('div', {},
      el('p', { class: 'muted field' }, 'Different rules must all match; several picks within one rule are either/or.'),
      RULE_KEYS.map(key => chipPicker(sections[key][0], sections[key][1], slot.rules[key], ids => { slot.rules[key] = ids; shown.draw(); }).node),
      shown.node);
  }

  function targetsPanel(slot) {
    return el('details', { class: 'card' },
      el('summary', {}, 'Targets & note'),
      el('p', { class: 'muted field' }, 'Targets apply to whichever exercise is picked, if it tracks that metric.'),
      metricGrid(TARGET_METRICS.map(metric => el('div', {},
        el('label', {}, metric),
        numberInput(slot.targets[metric] ?? null, value => { value ? slot.targets[metric] = value : delete slot.targets[metric]; }, { placeholder: '' }))), 'field'),
      el('input', { type: 'text', placeholder: 'Note (optional)', value: slot.note, oninput: e => { slot.note = e.target.value; } }));
  }

  function slotEditor(superset, slot, index) {
    const node = el('div', { class: 'builder-exercise' });
    const refresh = () => mount(node, ...content());
    const content = () => [
      el('div', { class: 'row field' },
        el('input', { class: 'grow', type: 'text', placeholder: `Slot ${index + 1} label, e.g. "Upper push"`, value: slot.label, oninput: e => { slot.label = e.target.value; } }),
        el('button', { type: 'button', class: 'small danger', onclick: () => { superset.slots.splice(index, 1); render(); } }, 'Remove')),
      el('div', { class: 'chips field' }, MODES.map(mode => el('span', {
        class: `chip ${slot.mode === mode.key ? 'on' : ''}`, onclick: () => { slot.mode = mode.key; refresh(); },
      }, mode.label))),
      el('p', { class: 'muted field' }, MODES.find(mode => mode.key === slot.mode).help),
      modeBody(slot, refresh),
      targetsPanel(slot),
    ];
    refresh();
    return node;
  }

  function render() {
    mount(root,
      el('div', { class: 'field' }, el('label', {}, 'Template name*'),
        el('input', { type: 'text', value: state.name, oninput: e => { state.name = e.target.value; } })),
      el('div', { class: 'field' }, el('label', {}, 'Description (optional)'),
        el('textarea', { oninput: e => { state.description = e.target.value; } }, state.description)),
      el('div', { class: 'field' }, el('label', {}, 'When it is opened again'),
        el('select', { onchange: e => { state.reopen = e.target.value; } },
          el('option', { value: 'remember', selected: state.reopen === 'remember' }, 'Start from the last picks'),
          el('option', { value: 'fresh', selected: state.reopen === 'fresh' }, 'Start from fresh suggestions'))),
      ME.role === 'coach' && el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: state.published, onchange: e => { state.published = e.target.checked; } }),
        'Publish to all my clients'),
      state.supersets.map((superset, supersetIdx) => el('div', { class: 'superset' },
        el('div', { class: 'superset-head' },
          el('span', { class: 'grow' }, `Superset ${supersetIdx + 1}`),
          el('span', { class: 'muted' }, 'Rounds'),
          el('div', { style: 'width:80px' }, numberInput(superset.repeats, value => { superset.repeats = value; }, { min: 1, max: 20, integer: true }))),
        superset.slots.map((slot, index) => slotEditor(superset, slot, index)),
        el('div', { class: 'buttons' },
          el('button', { type: 'button', onclick: () => { superset.slots.push(blankSlot()); render(); } }, 'Add Slot'),
          state.supersets.length > 1 && el('button', { type: 'button', class: 'danger', onclick: () => { state.supersets.splice(supersetIdx, 1); render(); } }, 'Remove Superset')))),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', onclick: () => { state.supersets.push({ repeats: 3, slots: [blankSlot()] }); render(); } }, 'Add Superset')),
      el('div', { class: 'buttons' },
        el('button', { class: 'primary', onclick: e => withBusy(e.currentTarget, () => {
          if (!state.name.trim()) return toast('Please enter a template name', 'error');
          return onSave(state);
        }) }, saveLabel),
        onCancel && el('button', { type: 'button', onclick: onCancel }, 'Cancel')));
  }
  render();
  return root;
}

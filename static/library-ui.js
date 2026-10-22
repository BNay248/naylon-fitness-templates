// Library pickers and the slot rule matcher for the template builder and suggestions.

// A collapsible set of on/off chips in labelled sections ([{label, items}]); returns {node, read(), set(ids), reset()}.
// onChange(ids) runs after every toggle.
function chipPicker(title, sections, selectedIds, onChange = () => {}) {
  const selected = new Set(selectedIds || []);
  const summary = el('span', { class: 'muted' });
  const chips = [];
  const draw = () => {
    chips.forEach(({ chip, item }) => chip.classList.toggle('on', selected.has(item.id)));
    summary.textContent = selected.size ? `${selected.size} selected` : 'None selected';
  };
  const rows = sections.filter(section => section.items.length).map(section => el('div', { class: 'muscle-group' },
    el('span', { class: 'muted' }, section.label),
    el('div', { class: 'chips' }, section.items.map(item => {
      const chip = el('span', { class: 'chip', title: item.description || '', onclick: () => {
        selected.has(item.id) ? selected.delete(item.id) : selected.add(item.id);
        draw();
        onChange([...selected]);
      } }, item.name);
      chips.push({ chip, item });
      return chip;
    }))));
  draw();
  return {
    node: el('details', { class: 'card' }, el('summary', {}, el('span', {}, title), summary),
      rows.length ? rows : el('p', { class: 'muted' }, 'Nothing has been set up yet.')),
    read: () => [...selected],
    set(ids) { selected.clear(); ids.forEach(id => selected.add(id)); draw(); },
    reset() { selected.clear(); draw(); },
  };
}

// Sections of library items by their type/kind, in the configured order.
const bySection = (items, key, order) => order.map(label => ({ label, items: items.filter(item => item[key] === label) }));

// An equipment rule value meaning "needs no equipment" (the server's NO_EQUIPMENT).
const NO_EQUIPMENT = 'none';

// Client-side mirror of the server's matches_rules: AND across rule keys, OR within one; an empty key doesn't
// constrain; an equipment rule means "uses some of these and nothing else", and NO_EQUIPMENT in it also lets
// through exercises that need no equipment. Needs exercise.pattern_kinds (from /api/exercises).
function matchesRules(rules, exercise) {
  const anyOf = (key, values) => !(rules[key] || []).length || (values || []).some(value => rules[key].includes(value));
  const equipment = rules.equipment_ids || [];
  return anyOf('muscle_group_ids', exercise.primary_group_ids)
    && anyOf('muscle_ids', exercise.primary_muscle_ids)
    && anyOf('movement_pattern_ids', exercise.movement_pattern_ids)
    && anyOf('pattern_kinds', exercise.pattern_kinds)
    && (!equipment.length || ((exercise.equipment_ids || []).length
      ? exercise.equipment_ids.every(id => equipment.includes(id)) : equipment.includes(NO_EQUIPMENT)));
}

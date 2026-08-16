// Regression tests for the duplicate-events bug recorded in
// CHANGELOG.md: the same event appearing several times over because
// getEventsSection() returned raw, undeduped rows. It shipped as a real
// bug TWICE -- once in the admin panel, then again (same root cause) in
// the digest email -- before dedupeEvents()/applyAdminEventCuration()
// existed as the one place getEventsSection() itself can't forget to
// call. The public site (app-board.js) and two other call sites
// (api/admin/[action].js, api/notifications.js) deliberately keep their
// OWN separate copies of this same dedup logic on top of this -- see
// the comment above dedupeEvents() in api/_localFeed.js for why that's
// intentional defense-in-depth, not duplication worth removing. This
// file only tests the one copy that getEventsSection() itself depends
// on, since that's the one every caller ultimately relies on actually
// running.
//
// Run with: npm test (or: node --test)

const test = require('node:test');
const assert = require('node:assert/strict');
const { dedupeEvents, applyAdminEventCuration } = require('../api/_localFeed');

function makeEvent(overrides = {}) {
  return {
    title_fi: 'Kesäkonsertti',
    event_date: '2026-08-16',
    event_start_time: '18:00',
    admin_selected: false,
    admin_highlighted: false,
    ...overrides
  };
}

test('dedupeEvents: a single event with no duplicates passes through unchanged', () => {
  const events = [makeEvent()];
  assert.deepEqual(dedupeEvents(events), events);
});

test('dedupeEvents: exact duplicates (same title/date/start time) collapse to one', () => {
  // This is the literal bug: the same real-world event, inserted more
  // than once (e.g. found again on a later refresh under a slightly
  // different source_url), showing up 3-4 times in a list meant to
  // represent distinct events.
  const events = [makeEvent(), makeEvent(), makeEvent()];
  const result = dedupeEvents(events);
  assert.equal(result.length, 1);
});

test('dedupeEvents: keeps the FIRST occurrence, not the last', () => {
  // Matters in practice: earlier rows in the array are typically the
  // ones with an admin_selected/admin_highlighted flag already applied
  // (curation happens before de-dup in the pipeline in some paths) --
  // silently keeping a later, plain duplicate instead would quietly
  // drop that curation.
  const first = makeEvent({ id: 1 });
  const duplicate = makeEvent({ id: 2 });
  const result = dedupeEvents([first, duplicate]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 1);
});

test('dedupeEvents: different title is NOT treated as a duplicate', () => {
  const events = [makeEvent({ title_fi: 'Kesäkonsertti' }), makeEvent({ title_fi: 'Talvimarkkinat' })];
  assert.equal(dedupeEvents(events).length, 2);
});

test('dedupeEvents: same title but different date is NOT treated as a duplicate', () => {
  // A genuinely recurring event (e.g. a weekly market) on two different
  // days is two real, distinct listings -- not a duplicate to collapse.
  const events = [makeEvent({ event_date: '2026-08-16' }), makeEvent({ event_date: '2026-08-23' })];
  assert.equal(dedupeEvents(events).length, 2);
});

test('dedupeEvents: same title and date but different start time is NOT treated as a duplicate', () => {
  // e.g. a matinee and an evening showing of the same production, same day.
  const events = [makeEvent({ event_start_time: '14:00' }), makeEvent({ event_start_time: '19:00' })];
  assert.equal(dedupeEvents(events).length, 2);
});

test('dedupeEvents: handles an empty array without throwing', () => {
  assert.deepEqual(dedupeEvents([]), []);
});

test('dedupeEvents: handles null/undefined input without throwing (real call sites can pass this)', () => {
  assert.deepEqual(dedupeEvents(null), []);
  assert.deepEqual(dedupeEvents(undefined), []);
});

test('applyAdminEventCuration: dedupes even when nothing is admin-selected', () => {
  // This is the exact regression: getEventsSection() calling this on a
  // raw, undeduped row set (the normal case -- most events are never
  // manually curated at all) must still come out deduped.
  const events = [makeEvent(), makeEvent()];
  const result = applyAdminEventCuration(events);
  assert.equal(result.length, 1);
});

test('applyAdminEventCuration: highlighted picks lead, then plain picks, then the rest -- with duplicates still collapsed throughout', () => {
  const highlighted = makeEvent({ id: 'h', title_fi: 'Highlighted', admin_selected: true, admin_highlighted: true });
  const highlightedDupe = makeEvent({ id: 'h-dupe', title_fi: 'Highlighted', admin_selected: true, admin_highlighted: true });
  const plainPick = makeEvent({ id: 'p', title_fi: 'Plain pick', admin_selected: true });
  const untouched = makeEvent({ id: 'u', title_fi: 'Untouched' });

  const result = applyAdminEventCuration([untouched, plainPick, highlighted, highlightedDupe]);

  assert.equal(result.length, 3); // the highlighted duplicate collapsed away
  assert.equal(result[0].id, 'h');
  assert.equal(result[1].id, 'p');
  assert.equal(result[2].id, 'u');
});

test('applyAdminEventCuration: with nothing selected, order is otherwise preserved (just deduped)', () => {
  const a = makeEvent({ id: 'a', title_fi: 'A' });
  const b = makeEvent({ id: 'b', title_fi: 'B' });
  const result = applyAdminEventCuration([a, b]);
  assert.deepEqual(result.map(e => e.id), ['a', 'b']);
});

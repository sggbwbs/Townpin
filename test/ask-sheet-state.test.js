// Regression tests for the three real, sequential mobile chat-panel
// bugs recorded in CHANGELOG.md's "v1.0 wrap-up" -- each found only
// after fixing the previous one. The logic under test here is the
// exact same code the real UI calls (see ask-sheet-state.js), not a
// re-implementation of it -- these tests exercise the real functions.
//
// Run with: npm test (or: node --test)

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAskSheetHidden, shouldReopenAskSheetOnFocus, shouldMinimizeOnEscape } = require('../ask-sheet-state');

test('isAskSheetHidden: a sheet that was never opened is hidden', () => {
  assert.equal(isAskSheetHidden(false, false), true);
});

test('isAskSheetHidden: an open, non-minimized sheet is NOT hidden', () => {
  assert.equal(isAskSheetHidden(true, false), false);
});

test('isAskSheetHidden: an open-but-minimized sheet IS hidden (regression: reopen button visibility)', () => {
  // Bug this guards: the reopen button's own visibility check used to
  // exist as an inline `!open || minimized` condition duplicated
  // separately in app-feed.js -- if a future edit only tests `open`
  // and drops the `minimized` half, this test fails immediately rather
  // than silently stranding a minimized conversation with no visible
  // way back to it.
  assert.equal(isAskSheetHidden(true, true), true);
});

test('shouldReopenAskSheetOnFocus: never reopens a sheet that was never opened, even with history', () => {
  assert.equal(shouldReopenAskSheetOnFocus(false, false, 5), false);
});

test('shouldReopenAskSheetOnFocus: never reopens an already-visible (open, not minimized) sheet', () => {
  // Not wrong to leave this false -- there's nothing to "reopen" if
  // it's already showing.
  assert.equal(shouldReopenAskSheetOnFocus(true, false, 5), false);
});

test('shouldReopenAskSheetOnFocus: never reopens with no history, even if minimized', () => {
  assert.equal(shouldReopenAskSheetOnFocus(true, true, 0), false);
});

test('shouldReopenAskSheetOnFocus: DOES reopen when genuinely open+minimized with real history', () => {
  assert.equal(shouldReopenAskSheetOnFocus(true, true, 3), true);
});

test('shouldReopenAskSheetOnFocus: regression -- checking .open alone is not enough', () => {
  // This is the exact bug: an earlier version of the real focus handler
  // checked only `panel.classList.contains('open')`, which stays true
  // even while minimized, so tapping the tab bar's input after clearing
  // the chat force-reopened an empty sheet. A version of this function
  // that only looked at `isOpen` would incorrectly return true here
  // even with a minimized-but-open, non-empty sheet.
  const isOpen = true;
  const isMinimized = true;
  const historyLength = 4;
  assert.equal(shouldReopenAskSheetOnFocus(isOpen, isMinimized, historyLength), true);
  // And the inverse -- open, NOT minimized, should never trigger a
  // reopen action (there's nothing to reopen).
  assert.equal(shouldReopenAskSheetOnFocus(true, false, historyLength), false);
});

test('shouldMinimizeOnEscape: does nothing on a sheet that was never opened', () => {
  assert.equal(shouldMinimizeOnEscape(false, false), false);
});

test('shouldMinimizeOnEscape: does nothing on an already-minimized sheet', () => {
  assert.equal(shouldMinimizeOnEscape(true, true), false);
});

test('shouldMinimizeOnEscape: minimizes a genuinely open, visible sheet', () => {
  assert.equal(shouldMinimizeOnEscape(true, false), true);
});

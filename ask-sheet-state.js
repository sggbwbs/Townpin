// Pure state-decision logic for the ask-chat sheet's open/minimized
// behavior, pulled out of app-feed.js/app-chat.js specifically so it
// can be exercised by a real regression test (see
// test/ask-sheet-state.test.js) without needing a browser or a DOM --
// these three real, sequential bugs (see CHANGELOG's "v1.0 wrap-up")
// all lived in exactly this kind of small boolean condition, and each
// one was found only by hand, one at a time, as fixing the previous
// one surfaced the next.
//
// Deliberately takes plain booleans/numbers, never a DOM element or
// classList -- that's what makes this testable with zero setup. The
// real UI code (app-feed.js, app-chat.js) reads the actual classList
// state and passes it in here rather than duplicating this logic
// inline.
//
// Loaded as a plain global-scope <script> (see index.html, loaded
// before app-feed.js/app-chat.js) -- like every other app-*.js file in
// this project, these are plain top-level function declarations, not
// inside any wrapping function, so they're reachable from those files
// the same way. The module.exports branch below only ever runs under
// Node (npm test); a browser has no `module` global, so that branch is
// simply never reached there.

// Should the floating "reopen chat" button be visible? Yes whenever
// there's a real conversation to return to (hasHistory) but nothing on
// screen currently showing it -- either the sheet was never opened, or
// it's open but minimized. Regression this guards: the reopen button
// staying hidden (or shown when it shouldn't be) after a minimize,
// which would strand a visitor with a real conversation and no visible
// way back to it.
function isAskSheetHidden(isOpen, isMinimized) {
  return !isOpen || !!isMinimized;
}

// Should focusing an ask input bring a minimized sheet back up? Only
// when it's genuinely open-but-minimized AND there's history worth
// returning to -- never for a sheet that was never opened (nothing to
// reopen), and never just because it's "open" without checking
// minimized too. Regression this guards directly: an earlier version
// of this exact check only tested `.open`, which stays true even while
// minimized -- so tapping back into the input force-reopened an empty
// sheet with nothing in it, since `.open` alone doesn't mean "has
// visible content right now".
function shouldReopenAskSheetOnFocus(isOpen, isMinimized, historyLength) {
  return !!isOpen && !!isMinimized && historyLength > 0;
}

// Should Escape actually do something? Only for a sheet that's
// genuinely open and NOT already minimized -- pressing Escape on an
// already-minimized (or never-opened) sheet should be a silent no-op,
// not an error or a redundant re-minimize.
function shouldMinimizeOnEscape(isOpen, isMinimized) {
  return !!isOpen && !isMinimized;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { isAskSheetHidden, shouldReopenAskSheetOnFocus, shouldMinimizeOnEscape };
}

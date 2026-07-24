// Flag store for the web fixture — single source of truth for which bugs are active.
//
// Ported from qait-testbed's flag DESIGN (backend/core/flag-store.js), NOT its code.
// Default all-off = the correct clean baseline. Enable exactly one bug per run to
// isolate detection. The server reads flags per-request, so one switch flips a bug
// end-to-end. This is what makes false-green measurement possible: author a test on
// the clean app, flip a flag, re-run — a test that still passes is a false-green.

const KNOWN_FLAGS = [
  // silent-functional (DOM stays intact; only an assertion catches the wrong number)
  'shop.sf2-discount', // omit the 10% discount at checkout → total is wrong-high
  'shop.sf4-qty-increment', // reserved: qty +2 instead of +1 (not wired in v1)
];

const state = new Map(KNOWN_FLAGS.map((id) => [id, false]));

function getFlag(id) {
  return state.get(id) === true;
}

function getAllFlags() {
  return Object.fromEntries(state);
}

// Set one flag. Unknown ids are accepted (forward-compatible) and tracked so GET
// reflects them. Returns the resulting boolean.
function setFlag(id, value) {
  const v = value === true || value === 'true';
  state.set(id, v);
  return v;
}

// Reset everything to the clean baseline (all off).
function resetFlags() {
  for (const id of state.keys()) state.set(id, false);
}

module.exports = { KNOWN_FLAGS, getFlag, getAllFlags, setFlag, resetFlags };

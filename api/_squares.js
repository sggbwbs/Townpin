// Shared square-assignment helper. Previously only lived inside
// create-checkout-session.js (used for "post to additional towns", where
// the buyer never saw that town's board, just typed a name and picked a
// quantity). Now that the whole site moved from a clickable grid to a
// quantity-based model everywhere -- the main purchase flow, and the
// admin "grant free square" and "move to another town" tools -- this is
// pulled out into one place so all three stay consistent rather than
// duplicating (or worse, subtly diverging) the same logic three times.

const { supabase } = require('./_db');

// Picks N random empty squares in a town. Random (not just the first
// empty indices) so everyone doesn't pile into the same top-left corner
// of every board.
async function pickRandomEmptySquares(townId, count) {
  const { data: town, error: townErr } = await supabase.from('towns').select('capacity').eq('id', townId).maybeSingle();
  if (townErr || !town) return [];

  // Deliberately NOT filtered by status. The unique constraint on
  // (town_id, idx) has no status exception -- once ANY row has ever
  // existed at an index, even an expired/cancelled one, that exact index
  // can never be inserted again. Each square's /pin/{id} page is meant to
  // be a stable, permanent URL, so silently handing a used-then-expired
  // index to a completely different business later would also be
  // confusing in its own right -- retiring it for good is the right
  // behavior, not just an artifact of the constraint.
  //
  // Filtering this to only active/pending (as an earlier version did)
  // caused a real bug: as squares churned (cancellations, downsizing,
  // expired prepaid terms), this kept treating those retired indices as
  // "free", repeatedly colliding with the real unique constraint on
  // every single retry attempt -- not a rare race, a guaranteed failure
  // once enough churn had happened in a town. See insertSquaresWithRetry
  // below for where that surfaced as "Could not find available squares
  // after several attempts."
  const { data: taken, error: takenErr } = await supabase
    .from('squares')
    .select('idx')
    .eq('town_id', townId);
  if (takenErr) return [];

  const takenSet = new Set((taken || []).map(r => r.idx));
  let capacity = town.capacity;
  const emptyIndices = [];
  for (let i = 0; i < capacity; i++) { if (!takenSet.has(i)) emptyIndices.push(i); }

  // For maximum growth potential: if there genuinely isn't enough room
  // for what's being requested right now, grow the town's capacity by
  // another full page (100) rather than turning the buyer away or
  // silently granting fewer than they're paying for. More demand for a
  // town should mean more room to sell, not a hard ceiling.
  if (emptyIndices.length < count) {
    const shortfall = count - emptyIndices.length;
    const newCapacity = capacity + Math.ceil(shortfall / 100) * 100;
    const { error: growErr } = await supabase.from('towns').update({ capacity: newCapacity }).eq('id', townId);
    if (!growErr) {
      for (let i = capacity; i < newCapacity; i++) emptyIndices.push(i);
      capacity = newCapacity;
    }
  }

  // shuffle, then take as many as requested (or as many as actually exist)
  for (let i = emptyIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [emptyIndices[i], emptyIndices[j]] = [emptyIndices[j], emptyIndices[i]];
  }
  return emptyIndices.slice(0, count);
}

// Picking empty squares and then inserting them isn't one atomic
// operation -- there's a real (if usually brief) gap between "read
// what's currently taken" and "write the new rows". Two concurrent
// requests (a double-click, a retry, admin + a real customer at the
// same instant) can both read the same "empty" snapshot and pick
// overlapping positions, so the second insert then fails with a
// duplicate-key error on (town_id, idx) -- exactly the bug this fixes.
//
// Rather than just failing outright on that, retry with a fresh pick:
// the second attempt sees the first request's now-completed insert as
// taken, so it naturally picks around it instead of colliding again.
//
// `buildRows(indices)` should return the array of row objects ready to
// insert (indices already filled in) -- callers differ in exactly what
// columns they set (a real purchase includes email/reserved_until/etc,
// a grant is simpler), so row-shape stays their responsibility.
async function insertSquaresWithRetry(townId, count, buildRows, maxAttempts = 4) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const indices = await pickRandomEmptySquares(townId, count);
    if (indices.length < count) {
      return {
        error: indices.length > 0
          ? `Only ${indices.length} free square(s) available in that town right now.`
          : 'No free squares available in that town right now.',
        rows: null
      };
    }

    const { data, error } = await supabase.from('squares').insert(buildRows(indices)).select();
    if (!error) return { error: null, rows: data };

    // 23505 = Postgres unique-violation -- exactly the race condition
    // this function exists to handle. Anything else is a real error,
    // not a "someone else grabbed it first" -- don't retry blindly.
    if (error.code !== '23505') {
      return { error: error.message || error.code || 'Database error.', rows: null };
    }
    // fall through to the next attempt with a fresh pick
  }
  return { error: 'Could not find available squares after several attempts — please try again.', rows: null };
}

module.exports = { pickRandomEmptySquares, insertSquaresWithRetry };

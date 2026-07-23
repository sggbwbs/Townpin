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
  const { data: town, error: townErr } = await supabase.from('towns').select('grid_size').eq('id', townId).maybeSingle();
  if (townErr || !town) return [];

  const { data: taken, error: takenErr } = await supabase
    .from('squares')
    .select('idx')
    .eq('town_id', townId)
    .in('status', ['active', 'pending']);
  if (takenErr) return [];

  const takenSet = new Set((taken || []).map(r => r.idx));
  const total = town.grid_size * town.grid_size;
  const emptyIndices = [];
  for (let i = 0; i < total; i++) { if (!takenSet.has(i)) emptyIndices.push(i); }

  // shuffle, then take as many as requested (or as many as actually exist)
  for (let i = emptyIndices.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [emptyIndices[i], emptyIndices[j]] = [emptyIndices[j], emptyIndices[i]];
  }
  return emptyIndices.slice(0, count);
}

module.exports = { pickRandomEmptySquares };

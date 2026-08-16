// Learns which recurring names (sports teams, venues, recurring series)
// admins keep choosing to feature in the event curation tool, so future
// events mentioning those same names can be auto-selected without
// needing to be manually picked every single time.
//
// Approach: Finnish capitalizes proper nouns (team names, venues) but
// not common words, so consecutive capitalized words are extracted as
// candidate keywords/phrases. A small stopword list excludes words that
// are capitalized purely by sentence-position (e.g. a title starting
// with "Tapahtuma:") rather than because they're an actual proper noun.
//
// Known limitation: Finnish attaches grammatical case endings directly
// onto words (e.g. "JYPin" rather than "JYP" when a team is the object
// of a sentence, not the subject), which this can't correct for without
// a real Finnish morphological analyzer. In practice this mostly affects
// titles phrased as full sentences ("Kärpät kohtaa JYPin") rather than
// the far more common "Team A - Team B" format, where both sides
// naturally appear in their base, uninflected form.

const STOPWORDS = new Set([
  'Tapahtuma', 'Ottelu', 'Konsertti', 'Ilmainen', 'Tervetuloa', 'Katso',
  'Ma', 'Ti', 'Ke', 'To', 'Pe', 'La', 'Su',
]);

function extractKeywords(title) {
  if (!title) return [];
  // Hard breaks on separators that sit between two distinct things in a
  // title (' - ' between two team names, ',' or ':' between a name and
  // a descriptor) -- without this, "Kärpät - Ilves" would merge into a
  // single "Kärpät Ilves" phrase instead of two separately-matchable
  // team names, which is far less useful (Kärpät playing a *different*
  // opponent next week should still match on "Kärpät" alone).
  const segments = title.split(/\s+-\s+|[,:;]/);
  const phrases = [];
  for (const segment of segments) {
    const words = segment.split(/[^A-Za-zÀ-ÖØ-öø-ÿ0-9]+/).filter(Boolean);
    let current = [];
    for (const w of words) {
      const isCapitalized = /^[A-ZÄÖÅ]/.test(w) && w.length >= 2 && !STOPWORDS.has(w);
      if (isCapitalized) {
        current.push(w);
      } else if (current.length > 0) {
        phrases.push(current.join(' '));
        current = [];
      }
    }
    if (current.length > 0) phrases.push(current.join(' '));
  }
  return [...new Set(phrases)];
}

// Called whenever an admin selects events in the curation tool --
// increments each extracted keyword's count, or inserts it fresh at
// count 1. Best-effort: a failure here shouldn't block the actual
// selection the admin just made, so errors are logged, not thrown.
async function recordKeywordSelections(supabase, titles) {
  const allKeywords = new Set();
  titles.forEach(title => extractKeywords(title).forEach(k => allKeywords.add(k)));
  if (allKeywords.size === 0) return;

  for (const keyword of allKeywords) {
    const { data: existing, error: selectErr } = await supabase
      .from('event_keyword_stats').select('select_count').eq('keyword', keyword).maybeSingle();
    if (selectErr) { console.error('Keyword lookup failed (non-fatal):', selectErr); continue; }
    const { error: upsertErr } = await supabase
      .from('event_keyword_stats')
      .upsert({
        keyword,
        select_count: (existing ? existing.select_count : 0) + 1,
        last_selected_at: new Date().toISOString()
      });
    if (upsertErr) console.error('Keyword upsert failed (non-fatal):', upsertErr);
  }
}

// Checks a batch of not-yet-selected events against the learned keyword
// table, marking any whose title contains a keyword that's crossed the
// selection threshold. Only ever adds selections -- never un-selects or
// touches events an admin already explicitly chose or explicitly left
// unchosen, so this can only make the curated list more complete, never
// override a human decision either direction.
async function applyLearnedAutoSelection(supabase, events, threshold = 2) {
  const candidates = events.filter(e => !e.admin_selected);
  if (candidates.length === 0) return;

  const { data: learnedRows, error: learnedErr } = await supabase
    .from('event_keyword_stats').select('keyword').gte('select_count', threshold);
  if (learnedErr) { console.error('Learned keyword lookup failed (non-fatal):', learnedErr); return; }
  if (!learnedRows || learnedRows.length === 0) return;
  const learnedKeywords = new Set(learnedRows.map(r => r.keyword));

  const idsToAutoSelect = candidates
    .filter(e => extractKeywords(e.title_fi).some(k => learnedKeywords.has(k)))
    .map(e => e.id);
  if (idsToAutoSelect.length === 0) return;

  const { error: updateErr } = await supabase
    .from('local_feed_items')
    .update({ admin_selected: true, auto_selected: true })
    .in('id', idsToAutoSelect);
  if (updateErr) {
    console.error('Auto-selection update failed (non-fatal):', updateErr);
    return;
  }
  // Reflect the update in the in-memory array too, since the caller
  // (getEventsSection) uses this same array for its own return value --
  // without this, the function would return stale admin_selected=false
  // for events that were just auto-selected, until the next full fetch.
  events.forEach(e => { if (idsToAutoSelect.includes(e.id)) { e.admin_selected = true; e.auto_selected = true; } });
}

module.exports = { extractKeywords, recordKeywordSelections, applyLearnedAutoSelection };

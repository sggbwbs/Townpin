// Turns a plain-text address into map coordinates using OpenStreetMap's
// Nominatim geocoder -- free, no API key, pairs naturally with an
// OpenStreetMap-tiled map on the frontend. Nominatim's usage policy
// requires a real identifying User-Agent and asks callers not to hammer
// it -- this is only ever called once per address change (checkout,
// grant, edit), never on every page load, so that's naturally respected.
//
// Returns { lat, lng } or null if the address couldn't be resolved --
// callers should treat null as "no pin for this one" rather than an
// error, since a business having an address Nominatim can't find
// shouldn't block the purchase/grant/edit itself.
async function geocodeAddress(address) {
  const trimmed = (address || '').trim();
  if (!trimmed) return null;

  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(trimmed)}`;
    const res = await fetch(url, {
      headers: {
        // Nominatim's usage policy requires a real identifying User-Agent,
        // not a generic/browser one -- see https://operations.osmfoundation.org/policies/nominatim/
        'User-Agent': 'PaikallisCanvas/1.0 (https://www.paikalliscanvas.fi; paikalliscanvas@gmail.com)'
      }
    });
    if (!res.ok) return null;
    const data = await res.json();
    if (!Array.isArray(data) || data.length === 0) return null;

    const lat = parseFloat(data[0].lat);
    const lng = parseFloat(data[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    return { lat, lng };
  } catch (err) {
    console.error('Geocoding failed (non-fatal):', err);
    return null;
  }
}

module.exports = { geocodeAddress };

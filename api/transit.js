const { supabase } = require('./_db');
const { getHelsinkiDayBounds } = require('./_localFeed');

const DIGITRANSIT_API_KEY = process.env.DIGITRANSIT_API_KEY;
const DIGITRANSIT_URL = 'https://api.digitransit.fi/routing/v2/waltti/gtfs/v1';

// Short cache -- departure times genuinely change minute to minute, but
// hitting the live API on every single page view from every visitor is
// wasteful and risks brushing up against Digitransit's misuse-prevention
// limits (see the cost discussion this was built from -- they don't
// publish a hard number, just that limits exist to stop abuse, not
// normal use). 45s keeps the data feeling live without hammering the
// API. Database-backed, not an in-memory Map -- an in-memory cache
// isn't reliable on Vercel serverless, since different requests can
// land on different container instances with no shared memory between
// them, meaning it could miss on most requests instead of actually
// caching anything. Matches the same database-cache pattern already
// used for events/news in _localFeed.js.
const CACHE_TTL_MS = 45 * 1000;

// Rounds coordinates to ~100m precision before using them as a cache
// key -- two nearby requests (e.g. two visitors standing a few meters
// apart) should share one cache entry rather than each triggering their
// own API call.
function cacheKey(lat, lng) {
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

async function queryDigitransit(lat, lng) {
  const query = `
    {
      stopsByRadius(lat: ${lat}, lon: ${lng}, radius: 600) {
        edges {
          node {
            distance
            stop {
              gtfsId
              name
              lat
              lon
              stoptimesWithoutPatterns(numberOfDepartures: 3) {
                scheduledDeparture
                realtimeDeparture
                realtime
                realtimeState
                headsign
                trip { route { shortName } }
              }
            }
          }
        }
      }
    }`;

  const res = await fetch(DIGITRANSIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'digitransit-subscription-key': DIGITRANSIT_API_KEY
    },
    body: JSON.stringify({ query })
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    throw new Error(`Digitransit API error ${res.status}: ${bodyText.slice(0, 300)}`);
  }
  const json = await res.json();
  if (json.errors) {
    throw new Error(`Digitransit GraphQL error: ${JSON.stringify(json.errors).slice(0, 300)}`);
  }
  return json.data;
}

// Digitransit returns departure times as seconds-since-midnight of the
// Finnish service day (can exceed 86400 for trips past midnight, e.g. a
// night bus at 25:30), not a real clock time or timestamp -- this
// converts that into "how many minutes from now", which is what's
// actually useful to show someone waiting at a stop. Uses
// getHelsinkiDayBounds().start as the real UTC instant of Finnish
// midnight -- NOT the server's own local midnight, which would be
// wrong: Vercel functions typically run in UTC, not Finnish time, so a
// naive new Date().setHours(0,0,0,0) would be off by the UTC-Finland
// offset (2-3 hours depending on DST).
function minutesFromNowSecondsSinceMidnight(secondsSinceMidnight) {
  const { start: helsinkiMidnightUtcMs } = getHelsinkiDayBounds();
  const departureUtcMs = helsinkiMidnightUtcMs + secondsSinceMidnight * 1000;
  return Math.round((departureUtcMs - Date.now()) / 60000);
}

function shapeStopsResponse(data) {
  const edges = (data && data.stopsByRadius && data.stopsByRadius.edges) || [];
  return edges
    .map(({ node }) => {
      const departures = (node.stop.stoptimesWithoutPatterns || [])
        .map(st => {
          const seconds = st.realtime ? st.realtimeDeparture : st.scheduledDeparture;
          return {
            route: st.trip.route.shortName,
            headsign: st.headsign,
            minutesUntil: minutesFromNowSecondsSinceMidnight(seconds),
            realtime: !!st.realtime
          };
        })
        // Departures that already passed (e.g. a slightly stale cache
        // entry) shouldn't show as "-1 min" -- just drop them.
        .filter(d => d.minutesUntil >= 0)
        .sort((a, b) => a.minutesUntil - b.minutesUntil);
      return {
        stopId: node.stop.gtfsId,
        name: node.stop.name,
        lat: node.stop.lat,
        lng: node.stop.lon,
        distanceMeters: Math.round(node.distance),
        departures
      };
    })
    // A stop with no upcoming departures at all (service ended for the
    // day, etc.) isn't useful to show.
    .filter(s => s.departures.length > 0)
    .sort((a, b) => a.distanceMeters - b.distanceMeters)
    .slice(0, 4); // closest 4 stops is plenty for a homepage card
}

module.exports = async (req, res) => {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!DIGITRANSIT_API_KEY) {
    // Fails clearly and immediately rather than attempting a request
    // that would just 401 -- lets the frontend show a specific "not
    // set up yet" state instead of a generic error, and means this
    // whole feature starts working the moment the key is added to
    // Vercel's env vars, no code changes or redeploy needed.
    return res.status(200).json({ configured: false, stops: [] });
  }

  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'lat and lng query params are required.' });
  }

  const key = cacheKey(lat, lng);
  const { data: cachedRow } = await supabase
    .from('transit_cache')
    .select('stops, expires_at')
    .eq('cache_key', key)
    .maybeSingle();
  const cacheIsFresh = cachedRow && new Date(cachedRow.expires_at) > new Date();
  if (cacheIsFresh) {
    return res.status(200).json({ configured: true, stops: cachedRow.stops, cached: true });
  }

  try {
    const data = await queryDigitransit(lat, lng);
    const stops = shapeStopsResponse(data);
    await supabase.from('transit_cache').upsert({
      cache_key: key,
      stops,
      expires_at: new Date(Date.now() + CACHE_TTL_MS).toISOString()
    });
    res.status(200).json({ configured: true, stops });
  } catch (err) {
    console.error('Transit fetch failed:', err);
    // Serves a stale cache entry over a hard failure if one exists,
    // even past its normal TTL -- slightly-stale departure times are
    // still far more useful to a visitor than an empty error state,
    // and this only matters when Digitransit itself is having issues.
    if (cachedRow) {
      return res.status(200).json({ configured: true, stops: cachedRow.stops, cached: true, stale: true });
    }
    res.status(502).json({ error: 'Could not load transit data right now.' });
  }
};

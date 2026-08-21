// Same free, keyless Open-Meteo API the weather widget calls
// client-side (see loadWeather in app-chat.js). Extracted here from
// api/ask.js (which originally had its own private copy of this) so
// the daily notification cron (see handleSendDigest in
// api/notifications.js) can reuse the exact same fetch logic and
// weather-code labels, rather than a second, separately-maintained
// copy that could quietly drift out of sync with the AI chat's own
// version over time.
async function fetchCurrentWeather(lat, lng) {
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,weather_code,is_day&daily=temperature_2m_max,precipitation_probability_max,weather_code&timezone=Europe%2FHelsinki&forecast_days=1`);
    clearTimeout(timeout);
    if (!res.ok) return null;
    const data = await res.json();
    if (!data.current || data.current.temperature_2m == null) return null;
    return {
      tempNow: Math.round(data.current.temperature_2m),
      codeNow: data.current.weather_code,
      isDayNow: data.current.is_day !== 0,
      tempMaxToday: data.daily && data.daily.temperature_2m_max ? Math.round(data.daily.temperature_2m_max[0]) : null,
      precipProbToday: data.daily && data.daily.precipitation_probability_max ? data.daily.precipitation_probability_max[0] : null
    };
  } catch (err) {
    return null;
  }
}

// Plain-language WMO weather-code labels -- doesn't need to cover every
// code with the same precision as the widget's icon picker
// (weatherIconSlug in app-chat.js), just enough for a normal sentence.
const WMO_LABELS_FI = {
  0: 'selkeää', 1: 'enimmäkseen selkeää', 2: 'puolipilvistä', 3: 'pilvistä',
  45: 'sumua', 48: 'huurteista sumua',
  51: 'heikkoa tihkusadetta', 53: 'tihkusadetta', 55: 'runsasta tihkusadetta',
  56: 'jäätävää tihkua', 57: 'jäätävää tihkua',
  61: 'heikkoa sadetta', 63: 'sadetta', 65: 'rankkasadetta',
  66: 'jäätävää sadetta', 67: 'jäätävää sadetta',
  71: 'heikkoa lumisadetta', 73: 'lumisadetta', 75: 'runsasta lumisadetta', 77: 'lumijyväsiä',
  80: 'sadekuuroja', 81: 'sadekuuroja', 82: 'rajuja sadekuuroja',
  85: 'lumikuuroja', 86: 'runsaita lumikuuroja',
  95: 'ukkosta', 96: 'ukkosta ja raekuuroja', 99: 'voimakasta ukkosta ja raekuuroja'
};

// Rounded/bucketed on purpose, not the raw API payload -- this feeds
// into buildAskCacheKey (see api/ask.js), and temperature genuinely
// fluctuating by a fraction of a degree between two calls a minute
// apart shouldn't by itself turn an otherwise-identical question into a
// cache miss. Whole degrees plus a same-hour weather code already
// captures anything that would actually change what the model should
// say.
function weatherSummaryText(weather) {
  if (!weather) return null;
  const nowLabel = WMO_LABELS_FI[weather.codeNow] || 'vaihtelevaa säätä';
  let text = `Sää juuri nyt: ${weather.tempNow}°C, ${nowLabel}.`;
  if (weather.tempMaxToday != null) text += ` Tänään ylin lämpötila noin ${weather.tempMaxToday}°C.`;
  if (weather.precipProbToday != null) text += ` Sateen todennäköisyys tänään: ${weather.precipProbToday}%.`;
  return text;
}

// A short, friendly morning-greeting phrasing -- deliberately different
// tone from weatherSummaryText above, which is written as neutral
// context for the AI's own prompt, not as something a person reads
// directly. "Hyvää huomenta! Tänään noin 18°C ja aurinkoista." reads
// like a real morning greeting; the AI-context version above doesn't.
function weatherGreetingText(weather) {
  if (!weather) return null;
  const label = WMO_LABELS_FI[weather.codeNow] || 'vaihtelevaa säätä';
  const temp = weather.tempMaxToday != null ? weather.tempMaxToday : weather.tempNow;
  let text = `Tänään noin ${temp}°C ja ${label}`;
  if (weather.precipProbToday != null && weather.precipProbToday >= 40) {
    text += ` (sateen todennäköisyys ${weather.precipProbToday}%)`;
  }
  text += '.';
  return text;
}

module.exports = { fetchCurrentWeather, WMO_LABELS_FI, weatherSummaryText, weatherGreetingText };

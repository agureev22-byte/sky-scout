// Форматирование на русском: время в часовом поясе места, дни недели, стороны света, числа.

const WEEKDAYS = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
// «ночь на пятницу», «в пятницу»
const WEEKDAYS_ACC = ['воскресенье', 'понедельник', 'вторник', 'среду', 'четверг', 'пятницу', 'субботу'];
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

export function deviceTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function validTimeZone(tz) {
  if (!tz) return null;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return null;
  }
}

// Набор функций форматирования, привязанный к часовому поясу места наблюдения.
export function makeFormatter(timeZone) {
  const tz = validTimeZone(timeZone) || deviceTimeZone();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });

  function fields(ms) {
    const out = {};
    for (const p of parts.formatToParts(new Date(ms))) {
      if (p.type !== 'literal') out[p.type] = Number(p.value);
    }
    if (out.hour === 24) out.hour = 0; // старые движки отдают 24:05 вместо 00:05
    return out;
  }

  function dayIndex(f) {
    return new Date(Date.UTC(f.year, f.month - 1, f.day)).getUTCDay();
  }

  return {
    timeZone: tz,
    fields,
    // «23:40»
    time(ms) {
      const f = fields(ms);
      return `${String(f.hour).padStart(2, '0')}:${String(f.minute).padStart(2, '0')}`;
    },
    // Ключ календарной даты в поясе места: «2026-09-26»
    dateKey(ms) {
      const f = fields(ms);
      return `${f.year}-${String(f.month).padStart(2, '0')}-${String(f.day).padStart(2, '0')}`;
    },
    weekdayIndex(ms) {
      return dayIndex(fields(ms));
    },
    weekday(ms) {
      return WEEKDAYS[dayIndex(fields(ms))];
    },
    weekdayAcc(ms) {
      return WEEKDAYS_ACC[dayIndex(fields(ms))];
    },
    weekdayShort(ms) {
      return WEEKDAYS_SHORT[dayIndex(fields(ms))];
    },
    // «26 сентября»
    dayMonth(ms) {
      const f = fields(ms);
      return `${f.day} ${MONTHS_GEN[f.month - 1]}`;
    },
    // Минуты от полуночи по местному времени
    minutesOfDay(ms) {
      const f = fields(ms);
      return f.hour * 60 + f.minute;
    },
    // Смещение местного времени от UTC в миллисекундах
    offsetMs(ms) {
      const f = fields(ms);
      const wall = Date.UTC(f.year, f.month - 1, f.day, f.hour, f.minute);
      return wall - Math.floor(ms / 60000) * 60000;
    },
    // Округление до шага по местным часам (важно для поясов со смещением 5:45 и т. п.)
    round(ms, stepMin, mode = 'round') {
      const off = this.offsetMs(ms);
      return roundTo(ms + off, stepMin, mode) - off;
    },
  };
}

// Следующий календарный день после ключа «YYYY-MM-DD».
export function nextDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + 1));
  return `${t.getUTCFullYear()}-${String(t.getUTCMonth() + 1).padStart(2, '0')}-${String(t.getUTCDate()).padStart(2, '0')}`;
}

// Русские формы множественного числа: plural(5, 'минута', 'минуты', 'минут') → «минут»
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

// «2 ч 15 мин», «40 мин»
export function duration(ms) {
  const total = Math.round(ms / 60000);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} мин`;
  if (m === 0) return `${h} ч`;
  return `${h} ч ${m} мин`;
}

const DIRECTIONS_8 = [
  { key: 'N', nom: 'север', loc: 'на севере', to: 'на север', short: 'С' },
  { key: 'NE', nom: 'северо-восток', loc: 'на северо-востоке', to: 'на северо-восток', short: 'СВ' },
  { key: 'E', nom: 'восток', loc: 'на востоке', to: 'на восток', short: 'В' },
  { key: 'SE', nom: 'юго-восток', loc: 'на юго-востоке', to: 'на юго-восток', short: 'ЮВ' },
  { key: 'S', nom: 'юг', loc: 'на юге', to: 'на юг', short: 'Ю' },
  { key: 'SW', nom: 'юго-запад', loc: 'на юго-западе', to: 'на юго-запад', short: 'ЮЗ' },
  { key: 'W', nom: 'запад', loc: 'на западе', to: 'на запад', short: 'З' },
  { key: 'NW', nom: 'северо-запад', loc: 'на северо-западе', to: 'на северо-запад', short: 'СЗ' },
];

// Сторона света по азимуту (0° — север, 90° — восток).
export function direction8(azimuth) {
  const a = ((azimuth % 360) + 360) % 360;
  return DIRECTIONS_8[Math.round(a / 45) % 8];
}

// Словесная высота над горизонтом.
export function heightWord(alt) {
  if (alt < 15) return 'низко';
  if (alt < 40) return '';
  if (alt < 70) return 'высоко';
  return 'почти над головой';
}

// Число с запятой: 41.387 → «41,39»
export function decimal(x, digits = 1) {
  return x.toFixed(digits).replace('.', ',').replace('-', '−');
}

export function formatCoords(lat, lon) {
  const ns = lat >= 0 ? 'с. ш.' : 'ю. ш.';
  const ew = lon >= 0 ? 'в. д.' : 'з. д.';
  return `${decimal(Math.abs(lat), 2)}° ${ns}, ${decimal(Math.abs(lon), 2)}° ${ew}`;
}

export function formatTemp(t) {
  const r = Math.round(t);
  if (r === 0) return '0°';
  return r > 0 ? `+${r}°` : `−${Math.abs(r)}°`;
}

export function formatPopulation(p) {
  if (p >= 1e6) return `${decimal(p / 1e6, p >= 1e7 ? 0 : 1)} млн`;
  if (p >= 1e3) return `${Math.round(p / 1e3)} тыс.`;
  return String(p);
}

// Округление момента времени до шага (в минутах).
export function roundTo(ms, stepMin, mode = 'round') {
  const step = stepMin * 60000;
  const fn = mode === 'ceil' ? Math.ceil : mode === 'floor' ? Math.floor : Math.round;
  return fn(ms / step) * step;
}

export function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

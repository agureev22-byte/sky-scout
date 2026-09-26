// Тексты карточек объектов: высота, азимут, восход/заход, расстояние, пролёты спутников.

import * as A from '../../vendor/astronomy.js';
import { direction8, decimal, plural } from '../format.js';
import { starName, starDesignation } from './scene.js';

const KM_PER_AU = 149597870.7;
const DAY = 86400000;

export function dayLabel(fmt, ms, now) {
  const key = fmt.dateKey(ms);
  if (key === fmt.dateKey(now)) return 'сегодня';
  if (key === fmt.dateKey(now + DAY)) return 'завтра';
  if (key === fmt.dateKey(now - DAY)) return 'вчера';
  return `${fmt.weekdayShort(ms)}, ${fmt.dayMonth(ms)}`;
}

export function whenText(fmt, ms, now) {
  return `${dayLabel(fmt, ms, now)} в ${fmt.time(ms)}`;
}

export function altText(alt) {
  const a = Math.round(alt);
  if (alt < -0.5) return `под горизонтом (−${Math.abs(a)}°)`;
  return `${Math.max(0, a)}° над горизонтом`;
}

export function azText(az) {
  const d = direction8(az);
  return `${Math.round(az) % 360}° — ${d.nom}`;
}

// «33° над горизонтом, юго-восток (116°)» — высота и азимут одной строкой.
export function positionText(alt, az) {
  return `${altText(alt)}, ${direction8(az).nom} (${Math.round(az) % 360}°)`;
}

export function kmText(km) {
  return `${Math.round(km).toLocaleString('ru-RU')} км`;
}

function auText(au) {
  const mkm = (au * KM_PER_AU) / 1e6;
  const minutes = (au * KM_PER_AU) / 299792.458 / 60;
  const light = minutes < 60
    ? `${Math.round(minutes)} ${plural(Math.round(minutes), 'минута', 'минуты', 'минут')}`
    : `${Math.floor(minutes / 60)} ч ${Math.round(minutes % 60)} мин`;
  return `${decimal(au, au < 10 ? 2 : 1)} а. е. (${decimal(mkm, mkm < 100 ? 1 : 0)} млн км), свет идёт ${light}`;
}

function magText(m) {
  return decimal(m, 1);
}

// Восход, заход и кульминация для тела astronomy-engine (в том числе пользовательской «звезды»).
function riseSetRows(body, observer, now, fmt, currentAlt) {
  const rows = [];
  const start = new Date(now - 60000);
  const rise = A.SearchRiseSet(body, observer, +1, start, 1.2);
  const set = A.SearchRiseSet(body, observer, -1, start, 1.2);
  if (!rise && !set) {
    rows.push(['Восход, заход', currentAlt > 0 ? 'не заходит в эти сутки' : 'не восходит в эти сутки']);
  } else {
    const ev = [];
    if (rise) ev.push([rise.date.getTime(), 'восход']);
    if (set) ev.push([set.date.getTime(), 'заход']);
    ev.sort((a, b) => a[0] - b[0]);
    const text = ev.map(([t, label]) => `${label} ${whenText(fmt, t, now)}`).join(', ');
    rows.push([ev[0][1] === 'восход' ? 'Восход, заход' : 'Заход, восход', text]);
  }
  try {
    const culm = A.SearchHourAngle(body, observer, 0, start, +1);
    if (culm && culm.time.date.getTime() - now < 1.1 * DAY) {
      const alt = culm.hor.altitude;
      rows.push(['Выше всего', `${whenText(fmt, culm.time.date.getTime(), now)}, ${Math.round(alt)}°`]);
    }
  } catch {
    /* не у всех тел есть кульминация в пределах суток — не страшно */
  }
  return rows;
}

function constellationOf(cat, raHours, dec) {
  try {
    const c = A.Constellation(raHours, dec);
    const item = cat && cat.conById.get(c.symbol);
    return item ? item.name : c.name;
  } catch {
    return null;
  }
}

const MOON_PHASES = [
  [10, 'новолуние'], [80, 'растущий серп'], [100, 'первая четверть'], [170, 'растущая Луна'],
  [190, 'полнолуние'], [260, 'убывающая Луна'], [280, 'последняя четверть'], [350, 'убывающий серп'], [361, 'новолуние'],
];

const BODY_KIND = { sun: 'Звезда, центр Солнечной системы', moon: 'Спутник Земли', planet: 'Планета' };

export function bodyCard(sky, b, fmt, now, cat) {
  const rows = [];
  rows.push(['Высота, азимут', positionText(b.alt, b.az)]);
  rows.push(...riseSetRows(b.body, sky.observer, now, fmt, b.alt));
  if (b.kind === 'moon') {
    const name = MOON_PHASES.find(([lim]) => (b.elongation ?? 0) < lim)[1];
    rows.push(['Фаза', `${name}, освещена на ${Math.round((b.illum ?? 0) * 100)}%`]);
    rows.push(['Расстояние', kmText(b.distKm)]);
  } else if (b.kind === 'sun') {
    rows.push(['Расстояние', `${decimal(b.distKm / 1e6, 1)} млн км, свет идёт 8 минут`]);
  } else {
    rows.push(['Расстояние', auText(b.distAU)]);
  }
  if (Number.isFinite(b.mag) && b.kind !== 'sun') rows.push(['Блеск', `${magText(b.mag)} зв. вел.`]);
  let where = null;
  if (b.kind === 'planet' || b.kind === 'moon') {
    const eq = A.Equator(b.body, new Date(now), sky.observer, false, true);
    where = constellationOf(cat, eq.ra, eq.dec);
    if (where) rows.push(['Созвездие', where]);
  }
  const note = b.kind === 'sun' ? 'Никогда не смотрите на Солнце без специального фильтра.' : null;
  return { title: b.name, subtitle: BODY_KIND[b.kind], rows, note };
}

export function starCard(sky, cat, i, fmt, now) {
  const name = starName(cat, i);
  const desig = starDesignation(cat, i);
  const h = cat.hip[i];
  const enu = sky.starEnu;
  const u = enu[3 * i + 2];
  const alt = (Math.asin(Math.max(-1, Math.min(1, u))) * 180) / Math.PI;
  let az = (Math.atan2(enu[3 * i], enu[3 * i + 1]) * 180) / Math.PI;
  if (az < 0) az += 360;
  const rows = [['Высота, азимут', positionText(alt, az)]];
  const dist = cat.dist[h];
  A.DefineStar(A.Body.Star3, cat.ra[i] / 15, cat.dec[i], dist || 1000);
  rows.push(...riseSetRows(A.Body.Star3, sky.observer, now, fmt, alt));
  if (dist) rows.push(['Расстояние', `≈ ${dist >= 100 ? Math.round(dist).toLocaleString('ru-RU') : decimal(dist, 1)} св. лет`]);
  rows.push(['Блеск', `${magText(cat.mag[i])} зв. вел.`]);
  const cons = constellationOf(cat, cat.ra[i] / 15, cat.dec[i]);
  if (cons) rows.push(['Созвездие', cons]);
  return {
    title: name || desig || `HIP ${h}`,
    subtitle: name && desig ? `Звезда ${desig}` : 'Звезда',
    rows,
    note: null,
  };
}

// «моложе суток», «1,4 дня назад», «12 дней назад»
export function ageText(days) {
  if (days < 1) return 'моложе суток';
  if (days < 10 && Math.abs(days - Math.round(days)) >= 0.05) return `${decimal(days, 1)} дня назад`;
  const n = Math.round(days);
  return `${n} ${plural(n, 'день', 'дня', 'дней')} назад`;
}

export function passText(p, fmt, now) {
  const from = direction8(p.rise.az).short;
  const to = direction8(p.set.az).short;
  const mins = Math.max(1, Math.round((p.set.t - p.rise.t) / 60000));
  return {
    when: `${dayLabel(fmt, p.rise.t, now)}, ${fmt.time(p.rise.t)}–${fmt.time(p.set.t)}`,
    path: `${from} → ${to}, выше всего ${Math.round(p.max.alt)}° в ${fmt.time(p.max.t)}, ${mins} мин`,
    visible: p.visible,
  };
}

export function satCard(sat, pos, fmt, now, { passes = null, ageDays = null, groupTitle = '' } = {}) {
  const rows = [];
  if (pos) {
    rows.push(['Высота, азимут', positionText(pos.alt, pos.az)]);
    rows.push(['Расстояние', `${kmText(pos.rangeKm)} от вас; летит в ${kmText(pos.heightKm)} над Землёй со скоростью ${decimal(pos.speedKmS, 1)} км/с`]);
    rows.push(['Освещение', pos.sunlit ? 'освещён Солнцем' : 'в тени Земли']);
  } else {
    rows.push(['Положение', 'не удалось рассчитать — орбита устарела']);
  }
  if (ageDays !== null) rows.push(['Орбита от', ageText(ageDays)]);
  let note = null;
  if (pos && pos.alt > 0) {
    note = pos.sunlit
      ? 'Сейчас над горизонтом и освещён: если небо тёмное, виден как движущаяся звезда.'
      : 'Сейчас над горизонтом, но в тени Земли — глазом не виден.';
  }
  if (ageDays !== null && ageDays > 14) note = `${note ? `${note} ` : ''}Орбита давно не обновлялась — положение может быть неточным.`;
  return {
    title: sat.name,
    subtitle: `Спутник · ${groupTitle || 'NORAD'} · № ${sat.id}`,
    rows,
    note,
    passes: passes ? passes.map((p) => passText(p, fmt, now)) : null,
  };
}

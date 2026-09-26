// Вердикт человеческим языком: стоит ли выходить сегодня, а если нет — когда.

import * as I from './intervals.js';
import { HOUR, MIN } from './intervals.js';
import { nextMoonPhases, sunAltitude, nextSunBelow, nextSunset } from './astro.js';
import { valueAt } from './weather.js';
import { objectsForNight, CLEAR, PARTLY } from './nights.js';
import {
  capitalize as cap, direction8, heightWord, plural, formatTemp, formatPopulation, nextDateKey, duration,
} from './format.js';

const round5 = (x) => Math.round(x / 5) * 5;
const pct = (x) => `${Math.round(x * 100)}%`;

const PLANET_NOTES = {
  venus: 'самая яркая «звезда» на небе',
  jupiter: 'ярче любой звезды, в бинокль видны спутники',
  mars: 'красноватая яркая точка',
  saturn: 'желтоватая точка, кольца видны в любой телескоп',
  mercury: 'низко в сумерках, найти непросто',
};

const MW_QUALITY = {
  good: 'хорошо видно глазом',
  visible: 'видно глазом',
  faint: 'глазом еле заметно, камера покажет хорошо',
  camera: 'глазом почти не видно — только на камеру',
};

export function buildVerdict({ result, now, fmt, light = null, weather = null }) {
  const { nights, observer, ctx } = result;
  const n0 = nights[0];
  const todayKey = fmt.dateKey(now);

  // ---- мелкие помощники, замкнутые на часовой пояс места ----
  const minute = (ms) => Math.round(ms / MIN) * MIN;
  const at = (ms, cause) => fmt.time(cause === 'clouds' ? fmt.round(ms, 10) : minute(ms));
  const startText = (w) => at(w.start, w.startCause);
  const endText = (w) => at(w.end, w.endCause);
  const range = (w) => `${startText(w)}–${endText(w)}`;
  const t = (ms) => fmt.time(minute(ms));

  // После полуночи «завтра» двусмысленно — тогда называем дни недели.
  const afterMidnight = fmt.dateKey(n0.evening) !== todayKey;

  function nightName(n) {
    const key = fmt.dateKey(n.evening);
    if (n.index === 0) return afterMidnight ? 'этой ночью' : 'сегодня';
    if (!afterMidnight && key === nextDateKey(todayKey)) return 'завтра';
    return fmt.weekday(n.evening);
  }

  // «сегодня», «завтра» или «10 октября»
  function dayText(ms) {
    const key = fmt.dateKey(ms);
    if (key === todayKey) return 'сегодня';
    if (key === nextDateKey(todayKey)) return 'завтра';
    return fmt.dayMonth(ms);
  }

  // «четверг, 23:40–02:10» или «ночь на пятницу, 01:30–04:00»
  function whenText(n, w) {
    const startsAfterMidnight = fmt.dateKey(w.start) !== fmt.dateKey(n.evening);
    const label = startsAfterMidnight && n.index > 0 ? `ночь на ${fmt.weekdayAcc(w.start)}` : nightName(n);
    return `${label}, ${range(w)}`;
  }

  const moonUpIn = (n, w) => I.totalLength(I.intersect(n.moon.upFull, [w]));
  const moonName = (n) => (n.moon.illum >= 0.95 ? 'полная Луна' : `Луна (${pct(n.moon.illum)})`);

  function cloudWord(stats) {
    if (!stats) return 'небо ясное';
    const thinHigh = stats.highAvg !== null && stats.highAvg >= 40 && (stats.lowAvg ?? 0) <= 15 && (stats.midAvg ?? 0) <= 15;
    if (thinHigh && stats.cloudAvg > 10) return 'лёгкая дымка высоких облаков';
    if (stats.cloudAvg <= 10) return 'небо ясное';
    if (stats.cloudAvg <= 20) return 'почти ясно';
    return 'небольшая облачность';
  }

  function moonPhraseForWindow(n, w) {
    if (w.startCause === 'moonset') return `Луна зайдёт в ${startText(w)}`;
    if (w.endCause === 'moonrise') return `Луна взойдёт в ${endText(w)}`;
    if (moonUpIn(n, w) > 0 && n.moon.illum >= 0.03) return 'тонкий серп Луны не помешает';
    return 'Луна не помешает';
  }

  // ---- сегодняшняя ночь ----
  function tonight(n) {
    const w = n.window;
    const inW = w && now >= w.start && now < w.end;
    const who = inW ? 'Сейчас' : cap(nightName(n));
    const lines = [];
    let tone;
    let headline;

    switch (n.rating) {
      case 'great': {
        tone = 'yes';
        const tail = w.endCause === 'moonrise' || w.endCause === 'clouds' ? ` до ${endText(w)}` : '';
        if (inW) headline = `Сейчас — да, до ${endText(w)}.`;
        else headline = `${who} — да${w.startCause === 'now' ? '' : `, с ${startText(w)}`}${tail}.`;
        const parts = [];
        parts.push(w.startCause === 'clouds' && !inW ? `облака разойдутся к ${startText(w)}` : cloudWord(n.statsWindow));
        if (w.startCause === 'moonset' && !inW) parts.push(`Луна зайдёт в ${startText(w)}`);
        if (w.endCause === 'moonrise') parts.push(`в ${endText(w)} взойдёт Луна`);
        if (w.endCause === 'clouds') parts.push(`после ${endText(w)} затянет облаками`);
        if (w.startCause !== 'moonset' && w.endCause !== 'moonrise') parts.push(moonPhraseForWindow(n, w));
        lines.push(`${cap(parts.join(', '))}.`);
        const around = n.clearAround;
        if (w.startCause === 'moonset' && !inW && around && around.start < w.start - 30 * MIN) {
          lines.push(`До этого светит ${moonName(n)} — время для Луны и планет.`);
        }
        if (w.endCause === 'forecast-end') lines.push('Дальше прогноз пока не заглядывает.');
        break;
      }
      case 'good': {
        tone = 'moon';
        if (n.reason === 'moon') {
          headline = `${who} — да, но мешает Луна.`;
          const share = moonUpIn(n, w) / I.length(w);
          const set = n.moon.upFull.find((i) => i.end > w.start && i.end < w.end);
          const rise = n.moon.upFull.find((i) => i.start > w.start && i.start < w.end);
          let moon;
          if (share > 0.9) moon = `${moonName(n)} светит ${I.length(w) > 0.8 * n.obsMs ? 'всю ночь' : 'всё это время'}`;
          else if (set) moon = `${moonName(n)} зайдёт только в ${t(set.end)}`;
          else if (rise) moon = `в ${t(rise.start)} взойдёт ${moonName(n)}`;
          else moon = `светит ${moonName(n)}`;
          const clearFrom = w.startCause === 'clouds' && !inW ? ` с ${startText(w)}` : '';
          lines.push(`Небо ясное${clearFrom}, но ${moon}.`);
          lines.push('Хорошо видны Луна, планеты и яркие звёзды, а Млечный Путь и слабые звёзды — нет.');
        } else if (n.reason === 'twilight') {
          headline = `${who} — да, но небо не стемнеет до конца.`;
          const deg = Math.round(-n.sun.min);
          lines.push(
            n.sun.min > -12
              ? `Белые ночи: Солнце опускается всего на ${deg}° под горизонт, небо остаётся светлым.`
              : `Полной темноты не будет: Солнце опускается лишь на ${deg}° под горизонт.`,
          );
          lines.push('Видны Луна, планеты и яркие звёзды; Млечного Пути не будет.');
        } else {
          headline = inW ? `Сейчас — да, до ${endText(w)}.` : `${who} — ненадолго, ${range(w)}.`;
          const parts = [];
          if (w.startCause === 'clouds' && !inW) parts.push(`облака разойдутся к ${startText(w)}`);
          if (w.endCause === 'clouds') parts.push(`после ${endText(w)} снова затянет`);
          if (!parts.length) parts.push('ясно только в сумерках, к полной темноте затянет облаками');
          lines.push(`${cap(parts.join(', '))}.`);
        }
        break;
      }
      case 'maybe': {
        tone = 'maybe';
        if (inW) headline = 'Сейчас — возможно, в просветах.';
        else {
          const from = w.startCause === 'clouds' ? `, с ${startText(w)}` : '';
          const to = w.endCause === 'clouds' ? ` до ${endText(w)}` : '';
          headline = `${who} — возможно${from}${to}.`;
        }
        const avg = n.statsWindow ? round5(n.statsWindow.cloudAvg) : null;
        lines.push(`Переменная облачность${avg !== null ? `, около ${avg}%` : ''}: звёзды и планеты будут видны в просветах.`);
        if (n.moon.bright && moonUpIn(n, w) > 0.5 * I.length(w)) lines.push(`Вдобавок светит ${moonName(n)}.`);
        break;
      }
      case 'bad': {
        tone = 'no';
        headline = `${who} — нет.`;
        const s = n.statsNight;
        const avg = s ? s.cloudAvg : 100;
        const until = n.index === 0 && I.find(n.obsFull, now) ? 'до утра' : 'всю ночь';
        let line = avg >= 85 ? `Сплошная облачность ${until}` : `Облачно ${until}, около ${round5(avg)}%`;
        if (s && s.precipMax !== null && s.precipMax >= 60) line += ', возможен дождь';
        lines.push(`${line}.`);
        const gap = n.windows.clear || n.windows.partly;
        if (gap && I.length(gap) >= 15 * MIN) {
          lines.push(`Короткий просвет ${range(gap)} — если очень повезёт.`);
        }
        break;
      }
      case 'nodark': {
        tone = 'no';
        headline = `${cap(nightName(n))} темно не будет.`;
        const deg = Math.max(0, Math.round(-n.sun.min));
        lines.push(
          n.sun.min > -0.833
            ? 'Полярный день: Солнце не заходит за горизонт.'
            : `Белые ночи: Солнце опускается под горизонт всего на ${deg}°, небо остаётся светлым.`,
        );
        break;
      }
      default: {
        // unknown — прогноза облачности нет
        tone = 'unknown';
        headline = 'Прогноза облачности нет.';
        if (w) {
          const moon = n.moon.bright && moonUpIn(n, w) > 0.5 * I.length(w)
            ? `, но будет светить ${moonName(n)}`
            : `, ${moonPhraseForWindow(n, w)}`;
          lines.push(`Если будет ясно — ${nightName(n)} лучше всего ${range(w)}${moon}.`);
        }
      }
    }
    return { tone, headline, lines };
  }

  // ---- что будет видно ----
  function pointAt(o, ms) {
    let best = o.points[0];
    for (const p of o.points) if (Math.abs(p.t - ms) < Math.abs(best.t - ms)) best = p;
    return best;
  }

  function bestInWindow(o, w) {
    let best = null;
    for (const p of o.points) if (p.t >= w.start - 5 * MIN && p.t <= w.end + 5 * MIN && (!best || p.alt > best.alt)) best = p;
    return best && best.alt >= o.minAlt ? best : null;
  }

  function objectLine(o) {
    const b = o.best;
    const dir = direction8(b.az);
    const h = heightWord(b.alt);
    if (o.kind === 'moon') {
      const bits = [`${o.info.name}, ${pct(o.info.illum)}`];
      if (o.rise && o.rise > o.span.start + 10 * MIN) bits.push(`взойдёт в ${t(o.rise)}`);
      if (o.set && o.set < o.span.end - 10 * MIN) bits.push(`зайдёт в ${t(o.set)}`);
      bits.push(`выше всего около ${t(b.t)} ${dir.loc}`);
      return bits.join(', ');
    }
    if (o.kind === 'milkyway') {
      const bits = [`${dir.loc}${h ? `, ${h}` : ''}, лучше всего около ${t(b.t)}`];
      if (o.set && o.set < o.span.end) bits.push(`зайдёт в ${t(o.set)}`);
      if (o.quality && MW_QUALITY[o.quality]) bits.push(MW_QUALITY[o.quality]);
      return bits.join('; ');
    }
    const note = PLANET_NOTES[o.id];
    const rises = o.rise && o.rise > o.span.start + 10 * MIN;
    const sets = o.set && o.set < o.span.end - 10 * MIN && (!o.rise || o.set > o.rise);
    const peakAtStart = b.t <= o.span.start + 20 * MIN;
    let where;
    if (rises) {
      const risen = o.points.find((p) => p.t >= o.rise && p.alt >= 0) || o.first;
      where = `взойдёт в ${t(o.rise)} ${direction8(risen.az).loc}, к ${t(b.t)} поднимется на ${Math.round(b.alt)}° ${dir.loc}`;
    } else if (sets && peakAtStart) {
      const h0 = heightWord(o.first.alt);
      where = `${direction8(o.first.az).loc}${h0 ? `, ${h0}` : ''}, зайдёт в ${t(o.set)}`;
    } else {
      where = `${dir.loc}, выше всего около ${t(b.t)} (${Math.round(b.alt)}°)`;
      if (sets) where += `, зайдёт в ${t(o.set)}`;
    }
    return note ? `${where}. ${cap(note)}` : where;
  }

  function objectsView(n) {
    if (!n || !n.window || n.rating === 'bad' || n.rating === 'nodark') return { summary: null, list: [] };
    const objs = objectsForNight(ctx, n, light);
    const w = n.window;
    const inWindow = objs.map((o) => ({ o, p: bestInWindow(o, w) })).filter((x) => x.p);
    // В сводку: Луна (если мешает), самые яркие планеты и Млечный Путь — не больше трёх.
    const mw = inWindow.find((x) => x.o.kind === 'milkyway');
    let top = inWindow.filter((x) => x.o.kind !== 'milkyway' && !(x.o.kind === 'moon' && !n.moon.bright));
    top = top.slice(0, mw ? 2 : 3);
    if (mw) top.push(mw);
    const summary = top.length
      ? `${top.map(({ o, p }) => `${o.kind === 'milkyway' ? 'Млечный Путь' : o.name} ${direction8(p.az).loc}`).join(', ')}.`
      : null;
    return {
      summary,
      list: objs.map((o) => ({
        id: o.id,
        kind: o.kind,
        name: o.name,
        text: objectLine(o),
        angle: o.kind === 'moon' ? o.info.angle : undefined,
      })),
    };
  }

  // ---- ближайшая хорошая ночь ----
  function nextView() {
    if (n0.rating === 'great') return null;
    const rest = nights.slice(1);
    const g = rest.find((n) => n.rating === 'great');
    if (g) {
      const w = g.window;
      const s = g.statsWindow;
      const forecast = !s || s.cloudAvg <= 10 ? 'прогноз ясный' : s.cloudAvg <= 20 ? 'почти ясно' : 'небольшая облачность';
      const title = n0.rating === 'good' && n0.reason === 'moon' ? 'Ближайшая тёмная ночь без Луны' : 'Ближайшая хорошая ночь';
      return {
        title,
        when: whenText(g, w),
        text: `${cap(moonPhraseForWindow(g, w))}, ${forecast}.`,
        note: g.index >= 4 ? 'Прогноз так далеко вперёд ещё может измениться.' : null,
        index: g.index,
      };
    }
    const c = rest.find((n) => n.rating === 'good');
    if (c && !(n0.rating === 'good')) {
      return {
        title: 'Ближайшая ясная ночь',
        when: whenText(c, c.window),
        text: c.reason === 'moon' ? `Но будет мешать ${moonName(c)}.` : c.reason === 'twilight' ? 'Но небо не стемнеет до конца.' : 'Но ясно будет недолго.',
        note: c.index >= 4 ? 'Прогноз так далеко вперёд ещё может измениться.' : null,
        index: c.index,
      };
    }
    if (nights.every((n) => !n.sun.deepLimit)) {
      // Белые ночи или полярный день: говорим, когда вернётся настоящая темнота.
      const from = nights[nights.length - 1].end;
      const sunset = n0.sun.min > -0.833 ? nextSunset(observer, now) : null;
      const dark = nextSunBelow(observer, from, -15);
      if (!dark) return null;
      return {
        title: 'Когда стемнеет по-настоящему',
        when: null,
        text: `${sunset ? `Солнце начнёт заходить ${dayText(sunset)}. ` : ''}Полная темнота вернётся ${dayText(dark)}.`,
        note: null,
        index: null,
      };
    }
    const known = nights.filter((n) => n.coverage !== 'none').length;
    const phases = nextMoonPhases(now);
    if (!known) return null;
    return {
      title: n0.rating === 'good' ? 'Тёмных ясных ночей не видно' : 'Ясных ночей не видно',
      when: null,
      text: `По прогнозу на ${known} ${plural(known, 'ночь', 'ночи', 'ночей')} вперёд ${n0.rating === 'good' ? 'ясной ночи без Луны' : 'ясного неба'} нет.`,
      note: phases.new ? `Новолуние — ${dayText(phases.new)}: если в те дни прояснится, небо будет самым тёмным.` : null,
      index: null,
    };
  }

  // ---- строка «что сейчас» ----
  function statusLine() {
    const alt = result.sunAltNow;
    const ev = n0.events;
    const obsStart = n0.obsFull.find((i) => i.start > now);
    if (alt > -0.833) {
      if (n0.rating === 'nodark' && ev.sunset === null) return 'Сейчас светло. Солнце сегодня не зайдёт.';
      let s = 'Сейчас светло.';
      if (ev.sunset && ev.sunset > now) s += ` Закат в ${t(ev.sunset)}${obsStart ? `, стемнеет к ${t(obsStart.start)}` : ''}.`;
      return s;
    }
    const inObs = I.find(n0.obsFull, now);
    if (inObs) {
      if (ev.sunrise && ev.sunrise > now) return `Сейчас темно. Рассвет в ${t(ev.sunrise)}.`;
      return 'Сейчас темно.';
    }
    if (obsStart) return `${n0.sun.max < -0.833 ? 'Полярная ночь, сейчас сумерки' : 'Сумерки'}. Стемнеет к ${t(obsStart.start)}.`;
    if (ev.sunrise && ev.sunrise > now) return `Светает. Восход в ${t(ev.sunrise)}.`;
    return 'Сумерки.';
  }

  // ---- почасовая лента сегодняшней ночи ----
  function timeline(n) {
    const from = n.events.sunset && n.events.sunset > n.start ? n.events.sunset : n.obsFull[0] ? n.obsFull[0].start - HOUR : null;
    const to = n.events.sunrise ? n.events.sunrise : n.obsFull.length ? n.obsFull[n.obsFull.length - 1].end + HOUR : null;
    if (from === null || to === null || to <= from) return null;
    let start = fmt.round(Math.max(from, n.index === 0 ? Math.min(now, to - 4 * HOUR) : from), 60, 'floor');
    let end = fmt.round(to, 60, 'ceil');
    if ((end - start) / HOUR > 16) {
      const mid = n.obsFull[0] ? (n.obsFull[0].start + n.obsFull[0].end) / 2 : (start + end) / 2;
      start = fmt.round(mid - 8 * HOUR, 60, 'floor');
      end = start + 16 * HOUR;
    }
    const cells = [];
    for (let h = start; h < end; h += HOUR) {
      const mid = h + HOUR / 2;
      const sun = sunAltitude(observer, mid);
      const light = sun > -0.833 ? 'day' : sun > -12 ? 'twilight' : sun > -18 ? 'dark' : 'deep';
      const cloud = ctx.hours ? valueAt(ctx.hours, 'cloud', mid) : null;
      const moon = !!I.find(n.moon.upFull, mid);
      let q;
      if (light === 'day') q = 'day';
      else if (cloud === null) q = 'unknown';
      else if (cloud > PARTLY) q = 'bad';
      else if (cloud > CLEAR) q = 'maybe';
      else if (light === 'twilight' || (moon && n.moon.bright)) q = 'good';
      else q = 'great';
      cells.push({
        t: h,
        label: fmt.time(h).slice(0, 2),
        light,
        cloud: cloud === null ? null : Math.round(cloud),
        moon,
        quality: q,
        now: now >= h && now < h + HOUR,
      });
    }
    return { cells, moonBright: n.moon.bright };
  }

  // ---- карточки факторов ----
  function cloudSummary(n) {
    if (!n.statsNight) return 'Прогноза облачности на эту ночь нет.';
    const clearList = n.clearIntervals;
    const covered = I.totalLength(clearList);
    if (covered >= 0.9 * n.obsMs) return 'Ясно всю ночь.';
    if (!clearList.length) {
      if (n.statsNight.cloudAvg >= 85) return 'Сплошная облачность всю ночь.';
      if (n.statsNight.cloudAvg <= PARTLY) return 'Переменная облачность всю ночь, ясных промежутков нет.';
      return 'Облачно всю ночь, ясных промежутков нет.';
    }
    const items = clearList.slice(0, 3).map((i) => `${fmt.time(fmt.round(i.start, 10))}–${fmt.time(fmt.round(i.end, 10))}`);
    return `Ясно: ${items.join(', ')}.`;
  }

  function factors(n) {
    const out = [];
    const s = n.statsNight;
    if (n.rating !== 'nodark') out.push({
      id: 'clouds',
      title: 'Облачность',
      value: s ? `${round5(s.cloudAvg)}%` : '—',
      text: cloudSummary(n),
    });
    const phases = nextMoonPhases(now);
    const moonBits = [];
    const up = n.moon.upFull;
    const moonEvents = [];
    if (n.events.moonrise) moonEvents.push([n.events.moonrise, `восход в ${t(n.events.moonrise)}`]);
    if (n.events.moonset) moonEvents.push([n.events.moonset, `заход в ${t(n.events.moonset)}`]);
    moonEvents.sort((a, b) => a[0] - b[0]).forEach(([, text]) => moonBits.push(text));
    if (!up.length) moonBits.push('всю ночь под горизонтом');
    else if (I.totalLength(up) >= n.end - n.start - MIN) moonBits.push('всю ночь над горизонтом');
    const next = [];
    const phaseList = [];
    if (phases.new) phaseList.push([phases.new, `новолуние — ${dayText(phases.new)}`]);
    if (phases.full) phaseList.push([phases.full, `полнолуние — ${dayText(phases.full)}`]);
    phaseList.sort((a, b) => a[0] - b[0]).forEach(([, text]) => next.push(text));
    out.push({
      id: 'moon',
      title: 'Луна',
      value: pct(n.moon.illum),
      text: `${cap(n.moon.name)}${moonBits.length ? `: ${moonBits.join(', ')}` : ''}. ${cap(next.join(', '))}.`,
      phase: n.moon.angle,
    });
    const dark = [];
    if (n.events.sunset) dark.push(`закат ${t(n.events.sunset)}`);
    if (n.obsFull[0] && n.sun.obsLimit === -12) dark.push(`звёзды с ${t(n.obsFull[0].start)}`);
    if (n.deepFull[0] && n.sun.deepLimit === -18) {
      const d = n.deepFull[0];
      dark.push(`полная темнота ${t(d.start)}–${t(d.end)}`);
    }
    if (n.events.sunrise) dark.push(`восход ${t(n.events.sunrise)}`);
    let darkValue = n.obsFull[0] ? duration(I.totalLength(n.deepFull.length ? n.deepFull : n.obsFull)) : 'нет';
    if (n.sun.min > -0.833) darkValue = 'нет';
    out.push({
      id: 'dark',
      title: 'Темнота',
      value: darkValue,
      text: dark.length ? `${cap(dark.join(' · '))}.` : n.sun.min > -0.833 ? 'Полярный день — Солнце не заходит.' : 'Солнце всю ночь неглубоко под горизонтом.',
    });
    if (light) {
      let src = '';
      if (light.main && light.bortle >= 3) {
        const m = light.main;
        src = m.distanceKm <= 3
          ? ` Вы в черте города ${m.name}.`
          : ` Главный источник — ${m.name} (${formatPopulation(m.population)} жителей), ${m.distanceKm} км ${direction8(m.bearingDeg).to}.`;
      }
      out.push({
        id: 'light',
        title: 'Засветка',
        value: `${light.bortle} из 9`,
        text: `${light.description}${src} Оценка приблизительная: по числу жителей ближайших городов, без учёта рельефа.`,
      });
    }
    if (s && s.tempMin !== null) {
      const bits = [];
      const tmin = formatTemp(s.tempMin);
      const tmax = formatTemp(s.tempMax);
      bits.push(tmin === tmax ? `около ${tmin}` : `от ${tmax} до ${tmin}`);
      if (s.windMax !== null) bits.push(`ветер до ${Math.round(s.windMax)} м/с`);
      if (s.humidityMax !== null) bits.push(`влажность до ${Math.round(s.humidityMax)}%`);
      out.push({ id: 'weather', title: 'Погода ночью', value: tmin, text: `${cap(bits.join(', '))}.` });
    }
    return out;
  }

  function notes(n) {
    const out = [];
    if (!['great', 'good', 'maybe'].includes(n.rating)) return out;
    if (light && n.rating === 'great') {
      if (light.milkyWay === 'none') out.push('Вы в городе — Млечного Пути отсюда не видно. Чтобы его увидеть, нужно отъехать туда, где темнее.');
      else if (light.milkyWay === 'camera') out.push('Засветка заметная: Млечный Путь глазом почти не виден, но камера его покажет.');
    }
    const s = n.statsWindow || n.statsNight;
    if (s) {
      if (s.humidityMax !== null && s.humidityMax >= 90) out.push(`Влажность до ${Math.round(s.humidityMax)}% — возможна роса на объективе.`);
      if (s.windMax !== null && s.windMax >= 8) out.push(`Ветер до ${Math.round(s.windMax)} м/с — штатив будет дрожать, ищите укрытие.`);
      if (s.tempMin !== null && s.tempMin <= 5) out.push(`Ночью до ${formatTemp(s.tempMin)} — одевайтесь теплее.`);
    }
    return out.slice(0, 3);
  }

  // ---- неделя ----
  function weekRow(n) {
    let text;
    switch (n.rating) {
      case 'great': text = n.window.startCause === 'moonset' ? `ясно, после захода Луны` : 'ясно, без Луны'; break;
      case 'good': text = n.reason === 'moon' ? 'ясно, но светит Луна' : n.reason === 'twilight' ? 'ясно, но светлая ночь' : 'ясно ненадолго'; break;
      case 'maybe': text = 'переменная облачность'; break;
      case 'bad': text = n.statsNight && n.statsNight.precipMax >= 60 ? 'облачно, дождь' : 'облачно'; break;
      case 'nodark': text = 'не стемнеет'; break;
      default: text = 'прогноза пока нет';
    }
    let label;
    if (n.index === 0) label = afterMidnight ? 'Эта ночь' : 'Сегодня';
    else if (nightName(n) === 'завтра') label = 'Завтра';
    else label = cap(fmt.weekdayShort(n.evening));
    const tone = { great: 'yes', good: 'moon', maybe: 'maybe', bad: 'no', nodark: 'no' }[n.rating] || 'unknown';
    const details = [];
    if (n.window && ['great', 'good', 'maybe'].includes(n.rating)) details.push(`Лучшее время: ${range(n.window)}.`);
    if (n.statsNight && n.rating !== 'nodark') {
      const cl = n.clearIntervals;
      const tail = I.totalLength(cl) >= 0.9 * n.obsMs
        ? 'ясно всю ночь'
        : cl.length
          ? `ясно ${cl.slice(0, 3).map((i) => `${fmt.time(fmt.round(i.start, 10))}–${fmt.time(fmt.round(i.end, 10))}`).join(', ')}`
          : 'ясных промежутков нет';
      details.push(`Облачность около ${round5(n.statsNight.cloudAvg)}%, ${tail}.`);
    }
    const obs = n.obsFull[0];
    if (obs) details.push(`Темно: ${t(obs.start)}–${t(n.obsFull[n.obsFull.length - 1].end)}.`);
    const mev = [];
    if (n.events.moonrise) mev.push([n.events.moonrise, `восход в ${t(n.events.moonrise)}`]);
    if (n.events.moonset) mev.push([n.events.moonset, `заход в ${t(n.events.moonset)}`]);
    const moonText = mev.sort((a, b) => a[0] - b[0]).map((x) => x[1]).join(', ');
    details.push(`Луна ${pct(n.moon.illum)}${moonText ? `: ${moonText}` : n.moon.upFull.length ? ', всю ночь над горизонтом' : ', всю ночь под горизонтом'}.`);
    if (n.statsNight && n.statsNight.tempMin !== null) {
      details.push(`${cap(formatTemp(n.statsNight.tempMax))}…${formatTemp(n.statsNight.tempMin)}, ветер до ${Math.round(n.statsNight.windMax ?? 0)} м/с.`);
    }
    if (n.index >= 4 && n.coverage !== 'none') details.push('Прогноз на столько дней вперёд ещё может измениться.');
    return {
      details,
      index: n.index,
      label,
      date: fmt.dayMonth(n.evening),
      tone,
      text,
      window: n.window && ['great', 'good', 'maybe'].includes(n.rating) ? range(n.window) : null,
      cloud: n.statsNight ? round5(n.statsNight.cloudAvg) : null,
      moon: Math.round(n.moon.illum * 100),
      moonAngle: n.moon.angle,
    };
  }

  const main = tonight(n0);
  const objects = objectsView(n0);
  const next = nextView();
  let nextObjects = null;
  if (next && next.index !== null) nextObjects = objectsView(nights[next.index]).summary;

  let forecastNote = null;
  if (weather) {
    const age = now - weather.fetchedAt;
    const stamp = fmt.dateKey(weather.fetchedAt) === todayKey
      ? `в ${fmt.time(weather.fetchedAt)}`
      : `${fmt.dayMonth(weather.fetchedAt)} в ${fmt.time(weather.fetchedAt)}`;
    forecastNote = { text: `Прогноз обновлён ${stamp}`, stale: age > 6 * HOUR };
  }

  return {
    status: statusLine(),
    tone: main.tone,
    headline: main.headline,
    lines: main.lines,
    best: objects.summary ? `Лучше всего: ${objects.summary}` : null,
    notes: notes(n0),
    next: next ? { ...next, best: nextObjects ? `Лучше всего: ${nextObjects}` : null } : null,
    objects: objects.list,
    timeline: timeline(n0),
    factors: factors(n0),
    week: nights.map(weekRow),
    forecastNote,
  };
}

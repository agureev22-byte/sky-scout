// Отрисовка экрана «вердикт на сегодня». Все тексты готовит verdict.js, здесь — только разметка.

import { escapeHtml as esc } from './format.js';

const svg = (body, viewBox = '0 0 24 24') =>
  `<svg viewBox="${viewBox}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  pin: svg('<path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>'),
  refresh: svg('<path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/>'),
  close: svg('<path d="M6 6l12 12M18 6L6 18"/>'),
  eyeRed: svg('<path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12z"/><circle cx="12" cy="12" r="3" fill="currentColor"/>'),
  spinner: svg('<path d="M12 3a9 9 0 1 0 9 9" />'),
  yes: svg('<circle cx="12" cy="12" r="10"/><path d="M7.5 12.5l3 3 6-6.5"/>'),
  moon: svg('<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4a7 7 0 0 0 10.5 10.5z"/>'),
  maybe: svg('<path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 11 3.5 3.5 0 0 0 7 18z"/><path d="M12 21v.01M8 21v.01M16 21v.01"/>'),
  no: svg('<path d="M7 17h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 10 3.5 3.5 0 0 0 7 17z"/><path d="M10 20l4-4M14 20l-4-4"/>'),
  unknown: svg('<circle cx="12" cy="12" r="10"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .8-1 1.5v.7"/><path d="M12 17.5v.01"/>'),
  planet: svg('<circle cx="12" cy="12" r="5"/><path d="M3.5 15.5c-1.2 1.6-1 2.8.5 3.2 2.6.7 8.4-1.3 12.4-4.9 3.3-3 4.6-6 3-6.9-.8-.4-2-.2-3.4.4"/>'),
  milkyway: svg('<path d="M3 17c4-1 6-4 9-8s6-5 9-5"/><path d="M5 20c3-.5 6-2.5 8.5-6S18 8.5 21 8" opacity=".6"/><path d="M8 6v.01M17 16v.01M6 11v.01M19 13v.01" stroke-width="2.6"/>'),
  cloud: svg('<path d="M7 18h10a4 4 0 0 0 .6-8A6 6 0 0 0 6.2 11 3.5 3.5 0 0 0 7 18z"/>'),
  dark: svg('<path d="M12 3v2M12 19v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M3 12h2M19 12h2"/><path d="M8 16a4 4 0 1 1 8 0"/><path d="M3 20h18"/>'),
  light: svg('<path d="M4 21V10l4-3 4 3v11"/><path d="M12 21v-7h8v7"/><path d="M3 21h18"/><path d="M17 3v4M15 5h4"/>'),
  weather: svg('<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/>'),
};

// Луна в нужной фазе. angle: 0 — новолуние, 180 — полнолуние.
// В южном полушарии растущая Луна освещена слева — рисуем зеркально.
export function moonIcon(angle, south = false, size = 24) {
  const r = 10;
  const rad = (angle * Math.PI) / 180;
  const k = Math.cos(rad);
  const rx = Math.abs(k) * r;
  let waxing = angle < 180;
  if (south) waxing = !waxing;
  let d;
  if (waxing) d = `M0,${-r} A${r},${r} 0 0 1 0,${r} A${rx},${r} 0 0 ${k > 0 ? 0 : 1} 0,${-r} Z`;
  else d = `M0,${-r} A${r},${r} 0 0 0 0,${r} A${rx},${r} 0 0 ${k > 0 ? 1 : 0} 0,${-r} Z`;
  return `<svg viewBox="-12 -12 24 24" width="${size}" height="${size}" aria-hidden="true">
    <circle r="${r}" fill="currentColor" opacity=".18"/>
    <path d="${d}" fill="currentColor"/>
  </svg>`;
}

export function renderLoading(el, text = 'Считаю небо…') {
  el.className = 'card verdict tone-unknown';
  el.innerHTML = `<div class="loading">${ICONS.spinner}<span>${esc(text)}</span></div>`;
}

export function renderVerdict(el, v) {
  el.className = `card verdict tone-${v.tone}`;
  const icon = ICONS[v.tone] || ICONS.unknown;
  el.innerHTML = `
    <p class="status">${esc(v.status)}</p>
    <div class="verdict-head">
      <span class="tone-icon">${icon}</span>
      <h1 class="headline">${esc(v.headline)}</h1>
    </div>
    <div class="lines">${v.lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>
    ${v.best ? `<p class="best">${boldLead(v.best)}</p>` : ''}
    ${v.notes.length ? `<ul class="notes">${v.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
  `;
}

// «Лучше всего: …» — выделяем начало до двоеточия.
function boldLead(text) {
  const i = text.indexOf(':');
  if (i < 0) return esc(text);
  return `<b>${esc(text.slice(0, i + 1))}</b>${esc(text.slice(i + 1))}`;
}

export function renderNext(el, next) {
  if (!next) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <h2>${esc(next.title)}</h2>
    ${next.when ? `<p class="when">${esc(next.when)}</p>` : ''}
    <p>${esc(next.text)}</p>
    ${next.best ? `<p class="best">${boldLead(next.best)}</p>` : ''}
    ${next.note ? `<p class="note">${esc(next.note)}</p>` : ''}
  `;
}

const QUALITY_TEXT = {
  great: 'ясно и темно',
  good: 'ясно, но Луна или сумерки',
  maybe: 'переменная облачность',
  bad: 'облачно',
  day: 'светло',
  unknown: 'нет прогноза',
};

function cellDetail(c, fmtRange) {
  const bits = [QUALITY_TEXT[c.quality]];
  if (c.cloud !== null && c.quality !== 'day') bits.push(`облачность ${c.cloud}%`);
  if (c.light === 'twilight') bits.push('сумерки');
  if (c.moon) bits.push('Луна над горизонтом');
  return `${fmtRange}: ${bits.join(', ')}`;
}

export function renderTimeline(el, tl) {
  if (!tl || !tl.cells.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const cells = tl.cells;
  const every = cells.length > 12 ? 2 : 1;
  const used = new Set(cells.map((c) => c.quality));
  el.innerHTML = `
    <h2>Ночь по часам</h2>
    <div class="tl" role="list">
      ${cells
        .map(
          (c, i) => `<button class="tl-cell${c.now ? ' now' : ''}" type="button" role="listitem" data-i="${i}"
            aria-label="${esc(cellDetail(c, c.label + ':00'))}">
            <span class="tl-moon${c.moon ? (tl.moonBright ? ' on' : ' dim') : ''}"></span>
            <span class="tl-bar q-${c.quality}"></span>
            <span class="tl-label">${i % every === 0 ? esc(c.label) : ''}</span>
          </button>`,
        )
        .join('')}
    </div>
    <p class="tl-detail" id="tl-detail">Нажмите на час, чтобы увидеть подробности.</p>
    <ul class="legend">
      ${['great', 'good', 'maybe', 'bad', 'day', 'unknown']
        .filter((q) => used.has(q))
        .map((q) => `<li><i class="q-${q}"></i>${QUALITY_TEXT[q]}</li>`)
        .join('')}
      ${cells.some((c) => c.moon) ? '<li><i class="moon"></i>Луна над горизонтом</li>' : ''}
    </ul>
  `;
  const detail = el.querySelector('#tl-detail');
  el.querySelectorAll('.tl-cell').forEach((b) => {
    b.addEventListener('click', () => {
      el.querySelectorAll('.tl-cell.sel').forEach((x) => x.classList.remove('sel'));
      b.classList.add('sel');
      const c = cells[Number(b.dataset.i)];
      const next = cells[Number(b.dataset.i) + 1];
      const to = next ? next.label : String((Number(c.label) + 1) % 24).padStart(2, '0');
      detail.textContent = cellDetail(c, `${c.label}:00–${to}:00`);
    });
  });
}

export function renderObjects(el, objects, south) {
  if (!objects || !objects.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <h2>Что посмотреть</h2>
    <ul class="objects">
      ${objects
        .map((o) => {
          const icon = o.kind === 'moon' ? moonIcon(o.angle ?? 90, south, 30) : o.kind === 'milkyway' ? ICONS.milkyway : ICONS.planet;
          return `<li><span class="obj-icon">${icon}</span>
            <div><div class="obj-name">${esc(o.name)}</div><div class="obj-text">${esc(o.text)}</div></div></li>`;
        })
        .join('')}
    </ul>
  `;
}

export function renderFactors(el, factors, south) {
  if (!factors || !factors.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const iconFor = (f) =>
    f.id === 'moon' ? moonIcon(f.phase ?? 90, south, 22) : f.id === 'clouds' ? ICONS.cloud : ICONS[f.id] || '';
  el.innerHTML = `
    <h2>Из чего сложился вердикт</h2>
    <ul class="factors">
      ${factors
        .map(
          (f) => `<li>
            <div class="f-head"><span class="f-title">${iconFor(f)}${esc(f.title)}</span><span class="f-value">${esc(f.value)}</span></div>
            <p class="f-text">${esc(f.text)}</p>
          </li>`,
        )
        .join('')}
    </ul>
  `;
}

export function renderWeek(el, week, south) {
  if (!week || week.length < 2) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.innerHTML = `
    <h2>Ночи на неделю</h2>
    <ul class="week">
      ${week
        .map(
          (w) => `<li><details>
            <summary>
              <span class="w-dot tone-${w.tone}" aria-hidden="true"></span>
              <span class="w-main">
                <span class="w-day">${esc(w.label)}<small>${esc(w.date)}</small></span>
                <span class="w-text">${esc(w.text)}${w.window ? ` · ${esc(w.window)}` : ''}</span>
              </span>
              <span class="w-side">${w.cloud !== null ? `${w.cloud}%` : ''}${moonIcon(w.moonAngle, south, 20)}</span>
            </summary>
            <div class="w-body">${w.details.map((d) => `<p>${esc(d)}</p>`).join('')}</div>
          </details></li>`,
        )
        .join('')}
    </ul>
  `;
}

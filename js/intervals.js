// Арифметика интервалов времени.
// Интервал — {start, end} в миллисекундах (start < end).
// Список интервалов всегда отсортирован и без перекрытий.

export const MIN = 60 * 1000;
export const HOUR = 60 * MIN;
export const DAY = 24 * HOUR;

export function normalize(list) {
  const items = list
    .filter((i) => i && Number.isFinite(i.start) && Number.isFinite(i.end) && i.end > i.start)
    .map((i) => ({ start: i.start, end: i.end }))
    .sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of items) {
    const last = out[out.length - 1];
    if (last && i.start <= last.end) last.end = Math.max(last.end, i.end);
    else out.push(i);
  }
  return out;
}

export function intersect(a, b) {
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i].start, b[j].start);
    const end = Math.min(a[i].end, b[j].end);
    if (end > start) out.push({ start, end });
    if (a[i].end < b[j].end) i++;
    else j++;
  }
  return out;
}

export function subtract(a, b) {
  const out = [];
  for (const x of a) {
    let cur = x.start;
    for (const y of b) {
      if (y.end <= cur) continue;
      if (y.start >= x.end) break;
      if (y.start > cur) out.push({ start: cur, end: y.start });
      cur = Math.max(cur, y.end);
      if (cur >= x.end) break;
    }
    if (cur < x.end) out.push({ start: cur, end: x.end });
  }
  return out;
}

export function clip(list, start, end) {
  return intersect(list, [{ start, end }]);
}

// Склеивает интервалы, разделённые короткими промежутками (например, облачным «всплеском» на 10 минут).
export function mergeGaps(list, maxGap) {
  const out = [];
  for (const i of list) {
    const last = out[out.length - 1];
    if (last && i.start - last.end <= maxGap) last.end = Math.max(last.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

export function dropShort(list, minLength) {
  return list.filter((i) => i.end - i.start >= minLength);
}

export function longest(list) {
  let best = null;
  for (const i of list) if (!best || i.end - i.start > best.end - best.start) best = i;
  return best ? { start: best.start, end: best.end } : null;
}

export function totalLength(list) {
  return list.reduce((sum, i) => sum + (i.end - i.start), 0);
}

export function length(i) {
  return i ? i.end - i.start : 0;
}

export function find(list, t) {
  return list.find((i) => t >= i.start && t < i.end) || null;
}

export function overlaps(list, interval) {
  return list.filter((i) => i.end > interval.start && i.start < interval.end);
}

// Интервал из списка, который пересекается с заданным сильнее всего.
export function bestOverlap(list, interval) {
  let best = null;
  let bestLen = 0;
  for (const i of list) {
    const len = Math.min(i.end, interval.end) - Math.max(i.start, interval.start);
    if (len > bestLen) {
      best = i;
      bestLen = len;
    }
  }
  return best;
}

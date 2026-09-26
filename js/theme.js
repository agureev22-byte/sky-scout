// Темы: тёмная и красная «ночная». Красная не сбивает темновую адаптацию глаз,
// поэтому в режиме «авто» она включается сама, как только стемнеет.

import { storage } from './storage.js';

const KEY = 'theme-v1';
const MODES = ['auto', 'dark', 'red'];
const COLORS = { dark: '#05070d', red: '#000000' };

let mode = MODES.includes(storage.get(KEY)) ? storage.get(KEY) : 'auto';
let nightNow = guessNightByClock();

function guessNightByClock() {
  const h = new Date().getHours();
  return h >= 20 || h < 7;
}

let applied = null;

function apply() {
  const theme = mode === 'auto' ? (nightNow ? 'red' : 'dark') : mode;
  const key = `${theme}/${mode}`;
  if (key === applied) return theme; // вызывается каждый кадр — лишний раз DOM не трогаем
  applied = key;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themeMode = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', COLORS[theme]);
  return theme;
}

export function initTheme() {
  return apply();
}

export function getThemeMode() {
  return mode;
}

export function setThemeMode(next) {
  mode = MODES.includes(next) ? next : 'auto';
  storage.set(KEY, mode);
  return apply();
}

// Переключатель по кругу: авто → красная → тёмная → авто.
export function cycleThemeMode() {
  const order = ['auto', 'red', 'dark'];
  return setThemeMode(order[(order.indexOf(mode) + 1) % order.length]);
}

// Сообщить высоту Солнца над горизонтом в месте наблюдения: ниже −6° — уже ночь.
export function updateNight(sunAltitude) {
  if (Number.isFinite(sunAltitude)) nightNow = sunAltitude < -6;
  return apply();
}

export function themeLabel() {
  if (mode === 'auto') return nightNow ? 'Авто: ночной' : 'Авто: тёмный';
  return mode === 'red' ? 'Ночной красный' : 'Тёмный';
}

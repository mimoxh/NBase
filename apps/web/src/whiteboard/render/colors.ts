/**
 * Colours are stored as chosen in the light theme. The dark theme maps them at draw time instead
 * of storing a second palette: neutrals invert, pale fills become deep tints, mid tones stay.
 */
const cache = new Map<string, string>();

function parse(color: string): [number, number, number, number] | null {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!match) return null;
  const value = parseInt(match[1]!, 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, match[2] ? parseInt(match[2], 16) / 255 : 1];
}

function toHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === rn ? (gn - bn) / d + (gn < bn ? 6 : 0) : max === gn ? (bn - rn) / d + 2 : (rn - gn) / d + 4;
  return [h * 60, s, l];
}

function hsl(h: number, s: number, l: number, a: number): string {
  return `hsla(${h.toFixed(1)}, ${(s * 100).toFixed(1)}%, ${(l * 100).toFixed(1)}%, ${a.toFixed(3)})`;
}

export function themed(color: string, dark: boolean): string {
  if (!dark || color === 'transparent') return color;
  const known = cache.get(color);
  if (known) return known;
  const rgb = parse(color);
  if (!rgb) return color;
  const [h, s, l] = toHsl(rgb[0], rgb[1], rgb[2]);
  let next = l;
  if (s < 0.12) next = 1 - l * 0.92 - 0.04;
  else if (l > 0.82) next = 0.16 + (1 - l) * 0.9;
  else if (l < 0.3) next = 0.78 - l;
  const result = hsl(h, s < 0.12 ? s : Math.min(s, 0.7), Math.min(0.96, Math.max(0.08, next)), rgb[3]);
  cache.set(color, result);
  return result;
}

/** Text drawn on a note stays readable on its (themed) paper. */
export const noteInk = (dark: boolean) => dark ? '#e6e7e9' : '#1f2328';

export interface Theme {
  dark: boolean;
  canvas: string; dot: string; grid: string; frameFill: string; frameStroke: string; frameLabel: string;
  accent: string; accentSoft: string; handleFill: string; muted: string; cardBg: string; cardLine: string; danger: string;
  shadow: string; mindEdgeFallback: string; labelBg: string;
}

export const lightTheme: Theme = {
  dark: false, canvas: '#ffffff', dot: '#d5d9de', grid: '#eef0f2', frameFill: 'rgba(240, 242, 245, .5)', frameStroke: '#c9ced6',
  frameLabel: '#656d76', accent: '#3e63dd', accentSoft: 'rgba(62, 99, 221, .12)', handleFill: '#ffffff', muted: '#656d76',
  cardBg: '#ffffff', cardLine: '#dfe3e8', danger: '#c93c37', shadow: 'rgba(31, 35, 40, .14)', mindEdgeFallback: '#8c959f', labelBg: '#ffffff',
};
export const darkTheme: Theme = {
  dark: true, canvas: '#17181a', dot: '#34373c', grid: '#222428', frameFill: 'rgba(38, 41, 45, .45)', frameStroke: '#3d4248',
  frameLabel: '#9aa0a6', accent: '#7b93ff', accentSoft: 'rgba(123, 147, 255, .16)', handleFill: '#17181a', muted: '#9aa0a6',
  cardBg: '#202227', cardLine: '#33363b', danger: '#e06a62', shadow: 'rgba(0, 0, 0, .5)', mindEdgeFallback: '#6e7378', labelBg: '#17181a',
};

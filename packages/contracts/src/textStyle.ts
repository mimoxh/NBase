/** Text colours are theme tokens, never raw CSS: the stored style only names a palette entry. */
export const textColorIds = ['gray', 'brown', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'red'] as const;
export type TextColorId = typeof textColorIds[number];

export interface TextStyle { color?: TextColorId; background?: TextColorId }

/** Light-theme values for formats that cannot carry theme variables (Markdown, HTML and Word export). */
export const textColorHex: Record<TextColorId, { text: string; background: string }> = {
  gray: { text: '#787774', background: '#f1f1ef' },
  brown: { text: '#9f6b53', background: '#f4eeee' },
  orange: { text: '#d9730d', background: '#fbecdd' },
  yellow: { text: '#cb912f', background: '#fbf3db' },
  green: { text: '#448361', background: '#edf3ec' },
  blue: { text: '#337ea9', background: '#e7f3f8' },
  purple: { text: '#9065b0', background: '#f6f3f9' },
  pink: { text: '#c14c8a', background: '#faf1f5' },
  red: { text: '#d44c47', background: '#fdebec' },
};

const isColor = (value: unknown): value is TextColorId =>
  typeof value === 'string' && (textColorIds as readonly string[]).includes(value);

/** The only stored form: fixed property order, each ending in a semicolon, as Lexical writes styles. */
export function textStyleCss(style: TextStyle): string {
  return (style.color ? `color: var(--nb-c-${style.color});` : '')
    + (style.background ? `background-color: var(--nb-bg-${style.background});` : '');
}

/** Reads palette entries out of any CSS text and ignores every other declaration. */
export function parseTextStyle(css: string): TextStyle {
  const style: TextStyle = {};
  for (const rule of css.split(';')) {
    const match = /^\s*(color|background-color)\s*:\s*var\(--nb-(c|bg)-([a-z]+)\)\s*$/.exec(rule);
    if (!match || !isColor(match[3])) continue;
    if (match[1] === 'color' && match[2] === 'c') style.color = match[3];
    if (match[1] === 'background-color' && match[2] === 'bg') style.background = match[3];
  }
  return style;
}

export function isTextStyle(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 80 && textStyleCss(parseTextStyle(value)) === value;
}

export const blockAlignments = ['left', 'center', 'right', 'justify'] as const;
export type BlockAlignment = typeof blockAlignments[number];

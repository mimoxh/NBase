import { textColorIds, type TextColorId, type TextStyle } from '@nbase/contracts';

export const textColorLabels: Record<TextColorId, string> = {
  gray: '灰色', brown: '棕色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色', purple: '紫色', pink: '粉色', red: '红色',
};

export type TextStylePatch = { color?: TextColorId | null; background?: TextColorId | null };

/** Palette swatches for text and background colour; buttons keep the editor selection. */
export function TextColorMenu({ value, onPick }: { value: TextStyle; onPick: (patch: TextStylePatch) => void }) {
  const row = (kind: 'color' | 'background', title: string) => <div className="nbase-color-row" role="group" aria-label={title}>
    <span>{title}</span>
    <button type="button" className="nbase-color-swatch is-default" aria-label={title + '：默认'} title="默认"
      aria-pressed={!value[kind]} onMouseDown={event => event.preventDefault()} onClick={() => onPick({ [kind]: null })}>A</button>
    {textColorIds.map(id => <button key={id} type="button" className="nbase-color-swatch" aria-label={title + '：' + textColorLabels[id]}
      title={textColorLabels[id]} aria-pressed={value[kind] === id}
      style={kind === 'color' ? { color: `var(--nb-c-${id})` } : { backgroundColor: `var(--nb-bg-${id})` }}
      onMouseDown={event => event.preventDefault()} onClick={() => onPick({ [kind]: id })}>A</button>)}
  </div>;
  return <div className="nbase-color-menu">{row('color', '文字颜色')}{row('background', '背景颜色')}</div>;
}

import type { AggregateFunction, FilterOperator, OptionColor, PropertyType, RelativeDateToken } from '@nbase/contracts';

export const typeLabels: Record<PropertyType, string> = {
  title: '标题', text: '文本', number: '数字', select: '单选', multi_select: '多选', date: '日期',
  checkbox: '复选框', url: '网址', created_time: '创建时间', updated_time: '更新时间',
};

/** Short glyphs, so the header stays readable without an icon font. */
export const typeGlyphs: Record<PropertyType, string> = {
  title: 'Aa', text: '≡', number: '#', select: '◉', multi_select: '☷', date: '▦',
  checkbox: '☑', url: '↗', created_time: '◷', updated_time: '↻',
};

/** Types a user can add or switch to; title is fixed and only one exists. */
export const creatableTypes: PropertyType[] = ['text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url',
  'created_time', 'updated_time'];

const dateOperators: Partial<Record<FilterOperator, string>> = {
  equals: '是', gt: '晚于', gte: '不早于', lt: '早于', lte: '不晚于',
};
const operatorText: Record<FilterOperator, string> = {
  contains: '包含', not_contains: '不包含', equals: '等于', not_equals: '不等于', gt: '大于', gte: '大于等于',
  lt: '小于', lte: '小于等于', is_empty: '为空', is_not_empty: '不为空', is_checked: '已勾选', is_not_checked: '未勾选',
};

export function operatorLabel(type: PropertyType, operator: FilterOperator): string {
  if (type === 'date' || type === 'created_time' || type === 'updated_time') return dateOperators[operator] ?? operatorText[operator];
  if (type === 'select' && (operator === 'equals' || operator === 'not_equals')) return operator === 'equals' ? '是' : '不是';
  return operatorText[operator];
}

export const relativeDateLabels: Record<RelativeDateToken, string> = {
  today: '今天', yesterday: '昨天', tomorrow: '明天', this_week: '本周', last_week: '上周', next_week: '下周', this_month: '本月',
  last_month: '上月', next_month: '下月', last_7_days: '最近 7 天', last_30_days: '最近 30 天', next_7_days: '未来 7 天', next_30_days: '未来 30 天',
};

export const aggregateLabels: Record<AggregateFunction, string> = {
  count: '行数', count_values: '有值', count_empty: '为空', sum: '求和', avg: '平均', min: '最小', max: '最大',
};

export const colorLabels: Record<OptionColor, string> = {
  default: '默认', gray: '灰色', brown: '棕色', orange: '橙色', yellow: '黄色', green: '绿色', blue: '蓝色',
  purple: '紫色', pink: '粉色', red: '红色',
};

const colorCycle: OptionColor[] = ['blue', 'green', 'orange', 'purple', 'pink', 'yellow', 'red', 'brown', 'gray'];
export function nextOptionColor(count: number): OptionColor {
  return colorCycle[count % colorCycle.length] ?? 'default';
}

export function formatTimestamp(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function monthBounds(month: string): { first: string; last: string } {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return { first: `${month}-01`, last: new Date(Date.UTC(year, value, 0)).toISOString().slice(0, 10) };
}

export function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString('zh-CN') : value.toLocaleString('zh-CN', { maximumFractionDigits: 10 });
}

import { isAlias, isMap, parseDocument, stringify, visit } from 'yaml';
import {
  activeProperties, databaseTextValueLimit, isDateCellValue, isMarkdownFrontMatter, isMarkdownMetadataKey, isPagePropertyName,
  markdownFrontMatterKey, markdownFrontMatterMaxBytes, markdownFrontMatterMaxDepth, markdownFrontMatterMaxNodes, pagePropertyDisplayValue,
  pagePropertyLimit, pagePropertyNameKey, pagePropertyReservedNames, pageTagLimit, tagNameKey, tagNameLimit,
  type MarkdownFrontMatter, type MarkdownMetadataValue, type PageProperty, type PropertyDefinition, type RowProperties, type StoredDocumentContent,
} from '@nbase/contracts';

export interface MarkdownFrontMatterResult {
  body: string;
  title?: string;
  tagNames: string[];
  metadata: MarkdownFrontMatter;
  warnings: string[];
  preservedAsSource: boolean;
}

function toMetadataValue(value: unknown): MarkdownMetadataValue {
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (!Number.isSafeInteger(number)) throw new Error('YAML 整数超出安全范围');
    return number;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(toMetadataValue);
  if (value instanceof Map) {
    return Object.fromEntries([...value.entries()].map(([key, item]: [unknown, unknown]) => {
      if (typeof key !== 'string' || !isMarkdownMetadataKey(key)) throw new Error('YAML 键无效');
      return [key, toMetadataValue(item)];
    }));
  }
  throw new Error('YAML 值无效');
}

function tagNamesFrom(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > pageTagLimit) throw new Error('tags 必须是有界的标签名称数组');
  const names = value.map((item: unknown) => {
    if (typeof item !== 'string') throw new Error('标签名称无效');
    const name = item.trim().normalize('NFC');
    if (!name || [...name].length > tagNameLimit || /[\p{Cc}\p{Cs}]/u.test(name)) throw new Error('标签名称无效');
    return name;
  });
  if (new Set(names.map(tagNameKey)).size !== names.length) throw new Error('标签名称重复');
  return names;
}

export function readMarkdownFrontMatter(markdown: string): MarkdownFrontMatterResult {
  const empty = { body: markdown, tagNames: [], metadata: {}, warnings: [], preservedAsSource: false };
  const opening = /^\uFEFF?---[ \t]*(?:\r\n|\n|\r)/.exec(markdown);
  if (!opening) return empty;
  const rest = markdown.slice(opening[0].length);
  const closing = /(?:^|\r\n|\n|\r)(?:---|\.\.\.)[ \t]*(?:\r\n|\n|\r|$)/.exec(rest);
  const fail = (message: string) => ({ ...empty, warnings: [`${message}，已保留整份 Markdown 原文。`], preservedAsSource: true });
  if (!closing) {
    // A leading horizontal rule is valid Markdown. An unclosed YAML-looking header is ambiguous.
    return /^(?:[ \t]*\r?\n)*[ \t]*(?:[^\r\n:]{1,100}:|\{|\[)/.test(rest)
      ? fail('文首 YAML front matter 未闭合') : empty;
  }
  const source = rest.slice(0, closing.index);
  if (source.length > markdownFrontMatterMaxBytes || new TextEncoder().encode(source).byteLength > markdownFrontMatterMaxBytes) {
    return fail('文首 YAML front matter 超过 16 KiB');
  }

  try {
    const document = parseDocument(source, { version: '1.2', schema: 'core', strict: true, uniqueKeys: true, intAsBigInt: true });
    if (document.errors.length || document.warnings.length || (document.contents !== null && !isMap(document.contents))) {
      return fail('文首 YAML front matter 必须是无重复键的映射');
    }
    let nodes = 0;
    visit(document, (_key, node, path) => {
      if (++nodes > markdownFrontMatterMaxNodes * 3 || path.length > markdownFrontMatterMaxDepth * 2 + 2
        || isAlias(node) || (node !== null && typeof node === 'object'
          && (('anchor' in node && node.anchor) || ('tag' in node && node.tag)))) {
        throw new Error('YAML 结构不受支持');
      }
    });
    const fields = toMetadataValue(document.toJS({ mapAsMap: true, maxAliasCount: 0 })) as MarkdownFrontMatter | null;
    const { title, tags, ...metadata } = fields ?? {};
    if (title !== undefined && (typeof title !== 'string' || !title.trim() || title.trim().length > 255 || /[\p{Cc}\p{Cs}]/u.test(title))) {
      return fail('文首 YAML title 必须是有效的页面标题');
    }
    if (!isMarkdownFrontMatter(metadata)) return fail('文首 YAML date 或元数据结构无效');
    return { body: rest.slice(closing.index + closing[0].length), ...(title === undefined ? {} : { title: title.trim() }),
      tagNames: tags === undefined ? [] : tagNamesFrom(tags), metadata, warnings: [], preservedAsSource: false };
  } catch {
    return fail('文首 YAML front matter 含无效标签、锚点、别名或不支持的结构');
  }
}

export function getMarkdownFrontMatter(content: StoredDocumentContent): MarkdownFrontMatter {
  const root = content.editorState.root as { $?: Record<string, unknown> } | null;
  const metadata = root?.$?.[markdownFrontMatterKey];
  return isMarkdownFrontMatter(metadata) ? metadata : {};
}

/** Properties come after the tags; a metadata key that a property also uses is left out, so the property wins. */
export function addMarkdownFrontMatter(markdown: string, content: StoredDocumentContent, title: string, tags: readonly string[],
  properties: Readonly<Record<string, FrontMatterPropertyValue>> = {}): string {
  const taken = new Set(Object.keys(properties).map(pagePropertyNameKey));
  const metadata = Object.fromEntries(Object.entries(getMarkdownFrontMatter(content))
    .filter(([key]) => key === 'date' || !taken.has(pagePropertyNameKey(key))));
  const fields = { title, ...(tags.length ? { tags: [...tags] } : {}), ...properties, ...metadata };
  return `---\n${stringify(fields, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd()}\n---\n\n${markdown}`;
}

/** Not a type guard, so a string that is no date value still reads as a string afterwards. */
const isDateText = (value: string): boolean => isDateCellValue(value);

/** Values a page or row property takes in a Markdown header. */
export type FrontMatterPropertyValue = string | number | boolean | string[];

/**
 * Header fields of a page's own properties, keyed by name. Empty values are left out; a select writes its option name.
 */
export function pagePropertiesFrontMatter(properties: readonly PageProperty[]): Record<string, FrontMatterPropertyValue> {
  const fields: Record<string, FrontMatterPropertyValue> = {};
  for (const property of properties) {
    const value = pagePropertyDisplayValue(property);
    if (value !== null && isMarkdownMetadataKey(property.name)) fields[property.name] = value;
  }
  return fields;
}

/**
 * Header fields of a row's values in its database. Names that the header uses itself (title, tags, date) or that
 * repeat without case are skipped, so a row exports like a page and imports back as one.
 */
export function rowPropertiesFrontMatter(definitions: readonly PropertyDefinition[], values: RowProperties): Record<string, FrontMatterPropertyValue> {
  const fields: Record<string, FrontMatterPropertyValue> = {};
  const used = new Set<string>(pagePropertyReservedNames);
  for (const def of activeProperties([...definitions])) {
    const key = pagePropertyNameKey(def.name);
    if (used.has(key) || !isMarkdownMetadataKey(def.name)) continue;
    const value = values[def.id];
    if (value === undefined || value === null) continue;
    let field: FrontMatterPropertyValue | undefined;
    switch (def.type) {
      case 'text': case 'url': case 'date': case 'number': field = value as string | number; break;
      case 'checkbox': field = value === true; break;
      case 'select': field = def.options?.find(option => option.id === value)?.name; break;
      case 'multi_select': {
        const names = (Array.isArray(value) ? value : []).map(id => def.options?.find(option => option.id === id)?.name)
          .filter((name): name is string => name !== undefined);
        field = names.length ? names : undefined;
        break;
      }
      default: field = undefined;
    }
    if (field === undefined) continue;
    used.add(key);
    fields[def.name] = field;
  }
  return fields;
}

/**
 * Turns the unknown top-level keys of an imported header into page properties: numbers become numbers, date values
 * dates, and other scalars text. Lists, maps, `date` and names a property cannot take stay as metadata.
 */
export function propertiesFromFrontMatter(metadata: MarkdownFrontMatter): { properties: PageProperty[]; metadata: MarkdownFrontMatter } {
  const properties: PageProperty[] = [];
  const rest: MarkdownFrontMatter = {};
  const used = new Set<string>();
  for (const [key, value] of Object.entries(metadata)) {
    const name = key.trim();
    const nameKey = pagePropertyNameKey(name);
    let property: PageProperty | null = null;
    if (key !== 'date' && isPagePropertyName(name) && !used.has(nameKey) && properties.length < pagePropertyLimit) {
      const id = crypto.randomUUID();
      const text: string | null = typeof value === 'string' ? value : null;
      if (typeof value === 'number' && Number.isFinite(value)) property = { id, name, type: 'number', value };
      else if (text !== null && isDateText(text)) property = { id, name, type: 'date', value: text };
      else if (text !== null && text.length <= databaseTextValueLimit && !/[\u0000\p{Cs}]/u.test(text)) {
        property = { id, name, type: 'text', value: text || null };
      } else if (typeof value === 'boolean') property = { id, name, type: 'text', value: String(value) };
      else if (value === null) property = { id, name, type: 'text', value: null };
    }
    if (property) { properties.push(property); used.add(nameKey); } else rest[key] = value;
  }
  return { properties, metadata: rest };
}

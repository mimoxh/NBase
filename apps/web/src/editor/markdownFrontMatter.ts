import { isAlias, isMap, parseDocument, stringify, visit } from 'yaml';
import {
  isMarkdownFrontMatter, isMarkdownMetadataKey, markdownFrontMatterKey, markdownFrontMatterMaxBytes,
  markdownFrontMatterMaxDepth, markdownFrontMatterMaxNodes, pageTagLimit, tagNameKey, tagNameLimit,
  type MarkdownFrontMatter, type MarkdownMetadataValue, type StoredDocumentContent,
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

export function addMarkdownFrontMatter(markdown: string, content: StoredDocumentContent, title: string, tags: readonly string[]): string {
  const fields = { title, ...(tags.length ? { tags: [...tags] } : {}), ...getMarkdownFrontMatter(content) };
  return `---\n${stringify(fields, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd()}\n---\n\n${markdown}`;
}

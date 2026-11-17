/**
 * A small namespace-aware XML reader for WebDAV multistatus answers. It knows elements, attributes,
 * namespaces and prefixes, text, CDATA, the five predefined entities and numeric character references,
 * comments and processing instructions. DOCTYPE is refused, so no entity can be declared or expanded.
 */
export class XmlError extends Error {}

export interface XmlElement {
  /** Namespace URI; empty for no namespace. */
  ns: string;
  /** Local name. */
  name: string;
  attrs: Map<string, string>;
  children: XmlElement[];
  /** Text directly inside this element, CDATA included, in document order. */
  text: string;
}

export const DAV = 'DAV:';
export const CALDAV = 'urn:ietf:params:xml:ns:caldav';
export const CALSERVER = 'http://calendarserver.org/ns/';
export const APPLE = 'http://apple.com/ns/ical/';

const maxDepth = 64;
const predefined: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
const namePattern = /^[A-Za-z_\u00C0-\uFFFF][\w.\-\u00B7\u00C0-\uFFFF]*(?::[A-Za-z_\u00C0-\uFFFF][\w.\-\u00B7\u00C0-\uFFFF]*)?$/;

function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(/&(?:([^;&\s<]{1,12});)?/g, (_match, ref: string | undefined) => {
    if (ref === undefined) throw new XmlError('Bare ampersand');
    if (ref.startsWith('#')) {
      if (!/^#(?:x[0-9a-f]+|\d+)$/i.test(ref)) throw new XmlError('Invalid character reference');
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError('Invalid character reference');
      return String.fromCodePoint(code);
    }
    const value = predefined[ref];
    if (value === undefined) throw new XmlError('Unknown entity');
    return value;
  });
}
interface Open { element: XmlElement; qname: string; scope: Map<string, string> }

function resolve(qname: string, scope: Map<string, string>, attribute: boolean): { ns: string; name: string } {
  const colon = qname.indexOf(':');
  if (colon < 0) return { ns: attribute ? '' : scope.get('') ?? '', name: qname };
  const prefix = qname.slice(0, colon);
  if (prefix === 'xml') return { ns: 'http://www.w3.org/XML/1998/namespace', name: qname.slice(colon + 1) };
  const ns = scope.get(prefix);
  if (ns === undefined) throw new XmlError(`Unbound prefix ${prefix}`);
  return { ns, name: qname.slice(colon + 1) };
}

/** Parses a document and returns its root element. */
export function parseXml(input: string): XmlElement {
  const text = input.replace(/^\uFEFF/, '');
  const stack: Open[] = [];
  let root: XmlElement | null = null;
  let i = 0;
  const appendText = (value: string) => {
    const top = stack.at(-1);
    if (top) top.element.text += value;
    else if (value.trim()) throw new XmlError('Text outside the root element');
  };
  while (i < text.length) {
    const lt = text.indexOf('<', i);
    if (lt < 0) { appendText(decodeEntities(text.slice(i))); break; }
    if (lt > i) appendText(decodeEntities(text.slice(i, lt)));
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end < 0) throw new XmlError('Unclosed comment');
      i = end + 3;
    } else if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end < 0) throw new XmlError('Unclosed CDATA');
      if (!stack.length) throw new XmlError('CDATA outside the root element');
      appendText(text.slice(lt + 9, end));
      i = end + 3;
    } else if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end < 0) throw new XmlError('Unclosed processing instruction');
      i = end + 2;
    } else if (text.startsWith('<!', lt)) {
      throw new XmlError('DOCTYPE and declarations are not accepted');
    } else if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt);
      if (end < 0) throw new XmlError('Unclosed end tag');
      const qname = text.slice(lt + 2, end).trim();
      const top = stack.pop();
      if (!top || top.qname !== qname) throw new XmlError('Mismatched end tag');
      i = end + 1;
    } else {
      // Scan the start tag, honouring quotes so that ">" inside attribute values does not end it.
      let j = lt + 1;
      let quote: string | null = null;
      for (; j < text.length; j++) {
        const c = text[j];
        if (quote) { if (c === quote) quote = null; } else if (c === '"' || c === "'") quote = c; else if (c === '>') break;
      }
      if (j >= text.length) throw new XmlError('Unclosed start tag');
      let inner = text.slice(lt + 1, j);
      const selfClosing = inner.endsWith('/');
      if (selfClosing) inner = inner.slice(0, -1);
      const nameMatch = /^[^\s/>]+/.exec(inner);
      if (!nameMatch || !namePattern.test(nameMatch[0])) throw new XmlError('Invalid element name');
      const qname = nameMatch[0];
      const raw = new Map<string, string>();
      const attrPattern = /\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
      let k = qname.length;
      attrPattern.lastIndex = k;
      for (;;) {
        const m = attrPattern.exec(inner);
        if (!m) break;
        if (raw.has(m[1]!)) throw new XmlError('Repeated attribute');
        if ((m[2] ?? m[3])!.includes('<')) throw new XmlError('"<" in attribute value');
        raw.set(m[1]!, decodeEntities(m[2] ?? m[3] ?? ''));
        k = attrPattern.lastIndex;
      }
      if (inner.slice(k).trim()) throw new XmlError('Malformed attributes');
      const parentScope = stack.at(-1)?.scope ?? new Map<string, string>();
      let scope = parentScope;
      for (const [key, value] of raw) {
        if (key === 'xmlns' || key.startsWith('xmlns:')) {
          if (scope === parentScope) scope = new Map(parentScope);
          const prefix = key === 'xmlns' ? '' : key.slice(6);
          if (prefix && !value) throw new XmlError('Empty namespace for a prefix');
          scope.set(prefix, value);
        }
      }
      const { ns, name } = resolve(qname, scope, false);
      const attrs = new Map<string, string>();
      for (const [key, value] of raw) {
        if (key === 'xmlns' || key.startsWith('xmlns:')) continue;
        const resolved = resolve(key, scope, true);
        attrs.set(resolved.ns ? `{${resolved.ns}}${resolved.name}` : resolved.name, value);
      }
      const element: XmlElement = { ns, name, attrs, children: [], text: '' };
      const parent = stack.at(-1);
      if (parent) parent.element.children.push(element);
      else if (root) throw new XmlError('More than one root element');
      else root = element;
      if (!selfClosing) {
        if (stack.length >= maxDepth) throw new XmlError('Nesting too deep');
        stack.push({ element, qname, scope });
      }
      i = j + 1;
    }
  }
  if (stack.length) throw new XmlError('Unclosed element');
  if (!root) throw new XmlError('No root element');
  return root;
}

export function child(element: XmlElement | undefined, ns: string, name: string): XmlElement | undefined {
  return element?.children.find(item => item.ns === ns && item.name === name);
}

export function childrenOf(element: XmlElement | undefined, ns: string, name: string): XmlElement[] {
  return element?.children.filter(item => item.ns === ns && item.name === name) ?? [];
}

/** All text inside an element, its descendants included. */
export function deepText(element: XmlElement | undefined): string {
  if (!element) return '';
  return element.text + element.children.map(deepText).join('');
}

export function escapeXml(value: string): string {
  return value.replace(/[<>&"']/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

export interface SerializedMermaidNode {
  type: 'mermaid';
  version: 1;
  source: string;
}

/** Source is stored as text. Rendering has separate, narrower limits. */
export function isStoredMermaidSource(source: unknown): source is string {
  return typeof source === 'string' && source.length <= 1024 * 1024 && !/[\u0000\p{Cs}]/u.test(source);
}

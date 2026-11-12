/** Workspace relationship graph: active pages and the saved links between them. See docs/architecture/graph.md. */
export const graphNodeLimit = 2000;
export const graphEdgeLimit = 10000;

/**
 * What a link edge was derived from. Add a kind here when another saved reference type
 * (for example block references) joins the index; clients treat unknown kinds as plain links.
 */
export const graphLinkKinds = ['page-reference'] as const;
export type GraphLinkKind = typeof graphLinkKinds[number];

export interface GraphNode {
  id: string;
  title: string;
  icon: string | null;
  /** Database rows are folded into their database and never appear as nodes. */
  kind: 'document' | 'database' | 'whiteboard';
  /** Null for workspace roots. Parent/child edges are derived from this on the client. */
  parentId: string | null;
  tagIds: string[];
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: GraphLinkKind;
  /** Number of saved references from source to target, after folding rows into databases. */
  count: number;
}

export interface WorkspaceGraphResponse {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the workspace has more active pages or more distinct links than the limits allow. */
  truncated: boolean;
}

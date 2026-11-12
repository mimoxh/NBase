import { graphEdgeLimit, graphLinkKinds, graphNodeLimit, type GraphEdge, type GraphLinkKind, type GraphNode,
  type WorkspaceGraphResponse } from '@nbase/contracts';
import type { Pool } from 'pg';

export interface GraphNodeRow {
  id: string;
  title: string;
  icon: string | null;
  kind: string;
  parent_id: string | null;
  tag_ids: string[] | null;
}

export interface GraphEdgeRow { source: string; target: string; kind: string; count: number }

/**
 * Every saved reference as one (source page, target page, kind) row. Aggregation, row folding and
 * the active/member checks sit outside, so another indexed link kind (block references) only adds
 * a `UNION ALL SELECT workspace_id, <source page>, <target page>, '<kind>' FROM <index>` branch here
 * plus the kind in contracts `graphLinkKinds`.
 */
const linkSources = `
  SELECT workspace_id, source_page_id, target_page_id, 'page-reference'::text AS kind FROM page_links`;

/** Active non-row pages, most recently updated first so a truncated graph keeps the pages in use. */
const nodeQuery = `
  SELECT p.id, p.title, p.icon, p.kind,
    CASE WHEN parent.kind = 'row' THEN parent.parent_id ELSE p.parent_id END AS parent_id,
    ARRAY(SELECT pt.tag_id FROM page_tags pt WHERE pt.workspace_id = p.workspace_id AND pt.page_id = p.id ORDER BY pt.tag_id) AS tag_ids
  FROM pages p
  JOIN workspace_memberships m ON m.workspace_id = p.workspace_id AND m.user_id = $2
  LEFT JOIN pages parent ON parent.workspace_id = p.workspace_id AND parent.id = p.parent_id
  WHERE p.workspace_id = $1 AND p.deleted_at IS NULL AND p.kind <> 'row'
  ORDER BY p.updated_at DESC, p.id LIMIT $3`;

/** Rows count as their database on both ends; links inside one node and links to trashed pages drop out. */
const edgeQuery = `
  WITH nodes AS (SELECT id FROM unnest($3::uuid[]) AS node(id)), folded AS (
    SELECT CASE WHEN s.kind = 'row' THEN s.parent_id ELSE s.id END AS source,
      CASE WHEN t.kind = 'row' THEN t.parent_id ELSE t.id END AS target, l.kind
    FROM (${linkSources}) l
    JOIN workspace_memberships m ON m.workspace_id = l.workspace_id AND m.user_id = $2
    JOIN pages s ON s.workspace_id = l.workspace_id AND s.id = l.source_page_id AND s.deleted_at IS NULL
    JOIN pages t ON t.workspace_id = l.workspace_id AND t.id = l.target_page_id AND t.deleted_at IS NULL
    WHERE l.workspace_id = $1
  )
  SELECT f.source, f.target, f.kind, count(*)::int AS count FROM folded f
  JOIN nodes a ON a.id = f.source JOIN nodes b ON b.id = f.target
  WHERE f.source <> f.target
  GROUP BY f.source, f.target, f.kind
  ORDER BY count(*) DESC, f.source, f.target, f.kind LIMIT $4`;

const linkKind = (kind: string): GraphLinkKind =>
  (graphLinkKinds as readonly string[]).includes(kind) ? kind as GraphLinkKind : 'page-reference';

/** Pure assembly: apply limits, drop edges and parents that point outside the returned node set. */
export function assembleGraph(nodeRows: readonly GraphNodeRow[], edgeRows: readonly GraphEdgeRow[],
  nodeLimit = graphNodeLimit, edgeLimit = graphEdgeLimit): WorkspaceGraphResponse {
  const kept = nodeRows.slice(0, nodeLimit);
  const ids = new Set(kept.map(row => row.id));
  const nodes: GraphNode[] = kept.map(row => ({
    id: row.id, title: row.title, icon: row.icon ?? null, kind: row.kind === 'database' ? 'database' : 'document',
    parentId: row.parent_id && row.parent_id !== row.id && ids.has(row.parent_id) ? row.parent_id : null,
    tagIds: row.tag_ids ?? [],
  }));
  const edges: GraphEdge[] = edgeRows.slice(0, edgeLimit)
    .filter(row => row.source !== row.target && ids.has(row.source) && ids.has(row.target) && row.count > 0)
    .map(row => ({ source: row.source, target: row.target, kind: linkKind(row.kind), count: row.count }));
  return { nodes, edges, truncated: nodeRows.length > nodeLimit || edgeRows.length > edgeLimit };
}

/** Read-only; the membership join gates both queries, like the page tree. */
export async function loadWorkspaceGraph(pool: Pool, workspaceId: string, actorId: string,
  nodeLimit = graphNodeLimit, edgeLimit = graphEdgeLimit): Promise<WorkspaceGraphResponse> {
  const nodes = await pool.query<GraphNodeRow>(nodeQuery, [workspaceId, actorId, nodeLimit + 1]);
  const ids = nodes.rows.slice(0, nodeLimit).map(row => row.id);
  const edges = ids.length < 2 ? { rows: [] as GraphEdgeRow[] }
    : await pool.query<GraphEdgeRow>(edgeQuery, [workspaceId, actorId, ids, edgeLimit + 1]);
  return assembleGraph(nodes.rows, edges.rows, nodeLimit, edgeLimit);
}

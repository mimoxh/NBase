import type { WorkspaceGraphResponse } from '@nbase/contracts';
import { request, workspacePath } from '../persistence/client';
import type { GraphSource } from './model';

/** Saved pages and links only; unsaved drafts never appear in the graph. */
export function createPersistentGraphSource(workspaceId: string): GraphSource {
  return { load: signal => request<WorkspaceGraphResponse>(`${workspacePath(workspaceId)}/graph`, 'GET', undefined, undefined, signal) };
}

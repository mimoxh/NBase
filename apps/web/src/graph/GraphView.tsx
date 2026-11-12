import { useDeferredValue, useEffect, useId, useMemo, useRef, useState } from 'react';
import { graphNodeLimit } from '@nbase/contracts';
import { Icon } from '../components/Icon';
import { GraphCanvas, type GraphCanvasHandle } from './GraphCanvas';
import { buildGraphView, colorLegend, graphDepthLimit, linkLists, nodeTitle, type GraphColorMode, type GraphSource,
  type LinkedPage } from './model';
import { useGraphData } from './useGraphData';
import './graph.css';

export interface GraphTag { id: string; name: string }

const createHint = '在正文中输入 [[ 并选择页面，即可创建双链；保存后会出现在这里。';
const truncatedNotice = `页面或链接较多，这里只显示最近更新的 ${graphNodeLimit} 个页面和其中引用次数最多的链接。`;

function LinkList({ title, empty, pages, onOpen, onSelect }: {
  title: string; empty: string; pages: LinkedPage[]; onOpen: (id: string) => void; onSelect?: (id: string) => void;
}) {
  return <section className="nb-graph-links">
    <h4>{title}<span>{pages.length}</span></h4>
    {pages.length ? <ul>{pages.map(page => <li key={page.id}>
      <button type="button" className="nb-graph-link" onClick={() => onOpen(page.id)} title={`打开「${page.title}」`}>
        <span className="nb-page-icon">{page.icon ?? '📄'}</span><span className="nb-graph-link-title">{page.title}</span>
        {page.count > 1 && <small>×{page.count}</small>}
      </button>
      {onSelect && <button type="button" className="icon-button" aria-label={`在图中选中「${page.title}」`} title="在图中选中"
        onClick={() => onSelect(page.id)}><Icon name="focus" size={14} /></button>}
    </li>)}</ul> : <p>{empty}</p>}
  </section>;
}

/** Workspace-wide graph with filters, a local mode and a keyboard-operable link list. */
export function GraphView({ source, currentPageId, tags, defaultTreeEdges = false, onOpen }: {
  source: GraphSource;
  currentPageId: string | null;
  tags?: readonly GraphTag[];
  /** The demo workspace has no saved links yet, so it starts with the page hierarchy visible. */
  defaultTreeEdges?: boolean;
  onOpen: (pageId: string) => void;
}) {
  const { data, error, loading, reload } = useGraphData(source, 0);
  const [query, setQuery] = useState('');
  const [showOrphans, setShowOrphans] = useState(true);
  const [showTree, setShowTree] = useState(defaultTreeEdges);
  const [colorMode, setColorMode] = useState<GraphColorMode>('group');
  const [selectedId, setSelectedId] = useState<string | null>(currentPageId);
  const [centreId, setCentreId] = useState<string | null>(null);
  const [depth, setDepth] = useState(1);
  const canvas = useRef<GraphCanvasHandle>(null);
  const deferredQuery = useDeferredValue(query);
  const ids = useId();

  const known = useMemo(() => new Set(data?.nodes.map(node => node.id)), [data]);
  const focusId = centreId && known.has(centreId) ? centreId : null;
  const view = useMemo(() => data ? buildGraphView(data, { query: deferredQuery, showOrphans, showTree, focusId, depth }) : null,
    [data, deferredQuery, showOrphans, showTree, focusId, depth]);
  const selected = selectedId ? data?.nodes.find(node => node.id === selectedId) ?? null : null;
  const lists = useMemo(() => data && selected ? linkLists(data, selected.id) : null, [data, selected]);
  const tagNames = useMemo(() => new Map((tags ?? []).map(tag => [tag.id, tag.name])), [tags]);
  const legend = useMemo(() => view ? colorLegend(view, colorMode, tagNames) : [], [view, colorMode, tagNames]);
  const ranked = useMemo(() => view ? [...view.nodes].sort((a, b) => b.degree - a.degree || nodeTitle(a).localeCompare(nodeTitle(b), 'zh-Hans-CN')).slice(0, 40) : [],
    [view]);
  // A changed node set (local mode, filters) deserves a fresh fit; pan and zoom are kept otherwise.
  const nodeCount = view?.nodes.length ?? 0;
  useEffect(() => { canvas.current?.fit(); }, [focusId, depth, nodeCount === 0]);

  const centreCandidate = selected?.id ?? (currentPageId && known.has(currentPageId) ? currentPageId : null);
  const hasTags = Boolean(data?.nodes.some(node => node.tagIds.length));
  const noLinks = Boolean(data && data.nodes.length > 0 && data.edges.length === 0);

  return <div className="nb-graph">
    <div className="nb-graph-bar" role="group" aria-label="关系图设置">
      <input type="search" className="nb-graph-filter" value={query} placeholder="按标题筛选" aria-label="按标题筛选页面"
        onChange={event => setQuery(event.target.value)} />
      <label><input type="checkbox" checked={showOrphans} disabled={Boolean(focusId)} onChange={event => setShowOrphans(event.target.checked)} />孤立页面</label>
      <label><input type="checkbox" checked={showTree} onChange={event => setShowTree(event.target.checked)} />层级连线</label>
      <label htmlFor={`${ids}-color`}>着色
        <select id={`${ids}-color`} value={colorMode} onChange={event => setColorMode(event.target.value as GraphColorMode)}>
          <option value="group">按顶层页面</option>
          <option value="tag" disabled={!hasTags}>按标签</option>
          <option value="none">不着色</option>
        </select></label>
      <label><input type="checkbox" checked={Boolean(focusId)} disabled={!focusId && !centreCandidate}
        onChange={event => setCentreId(event.target.checked ? centreCandidate : null)} />局部模式</label>
      {focusId && <label htmlFor={`${ids}-depth`}>深度 {depth}
        <input id={`${ids}-depth`} type="range" min={1} max={graphDepthLimit} step={1} value={depth}
          onChange={event => setDepth(Number(event.target.value))} /></label>}
      <span className="nb-graph-bar-end">
        <button type="button" className="icon-button" aria-label="缩小" title="缩小" onClick={() => canvas.current?.zoomBy(1 / 1.3)}>−</button>
        <button type="button" className="icon-button" aria-label="放大" title="放大" onClick={() => canvas.current?.zoomBy(1.3)}>+</button>
        <button type="button" className="nb-btn nb-btn-quiet" onClick={() => canvas.current?.fit()}>适应窗口</button>
        <button type="button" className="nb-btn nb-btn-quiet" disabled={loading} onClick={reload}>刷新</button>
      </span>
    </div>
    {data?.truncated && <p className="nb-graph-note" role="status">{truncatedNotice}</p>}
    {noLinks && <p className="nb-graph-note">还没有页面之间的链接。{createHint}
      {!showTree && <button type="button" className="nb-btn nb-btn-quiet" onClick={() => setShowTree(true)}>先看页面层级</button>}</p>}
    {error && data && <p className="nb-graph-note" role="alert">{error}当前显示的是上一次读取的结果。</p>}
    <div className="nb-graph-body">
      <div className="nb-graph-stage">
        {!data && !error && <p className="nb-graph-state" role="status">正在读取关系图…</p>}
        {!data && error && <p className="nb-graph-state" role="alert">{error}
          <button type="button" className="nb-btn" onClick={reload}>重试</button></p>}
        {data && data.nodes.length === 0 && <div className="nb-graph-state"><strong>还没有页面</strong><p>新建页面后，{createHint}</p></div>}
        {view && data && data.nodes.length > 0 && <>
          <GraphCanvas ref={canvas} view={view} colorMode={colorMode} selectedId={selectedId} currentId={focusId ?? currentPageId}
            label={`页面关系图，${view.nodes.length} 个页面，${view.links.length} 条连线。方向键平移，加减号缩放，0 适应窗口，Enter 打开所选页面；也可以使用旁边的页面列表。`}
            onSelect={setSelectedId} onOpen={onOpen} />
          {view.nodes.length === 0 && <p className="nb-graph-state">没有符合筛选条件的页面。</p>}
          <p className="nb-graph-count" aria-live="polite">{view.nodes.length} 个页面 · {view.links.length} 条连线{loading ? ' · 正在刷新…' : ''}</p>
          {legend.length > 0 && <ul className="nb-graph-legend" aria-label="颜色图例">{legend.map(item => <li key={item.key}>
            <i style={{ background: item.color }} />{item.label}<small>{item.count}</small></li>)}</ul>}
        </>}
      </div>
      {data && data.nodes.length > 0 && <aside className="nb-graph-side" aria-label="页面与链接列表">
        {selected && lists ? <>
          <h3><span className="nb-page-icon">{selected.icon ?? (selected.kind === 'database' ? '🗃️' : '📄')}</span>{nodeTitle(selected)}</h3>
          <p className="nb-graph-meta">链接到 {lists.outgoing.length} 个页面 · 被 {lists.incoming.length} 个页面链接
            {selected.kind === 'database' ? ' · 含数据库各行正文中的链接' : ''}</p>
          <div className="nb-graph-actions">
            <button type="button" className="nb-btn nb-btn-primary" onClick={() => onOpen(selected.id)}>打开页面</button>
            {focusId === selected.id
              ? <button type="button" className="nb-btn" onClick={() => setCentreId(null)}>退出局部模式</button>
              : <button type="button" className="nb-btn" onClick={() => setCentreId(selected.id)}>以此为中心</button>}
            <button type="button" className="nb-btn nb-btn-quiet" onClick={() => setSelectedId(null)}>取消选择</button>
          </div>
          <LinkList title="链接到" empty="这个页面没有引用其他页面。" pages={lists.outgoing} onOpen={onOpen} onSelect={setSelectedId} />
          <LinkList title="被链接" empty="还没有页面引用它。" pages={lists.incoming} onOpen={onOpen} onSelect={setSelectedId} />
        </> : <>
          <h3>页面</h3>
          <p className="nb-graph-meta">点击节点查看它的链接，双击或按 Enter 打开页面。拖动空白处平移，滚轮或双指缩放。</p>
          {ranked.length > 0 && <section className="nb-graph-links"><h4>连接最多<span>{ranked.length}</span></h4>
            <ul>{ranked.map(node => <li key={node.id}>
              <button type="button" className="nb-graph-link" onClick={() => setSelectedId(node.id)}>
                <span className="nb-page-icon">{node.icon ?? (node.kind === 'database' ? '🗃️' : '📄')}</span>
                <span className="nb-graph-link-title">{nodeTitle(node)}</span><small>{node.degree}</small></button>
            </li>)}</ul></section>}
        </>}
      </aside>}
    </div>
  </div>;
}

/** Neighbourhood of one page, shown under the document next to the backlinks. */
export function LocalGraphView({ source, pageId, refreshKey, onOpen, onExpand }: {
  source: GraphSource; pageId: string; refreshKey: unknown; onOpen: (pageId: string) => void; onExpand?: () => void;
}) {
  const { data, error, loading, reload } = useGraphData(source, refreshKey, 1500);
  const [depth, setDepth] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const view = useMemo(() => data ? buildGraphView(data, { query: '', showOrphans: true, showTree: false, focusId: pageId, depth }) : null,
    [data, pageId, depth]);
  const present = Boolean(view?.index.has(pageId));
  const linked = present && view!.nodes.length > 1;
  const selected = selectedId && selectedId !== pageId ? view?.nodes.find(node => node.id === selectedId) ?? null : null;
  const others = useMemo(() => view ? view.nodes.filter(node => node.id !== pageId)
    .sort((a, b) => a.distance - b.distance || nodeTitle(a).localeCompare(nodeTitle(b), 'zh-Hans-CN')).slice(0, 30) : [], [view, pageId]);

  return <div className="nb-graph-local">
    {!data && !error && <p role="status">正在读取关系图…</p>}
    {error && <p role="alert">{error} <button type="button" className="nb-btn nb-btn-quiet" onClick={reload}>重试</button></p>}
    {data && !linked && <p>{present ? `这个页面还没有与其他页面的已保存链接。${createHint}` : '这个页面暂时不在关系图中；数据库的行会并入所属数据库。'}</p>}
    {view && linked && <>
      <div className="nb-graph-local-bar">
        <span role="group" aria-label="邻域深度">
          {[1, 2].map(value => <button key={value} type="button" className={`nb-btn nb-btn-quiet ${depth === value ? 'selected' : ''}`}
            aria-pressed={depth === value} onClick={() => setDepth(value)}>{value} 层</button>)}
        </span>
        <span className="nb-graph-count">{view.nodes.length - 1} 个相关页面{loading ? ' · 正在刷新…' : ''}</span>
        {onExpand && <button type="button" className="nb-btn nb-btn-quiet" onClick={onExpand}>打开完整关系图</button>}
      </div>
      <div className="nb-graph-local-stage">
        <GraphCanvas view={view} colorMode="none" selectedId={selectedId} currentId={pageId} compact
          label={`当前页面的关系图，${view.nodes.length - 1} 个相关页面。可以使用下方的页面列表打开。`}
          onSelect={setSelectedId} onOpen={id => { if (id !== pageId) onOpen(id); }} />
      </div>
      {selected && <p className="nb-graph-local-selected"><strong>{nodeTitle(selected)}</strong>
        <button type="button" className="nb-btn nb-btn-quiet" onClick={() => onOpen(selected.id)}>打开页面</button></p>}
      <ul className="nb-graph-chips" aria-label="相关页面">{others.map(node => <li key={node.id}>
        <button type="button" className="nb-btn nb-btn-quiet" onClick={() => onOpen(node.id)} onFocus={() => setSelectedId(node.id)}>
          {node.icon ?? '📄'} {nodeTitle(node)}</button></li>)}</ul>
      {data?.truncated && <p>{truncatedNotice}</p>}
    </>}
  </div>;
}

const paths = {
  select: 'M5 3l14 8-6 1.5L10 19z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V11m0-6.5v-1a1.5 1.5 0 0 1 3 0V11m0-5.5a1.5 1.5 0 0 1 3 0V12m0-3.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1.5a6 6 0 0 1-4.6-2.2L4.5 15.6a1.6 1.6 0 0 1 2.3-2.2L8 14.6',
  rect: 'M4 5h16v14H4z', roundRect: 'M8 5h8a4 4 0 0 1 4 4v6a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V9a4 4 0 0 1 4-4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z', diamond: 'M12 3l9 9-9 9-9-9z', triangle: 'M12 4l9 16H3z',
  text: 'M5 6V4h14v2M12 4v16M9 20h6', note: 'M5 4h14v10l-6 6H5zM13 20v-6h6',
  connector: 'M5 19L19 5m0 0h-7m7 0v7', elbow: 'M4 18h6V6h10m0 0-3-3m3 3-3 3', curve: 'M4 19C4 9 20 15 20 5m0 0-3.5 1.5M20 5l-1 3.6',
  straight: 'M4 20L20 4m0 0h-6m6 0v6',
  pen: 'M4 20l4-1 11-11-3-3L5 16zM14 6l3 3', highlighter: 'M9 11l-5 5v4h4l5-5M9 11l6-6 4 4-6 6M9 11l4 4M4 20h8',
  eraser: 'M8 20h12M5 15l9-9a2 2 0 0 1 3 0l2 2a2 2 0 0 1 0 3l-8 8H8z', frame: 'M7 3v18M17 3v18M3 7h18M3 17h18',
  image: 'M4 5h16v14H4zM4 15l5-5 4 4 3-3 4 4M9 9h.01', card: 'M4 6h16v12H4zM8 10h8M8 14h5', table: 'M4 5h16v14H4zM4 10h16M4 15h16M10 5v14', mind: 'M9 12h4m0 0 3-5h4m-7 5 3 5h4M3 10h6v4H3z',
  undo: 'M9 14 4 9l5-5M4 9h11a5 5 0 0 1 0 10h-3', redo: 'm15 14 5-5-5-5M20 9H9a5 5 0 0 0 0 10h3',
  zoomIn: 'M11 8v6M8 11h6M20 20l-4.5-4.5M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0', zoomOut: 'M8 11h6M20 20l-4.5-4.5M18 11a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5', minimap: 'M3 5h18v14H3zM13 11h6v6h-6z', grid: 'M4 4h16v16H4zM4 12h16M12 4v16',
  play: 'M7 4l13 8-13 8z', download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', more: 'M5 12h.01M12 12h.01M19 12h.01',
  lock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3', unlock: 'M6 11h12v9H6zM8 11V8a4 4 0 0 1 7.5-2',
  group: 'M3 3h7v7H3zM14 14h7v7h-7zM14 6h4v4M10 18H6v-4', ungroup: 'M3 3h7v7H3zM14 14h7v7h-7z',
  alignLeft: 'M4 3v18M8 7h10v4H8zM8 14h6v4H8z', alignHCenter: 'M12 3v18M6 7h12v4H6zM8 14h8v4H8z', alignRight: 'M20 3v18M6 7h10v4H6zM10 14h6v4h-6z',
  alignTop: 'M3 4h18M7 8h4v10H7zM14 8h4v6h-4z', alignVCenter: 'M3 12h18M7 6h4v12H7zM14 8h4v8h-4z', alignBottom: 'M3 20h18M7 6h4v10H7zM14 10h4v6h-4z',
  distributeH: 'M4 4v16M20 4v16M9 8h6v8H9z', distributeV: 'M4 4h16M4 20h16M8 9h8v6H8z',
  front: 'M8 8h12v12H8zM4 4h10v2M4 4v10h2', back: 'M4 4h12v12H4zM10 20h10V10',
  textLeft: 'M4 6h16M4 10h10M4 14h16M4 18h10', textCenter: 'M4 6h16M7 10h10M4 14h16M7 18h10', textRight: 'M4 6h16M10 10h10M4 14h16M10 18h10',
  bold: 'M7 4h6a4 4 0 0 1 0 8H7zM7 12h7a4 4 0 0 1 0 8H7z', open: 'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  arrowNone: 'M4 12h16', arrowEnd: 'M4 12h16m-5-5 5 5-5 5', arrowStart: 'M20 12H4m5-5-5 5 5 5', arrowBoth: 'M4 12h16M9 7l-5 5 5 5M15 7l5 5-5 5',
  close: 'm6 6 12 12M6 18 18 6', prev: 'm15 5-7 7 7 7', next: 'm9 5 7 7-7 7', search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
} as const;

export type BoardIconName = keyof typeof paths;

export function BoardIcon({ name, size = 18 }: { name: BoardIconName; size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round"
    strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}

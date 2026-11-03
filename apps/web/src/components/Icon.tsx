const paths = {
 search: 'm21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0', plus: 'M12 5v14M5 12h14',
 page: 'M14 2H5v20h14V7zM14 2v5h5M8 12h8M8 16h6', chevron: 'm9 5 7 7-7 7',
 home: 'm3 10 9-7 9 7v11h-6v-7H9v7H3z', clock: 'M12 8v5l3 2M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',
 star: 'm12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z',
 trash: 'M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7', settings: 'M4 7h16M4 17h16M8 4v6M16 14v6',
 code: 'm8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16', focus: 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5',
 menu: 'M4 6h16M4 12h16M4 18h16', more: 'M5 12h.01M12 12h.01M19 12h.01', close: 'm6 6 12 12M6 18 18 6',
 download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5', upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
 arrow: 'M4 12h16m-6-6 6 6-6 6', restore: 'M3 10a9 9 0 1 1 1 8M3 3v7h7', folder: 'M3 5h7l2 3h9v12H3z',
 check: 'm5 12 4 4L19 6', sun: 'M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 18 }: { name: IconName; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>; }

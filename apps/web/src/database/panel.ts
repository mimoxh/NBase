/** The one popover a database view has open at a time. */
export type Panel = { kind: 'filter' | 'sort' | 'props' | 'add-property' | 'views' | 'data' | 'add-relation' | 'history' } | { kind: 'header'; id: string } | null;

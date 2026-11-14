// Marker styles cycle with the overall nesting depth, the same way Word export numbers its levels.
export const listTheme = {
  ul: 'nbase-list-ul', ol: 'nbase-list-ol',
  ulDepth: ['nbase-ul-disc', 'nbase-ul-circle', 'nbase-ul-square'],
  olDepth: ['nbase-ol-decimal', 'nbase-ol-alpha', 'nbase-ol-roman'],
  listitem: 'nbase-list-item', listitemChecked: 'nbase-check-checked', listitemUnchecked: 'nbase-check-unchecked',
  nested: { listitem: 'nbase-list-nested' },
};

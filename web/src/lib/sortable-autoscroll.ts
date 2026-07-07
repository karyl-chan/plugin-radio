// Shared SortableJS auto-scroll tuning — spread into every drag-reorder
// Sortable.create() so a long list scrolls its container when the drag nears
// an edge, and the sensitivity/speed live in one place (they can't drift
// between the queue list and the playlist-editor list).
export const SORTABLE_AUTOSCROLL = {
  scroll: true,
  bubbleScroll: true,
  scrollSensitivity: 80,
  scrollSpeed: 14,
};

// The plugin WebUI can't reach api.iconify.design at runtime, so any
// @iconify/vue <Icon icon="material-symbols:…"/> that the shared @karyl-chan/ui
// components render (AppButton's loading spinner, AppModal's close button,
// AppItemCard's chevron) would otherwise come up blank. Register the handful of
// icons the ui library actually references OFFLINE, with self-contained SVG
// bodies — no network fetch. Keep this list in sync with the ui usages
// (grep @karyl-chan/ui for `material-symbols:`).
import { addIcon } from "@iconify/vue";

const CHEVRON =
  'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';

// AppButton's loading spinner — a 3/4 ring the button spins via CSS.
addIcon("material-symbols:progress-activity", {
  width: 24,
  height: 24,
  body: '<path fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" d="M12 3a9 9 0 1 0 9 9"/>',
});
// AppModal / AppConfirmDialog close button.
addIcon("material-symbols:close-rounded", {
  width: 24,
  height: 24,
  body: `<path ${CHEVRON} d="M6 6l12 12M18 6L6 18"/>`,
});
// AppItemCard expand/collapse chevrons.
addIcon("material-symbols:expand-less-rounded", {
  width: 24,
  height: 24,
  body: `<path ${CHEVRON} d="m6 15 6-6 6 6"/>`,
});
addIcon("material-symbols:expand-more-rounded", {
  width: 24,
  height: 24,
  body: `<path ${CHEVRON} d="m6 9 6 6 6-6"/>`,
});

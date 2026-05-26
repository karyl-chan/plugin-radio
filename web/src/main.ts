import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
// @karyl-chan/ui tokens supply the palette AppButton / AppModal expect.
// The shared reset.css is intentionally skipped — it locks body scroll
// for the bot frontend's sidebar-driven layout, which would prevent
// long ManageView lists from scrolling. The plugin's own global.css
// already supplies the box-sizing / font-family reset.
import "@karyl-chan/ui/tokens.css";
import "@karyl-chan/ui/use-drawer.css";
import "@karyl-chan/ui/use-popover.css";
import "./styles/global.css";

createApp(App).use(createPinia()).mount("#app");

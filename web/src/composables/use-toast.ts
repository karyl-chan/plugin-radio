import { ref } from "vue";

export type ToastKind = "ok" | "error" | "info";

interface ToastState {
  message: string;
  kind: ToastKind;
  visible: boolean;
}

const state = ref<ToastState>({ message: "", kind: "info", visible: false });
let timer: number | undefined;

function show(message: string, kind: ToastKind = "info"): void {
  state.value = { message, kind, visible: true };
  if (timer !== undefined) window.clearTimeout(timer);
  timer = window.setTimeout(() => {
    state.value = { ...state.value, visible: false };
  }, 3200);
}

export function useToast() {
  return {
    state,
    toast: (msg: string, kind: ToastKind = "info") => show(msg, kind),
    ok: (msg: string) => show(msg, "ok"),
    error: (msg: string) => show(msg, "error"),
  };
}

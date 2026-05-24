<script setup lang="ts">
import { useToast } from "../composables/use-toast";
const { state } = useToast();
</script>

<template>
  <Teleport to="body">
    <Transition name="toast">
      <div
        v-if="state.visible"
        class="app-toast"
        :class="`app-toast--${state.kind}`"
        role="status"
      >
        {{ state.message }}
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.app-toast {
  position: fixed;
  bottom: 1.25rem;
  left: 50%;
  transform: translateX(-50%);
  padding: 0.6rem 1.15rem;
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
  background: var(--bg-surface);
  color: var(--text);
  border: 1px solid var(--border);
  box-shadow: var(--shadow-md);
  z-index: 100;
  max-width: 90vw;
}
.app-toast--ok {
  border-color: var(--success);
  color: var(--success);
  background: var(--success-bg);
}
.app-toast--error {
  border-color: var(--danger);
  color: var(--danger);
  background: var(--danger-bg);
}

.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(8px);
}
</style>

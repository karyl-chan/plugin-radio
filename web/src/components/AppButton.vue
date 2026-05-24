<script setup lang="ts">
/**
 * AppButton — variant / size / loading / disabled / block.
 * Mirrors karyl-chan/frontend's AppButton API in a minimal form.
 */
withDefaults(
  defineProps<{
    variant?: "primary" | "secondary" | "ghost" | "danger";
    size?: "sm" | "md" | "lg";
    loading?: boolean;
    disabled?: boolean;
    block?: boolean;
    type?: "button" | "submit";
    title?: string;
  }>(),
  {
    variant: "primary",
    size: "md",
    loading: false,
    disabled: false,
    block: false,
    type: "button",
    title: undefined,
  },
);
</script>

<template>
  <button
    :type="type"
    :title="title"
    :class="[
      'app-btn',
      `app-btn--${variant}`,
      `app-btn--${size}`,
      { 'app-btn--block': block, 'app-btn--loading': loading },
    ]"
    :disabled="disabled || loading"
  >
    <span v-if="loading" class="app-btn-spinner" aria-hidden="true" />
    <slot />
  </button>
</template>

<style scoped>
.app-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.35rem;
  border-radius: var(--radius-sm);
  font-weight: 550;
  cursor: pointer;
  white-space: nowrap;
  transition: filter var(--transition-fast), background var(--transition-fast),
    opacity var(--transition-fast);
  flex-shrink: 0;
  border: 1px solid transparent;
  line-height: 1.2;
}

.app-btn--block { width: 100%; }

.app-btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.app-btn--sm { padding: 0.32rem 0.65rem; font-size: 0.82rem; }
.app-btn--md { padding: 0.5rem 0.95rem; font-size: 0.88rem; }
.app-btn--lg { padding: 0.65rem 1.2rem; font-size: 0.95rem; }

.app-btn--primary {
  background: var(--accent);
  color: var(--text-on-accent);
  border-color: var(--accent);
}
.app-btn--primary:not(:disabled):hover { filter: brightness(1.1); }

.app-btn--secondary {
  background: var(--bg-surface-2);
  color: var(--text);
  border-color: var(--border);
}
.app-btn--secondary:not(:disabled):hover { background: var(--bg-surface-hover); }

.app-btn--ghost {
  background: transparent;
  color: var(--text);
  border-color: var(--border);
}
.app-btn--ghost:not(:disabled):hover { background: var(--bg-surface-hover); }

.app-btn--danger {
  background: transparent;
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 40%, transparent);
}
.app-btn--danger:not(:disabled):hover {
  background: color-mix(in srgb, var(--danger) 10%, transparent);
}

@keyframes app-btn-spin { to { transform: rotate(360deg); } }
.app-btn-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid currentColor;
  border-right-color: transparent;
  animation: app-btn-spin 0.7s linear infinite;
  flex-shrink: 0;
}
</style>

<script setup lang="ts">
import { ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    src?: string;
    size?: "sm" | "lg";
    placeholder?: string;
  }>(),
  { size: "sm", placeholder: "🎵" },
);

const failed = ref(false);
watch(
  () => props.src,
  () => {
    failed.value = false;
  },
);
</script>

<template>
  <img
    v-if="src && !failed"
    class="thumb"
    :class="`thumb--${size}`"
    :src="src"
    alt=""
    @error="failed = true"
  />
  <div v-else class="thumb thumb--placeholder" :class="`thumb--${size}`">
    {{ placeholder }}
  </div>
</template>

<style scoped>
.thumb {
  display: block;
  border-radius: var(--radius-sm);
  object-fit: cover;
  background: var(--bg-surface-2);
  flex-shrink: 0;
}
.thumb--sm { width: 44px; height: 44px; }
.thumb--lg { width: 96px; height: 96px; border-radius: var(--radius); }
.thumb--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-faint);
  font-size: 1.1rem;
}
.thumb--lg.thumb--placeholder { font-size: 2rem; }
</style>

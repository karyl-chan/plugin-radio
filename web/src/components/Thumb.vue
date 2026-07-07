<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { coverSrc } from "../lib/cover-src";

const props = withDefaults(
  defineProps<{
    src?: string;
    size?: "sm" | "lg";
    placeholder?: string;
  }>(),
  { size: "sm", placeholder: "🎵" },
);

// Uploaded covers are stored as root-relative `/cover/…` paths — prefix them
// with the plugin mount base so they resolve under the bot proxy.
const resolvedSrc = computed(() => coverSrc(props.src));

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
    v-if="resolvedSrc && !failed"
    class="thumb"
    :class="`thumb--${size}`"
    :src="resolvedSrc"
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

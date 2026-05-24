<script setup lang="ts">
import { isExternalUrl } from "../composables/use-format";

defineProps<{ label: string; url?: string }>();
</script>

<template>
  <a
    v-if="isExternalUrl(url)"
    class="src"
    :href="url"
    target="_blank"
    rel="noopener noreferrer"
  >{{ label }}</a>
  <span v-else>{{ label }}</span>
</template>

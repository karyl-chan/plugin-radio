<script setup lang="ts">
defineProps<{ message: string }>();
</script>

<template>
  <div class="center-msg">
    <h2>Access denied</h2>
    <p>{{ message }}</p>
    <p style="margin-top: 0.9rem">
      Use <code>/radio manage</code> or a <strong>play</strong>/<strong>queue</strong>
      response button to get a fresh link.
    </p>
  </div>
</template>

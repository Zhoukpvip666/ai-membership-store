<script setup lang="ts">
import { computed } from 'vue'
import { linkifyText } from './text-links'

const props = defineProps<{ text: string }>()
const segments = computed(() => linkifyText(props.text))
</script>

<template>
  <span class="linked-text"
    ><template v-for="(segment, index) in segments" :key="index"
      ><a
        v-if="segment.href"
        :href="segment.href"
        target="_blank"
        rel="noopener noreferrer"
        >{{ segment.text }}</a
      ><template v-else>{{ segment.text }}</template></template
    ></span
  >
</template>

<style scoped>
.linked-text {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.linked-text a {
  color: var(--store-brand, #1d4ed8);
  text-decoration: underline;
  text-underline-offset: 0.17em;
}
.linked-text a:focus-visible {
  outline: 2px solid currentColor;
  outline-offset: 2px;
}
</style>

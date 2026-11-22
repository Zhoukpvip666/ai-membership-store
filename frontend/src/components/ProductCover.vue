<script setup lang="ts">
import { ref, watch } from 'vue'
import { Image } from '@lucide/vue'

const props = defineProps<{
  src: string | null
  lazy?: boolean
  alt?: string
}>()
const failed = ref(false)
watch(
  () => props.src,
  () => (failed.value = false),
)
</script>

<template>
  <div class="product-cover">
    <img
      v-if="src && !failed"
      :key="src"
      :src="src"
      :alt="alt ?? ''"
      :loading="lazy ? 'lazy' : 'eager'"
      decoding="async"
      @error="failed = true"
    />
    <div v-else class="product-cover-placeholder" aria-hidden="true">
      <Image :size="32" :stroke-width="1.5" />
    </div>
  </div>
</template>

<style scoped>
.product-cover {
  position: relative;
  width: 100%;
  min-width: 0;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--store-canvas, #f5f7fb);
}
.product-cover img,
.product-cover-placeholder {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.product-cover img {
  display: block;
  object-fit: cover;
  object-position: center;
}
.product-cover-placeholder {
  display: grid;
  place-items: center;
  color: var(--store-secondary, #62738b);
}
</style>

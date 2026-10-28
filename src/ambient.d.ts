// Ambient module declarations so plain `tsc --noEmit` can resolve the
// non-TS imports in the renderer (Vite handles these at build time).
declare module '*.svelte' {
  import type { Component } from 'svelte'
  const component: Component
  export default component
}

declare module '*.css'

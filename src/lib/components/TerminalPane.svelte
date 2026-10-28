<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import { Terminal } from '@xterm/xterm'
  import { FitAddon } from '@xterm/addon-fit'
  import '@xterm/xterm/css/xterm.css'
  import { api } from '../api'
  import type { Agent } from '../types'

  export let agent: Agent

  let container: HTMLElement
  let noSession = false

  let term: Terminal
  let fit: FitAddon
  let lastSeq = 0
  let attached = false
  let pending: { data: string; seq: number }[] = []
  let unsubscribe: (() => void) | null = null
  let observer: ResizeObserver | null = null

  onMount(() => {
    term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12.5,
      theme: {
        background: '#0e1014',
      },
      scrollback: 5000,
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)

    term.onData((data) => {
      void api.writeTerminal(agent.id, data)
    })

    // subscribe before attaching so no chunk is missed; chunks that arrived
    // before the attach snapshot are stashed and filtered by sequence number
    unsubscribe = api.onTerminalData((agentId, data, seq) => {
      if (agentId !== agent.id) return
      if (!attached) {
        pending.push({ data, seq })
        return
      }
      if (seq <= lastSeq) return
      lastSeq = seq
      term.write(data)
    })

    void api.attachTerminal(agent.id).then((snap) => {
      attached = true
      if (!snap) {
        noSession = true
        return
      }
      term.write(snap.buffer)
      lastSeq = snap.seq
      for (const p of pending) {
        if (p.seq > lastSeq) {
          lastSeq = p.seq
          term.write(p.data)
        }
      }
      pending = []
    })

    observer = new ResizeObserver(() => {
      if (!container.clientWidth || !container.clientHeight) return
      try {
        fit.fit()
        void api.resizeTerminal(agent.id, term.cols, term.rows)
      } catch {
        // terminal already disposed
      }
    })
    observer.observe(container)
  })

  onDestroy(() => {
    unsubscribe?.()
    observer?.disconnect()
    term?.dispose()
  })
</script>

<div class="terminal-shell">
  <div class="terminal-pane" bind:this={container}></div>
  {#if noSession}
    <div class="terminal-unavailable">
      No terminal output for this session — the agent ran before the app was (re)started.
    </div>
  {/if}
</div>

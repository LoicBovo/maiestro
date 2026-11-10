<script lang="ts">
  import { createEventDispatcher } from 'svelte'
  import { projects } from '../state'
  import type { Agent } from '../types'
  import StatusBadge from './StatusBadge.svelte'

  export let agent: Agent
  export let selected = false

  const dispatch = createEventDispatcher<{ select: void; remove: void }>()

  $: shortTask = agent.task.length > 90 ? agent.task.slice(0, 87) + '…' : agent.task
  $: isShell = agent.tool === 'shell'
  // the tile is identified by the last folder of its working directory
  // (e.g. /Users/toto/info -> "info"), not by the agent's name
  $: cwdFolder = agent.cwd.split('/').filter(Boolean).slice(-1)[0]
  // a shell pane is pinned to its project — the tag names it, not the branch
  $: tileLabel = isShell
    ? agent.projectId == null
      ? 'solo'
      : $projects.find((p) => p.id === agent.projectId)?.name ?? 'solo'
    : agent.branch ??
      (agent.projectId == null ? 'solo' : $projects.find((p) => p.id === agent.projectId)?.name ?? 'solo')
</script>

<div
  class="agent-card"
  class:selected
  role="button"
  tabindex="0"
  on:click={() => dispatch('select')}
  on:keydown={(e) => (e.key === 'Enter' || e.key === ' ') && dispatch('select')}
>
  <div class="card-top">
    <span class="tool-tag tool-{agent.tool}">{agent.tool}</span>
    <span class="project-tag" title={agent.cwd}>{tileLabel}</span>
    {#if !isShell}
      <StatusBadge status={agent.status} />
    {/if}
    {#if !isShell}
      <button class="card-remove" title="Close agent (removes it from the console)" on:click|stopPropagation={() => dispatch('remove')}>x</button>
    {/if}
  </div>
  {#if cwdFolder}
    <div class="agent-name" title={agent.cwd}>{cwdFolder}</div>
  {/if}
  {#if agent.task}
    <div class="task-text" title={agent.task}>{shortTask}</div>
  {/if}
</div>

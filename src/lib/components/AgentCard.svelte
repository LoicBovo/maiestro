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
  $: tileLabel =
    agent.branch ??
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
    <span class="tool-tag tool-{agent.tool}">{isShell ? 'cli' : agent.tool}</span>
    <span class="project-tag" title={agent.cwd}>{tileLabel}</span>
    <StatusBadge status={agent.status} />
    {#if !isShell}
      <button class="card-remove" title="Close agent (removes it from the console)" on:click|stopPropagation={() => dispatch('remove')}>x</button>
    {/if}
  </div>
  {#if agent.name}
    <div class="agent-name" title={agent.name}>{agent.name}</div>
  {/if}
  {#if agent.task}
    <div class="task-text" title={agent.task}>{shortTask}</div>
  {/if}
  {#if agent.lastMessage}
    <div class="last-msg">{agent.lastMessage}</div>
  {/if}
</div>

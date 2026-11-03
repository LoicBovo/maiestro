<script lang="ts">
  import { agents, matchesFilter, projectFilter, statusFilter, toolFilter, visibleAgents } from '../state'
  import type { AgentStatus, AgentTool } from '../types'

  const tools: Array<'all' | AgentTool> = ['all', 'claude', 'vibe', 'shell']
  const statuses: Array<'all' | AgentStatus> = ['all', 'running', 'blocked', 'done', 'error', 'stopped']
  const toolLabel = (t: 'all' | AgentTool): string =>
    t === 'all' ? 'All tools' : t === 'shell' ? 'cli' : t
  $: total = $agents.filter((a) => matchesFilter(a, $projectFilter)).length
</script>

<div class="filter-bar">
  <span class="count">{$visibleAgents.length} of {total}</span>
  <select bind:value={$toolFilter} title="Filter by tool">
    {#each tools as t}
      <option value={t}>{toolLabel(t)}</option>
    {/each}
  </select>
  <select bind:value={$statusFilter} title="Filter by status">
    {#each statuses as s}
      <option value={s}>{s === 'all' ? 'All statuses' : s}</option>
    {/each}
  </select>
</div>

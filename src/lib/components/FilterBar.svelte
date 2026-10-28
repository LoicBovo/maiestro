<script lang="ts">
  import { agents, statusFilter, toolFilter, visibleAgents } from '../state'
  import type { AgentStatus, AgentTool } from '../types'

  const tools: Array<'all' | AgentTool> = ['all', 'claude', 'vibe']
  const statuses: Array<'all' | AgentStatus> = ['all', 'running', 'blocked', 'done', 'error', 'stopped']
</script>

<div class="filter-bar">
  <span class="count">{$visibleAgents.length} of {$agents.length}</span>
  <select bind:value={$toolFilter} title="Filter by tool">
    {#each tools as t}
      <option value={t}>{t === 'all' ? 'All tools' : t}</option>
    {/each}
  </select>
  <select bind:value={$statusFilter} title="Filter by status">
    {#each statuses as s}
      <option value={s}>{s === 'all' ? 'All statuses' : s}</option>
    {/each}
  </select>
</div>

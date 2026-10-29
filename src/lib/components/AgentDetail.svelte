<script lang="ts">
  import { afterUpdate } from 'svelte'
  import { api } from '../api'
  import { projects, selectedEvents, selectAgent } from '../state'
  import type { Agent } from '../types'
  import StatusBadge from './StatusBadge.svelte'
  import TerminalPane from './TerminalPane.svelte'

  export let agent: Agent

  const policies = ['ask', 'plan', 'accept-edits', 'smart-approve', 'auto-approve']

  let logEl: HTMLElement
  let policy = 'smart-approve'
  let maxTurns = 25
  let denyMessage = ''
  let busy = ''
  let lastAgentId = ''
  let renaming = false
  let renameValue = ''
  let renameEl: HTMLInputElement

  $: projectName =
    agent.projectId == null
      ? 'solo'
      : $projects.find((p) => p.id === agent.projectId)?.name ?? 'solo'

  // reset the relaunch form when the selected agent changes (not on every
  // agents:changed push, which would clobber an in-progress edit)
  $: if (agent.id !== lastAgentId) {
    lastAgentId = agent.id
    policy = agent.options?.vibeAgent ?? 'smart-approve'
    maxTurns = agent.options?.maxTurns ?? 25
    denyMessage = ''
    renaming = false
  }

  // keep the log pinned to the bottom unless the user scrolled up to read
  afterUpdate(() => {
    if (!logEl) return
    const nearBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80
    if (nearBottom) logEl.scrollTop = logEl.scrollHeight
  })

  function fmtTime(iso: string | null): string {
    if (!iso) return '—'
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  }

  function fmtDuration(from: string, to: string | null): string {
    const ms = new Date(to ?? Date.now()).getTime() - new Date(from).getTime()
    if (ms < 1000) return ms + 'ms'
    if (ms < 60_000) return (ms / 1000).toFixed(1) + 's'
    return Math.floor(ms / 60_000) + 'm ' + Math.round((ms % 60_000) / 1000) + 's'
  }

  function fmtCost(cost: number | null): string {
    return cost == null ? '—' : '$' + cost.toFixed(4)
  }

  function safeJson(data: unknown): string {
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  }

  async function relaunch(): Promise<void> {
    busy = 'relaunch'
    try {
      const opts = agent.tool === 'vibe' ? { vibeAgent: policy, maxTurns } : undefined
      const fresh = await api.relaunchAgent(agent.id, opts)
      selectAgent(fresh.id)
    } finally {
      busy = ''
    }
  }

  async function approve(): Promise<void> {
    if (!agent.pendingPermission) return
    busy = 'perm'
    try {
      await api.decidePermission(agent.id, agent.pendingPermission.toolUseId, 'allow')
    } finally {
      busy = ''
    }
  }

  async function deny(): Promise<void> {
    if (!agent.pendingPermission) return
    busy = 'perm'
    try {
      await api.decidePermission(
        agent.id,
        agent.pendingPermission.toolUseId,
        'deny',
        denyMessage.trim() || undefined,
      )
      denyMessage = ''
    } finally {
      busy = ''
    }
  }

  function startRename(): void {
    renameValue = agent.name ?? ''
    renaming = true
  }

  function autofocus(el: HTMLInputElement): void {
    el.focus()
    el.select()
  }

  async function saveRename(): Promise<void> {
    const value = renameValue.trim()
    renaming = false
    if (value === (agent.name ?? '')) return
    try {
      await api.renameAgent(agent.id, value)
    } catch {
      // the agent was removed mid-edit; the agents:changed push covers it
    }
  }
</script>

<div class="detail-inner">
  <div class="detail-header">
    {#if renaming}
      <form class="rename-form" on:submit|preventDefault={saveRename}>
        <input
          bind:this={renameEl}
          bind:value={renameValue}
          maxlength="80"
          placeholder="Agent name"
          use:autofocus
          on:keydown={(e) => e.key === 'Escape' && (renaming = false)}
        />
        <button type="submit" class="btn">Save</button>
        <button type="button" class="btn" on:click={() => (renaming = false)}>Cancel</button>
      </form>
    {:else}
      <h2 title={agent.task}>{agent.name ?? agent.task}</h2>
      <button
        class="btn rename-btn"
        title={agent.name ? 'Rename agent' : 'Give this agent a name'}
        on:click={startRename}
      >
        {agent.name ? 'Rename' : 'Name'}
      </button>
    {/if}
    <StatusBadge status={agent.status} />
  </div>

  <div class="detail-meta">
    <span>tool <b>{agent.tool}</b></span>
    <span>project <b>{projectName}</b></span>
    <span>started <b>{fmtTime(agent.startedAt)}</b></span>
    {#if agent.endedAt}<span>ended <b>{fmtTime(agent.endedAt)}</b></span>{/if}
    <span>duration <b>{fmtDuration(agent.startedAt, agent.endedAt)}</b></span>
    <span>cost <b>{fmtCost(agent.costUsd)}</b></span>
    {#if agent.pid}<span>pid <b>{agent.pid}</b></span>{/if}
    <span>cwd <b class="cwd" title={agent.cwd}>{agent.cwd}</b></span>
  </div>

  {#if agent.options?.mode === 'terminal'}
    <div class="terminal-wrap">
      <div class="terminal-label">Embedded terminal — type here to answer the agent</div>
      {#key agent.id}
        <TerminalPane {agent} />
      {/key}
    </div>
  {/if}

  {#if agent.pendingPermission}
    <div class="permission-bar">
      <h3>Permission requested: {agent.pendingPermission.toolName}</h3>
      <div class="perm-tool">{safeJson(agent.pendingPermission.input)}</div>
      <div class="permission-actions">
        <input bind:value={denyMessage} placeholder="Deny reason (optional)" />
        <button class="btn approve" disabled={busy === 'perm'} on:click={approve}>Approve</button>
        <button class="btn danger" disabled={busy === 'perm'} on:click={deny}>Deny</button>
      </div>
    </div>
  {/if}

  <div class="detail-actions">
    {#if agent.status !== 'running'}
      {#if agent.tool === 'vibe'}
        <select bind:value={policy} title="Approval policy for the relaunch">
          {#each policies as p}
            <option value={p}>{p}</option>
          {/each}
        </select>
        <input type="number" bind:value={maxTurns} min="1" max="200" title="Max turns" />
      {/if}
      <button class="btn primary" disabled={!!busy} on:click={relaunch}>
        {busy === 'relaunch' ? 'Relaunching…' : 'Relaunch'}
      </button>
    {/if}
  </div>

  <!-- Event log hidden for now — restore this block to bring it back.
  <div class="event-log" bind:this={logEl}>
    {#each $selectedEvents as ev (ev.id)}
      <div class="event">
        <span class="ev-time">{fmtTime(ev.ts)}</span>
        <span class="ev-type ev-{ev.type}">{ev.type}</span>
        <span class="ev-text">
          {ev.text}
          {#if ev.data !== undefined}
            <details>
              <summary>data</summary>
              <pre>{safeJson(ev.data)}</pre>
            </details>
          {/if}
        </span>
      </div>
    {:else}
      <div class="empty">No events yet.</div>
    {/each}
  </div>
  -->
</div>

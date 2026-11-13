<script lang="ts">
  import { afterUpdate } from 'svelte'
  import { api } from '../api'
  import { selectedEvents } from '../state'
  import type { Agent } from '../types'
  import StatusBadge from './StatusBadge.svelte'
  import TerminalPane from './TerminalPane.svelte'

  export let agent: Agent

  $: isShell = agent.tool === 'shell'

  const policies = ['ask', 'plan', 'accept-edits', 'smart-approve', 'auto-approve']

  let logEl: HTMLElement
  let policy = 'auto-approve'
  let maxTurns = 25
  let message = ''
  let resumeError = ''
  let denyMessage = ''
  let busy = ''
  let lastAgentId = ''
  let renaming = false
  let renameValue = ''
  let renameEl: HTMLInputElement

  // reset the resume form when the selected agent changes (not on every
  // agents:changed push, which would clobber an in-progress edit)
  $: if (agent.id !== lastAgentId) {
    lastAgentId = agent.id
    policy = agent.options?.vibeAgent ?? 'auto-approve'
    maxTurns = agent.options?.maxTurns ?? 25
    message = ''
    resumeError = ''
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

  function safeJson(data: unknown): string {
    try {
      return JSON.stringify(data, null, 2)
    } catch {
      return String(data)
    }
  }

  async function resume(): Promise<void> {
    busy = 'resume'
    resumeError = ''
    try {
      const opts = agent.tool === 'vibe' ? { vibeAgent: policy, maxTurns } : undefined
      await api.resumeAgent(agent.id, message.trim() || undefined, opts)
    } catch (e) {
      resumeError = (e as Error).message
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
      <h2 title={agent.task}>
        <span class="agent-name">{agent.name ?? agent.task}</span>
        {#if !isShell}
          <button
            class="btn rename-btn"
            title={agent.name ? 'Rename agent' : 'Give this agent a name'}
            on:click={startRename}
          >
            {agent.name ? 'Rename' : 'Name'}
          </button>
        {/if}
      </h2>
    {/if}
    {#if !isShell}
      <StatusBadge status={agent.status} />
    {/if}
  </div>

  {#if agent.options?.mode === 'terminal'}
    <div class="terminal-wrap">
      <div class="terminal-label">
        {isShell ? 'shell — a plain shell in the tool' : 'Embedded terminal — type here to answer the agent'}
      </div>
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
    {#if isShell}
      {#if agent.status !== 'running'}
        <button class="btn primary" disabled={!!busy} on:click={resume}>
          {busy === 'resume' ? 'Restarting…' : 'Restart shell'}
        </button>
        {#if resumeError}<span class="resume-error">{resumeError}</span>{/if}
      {/if}
    {:else if agent.status !== 'running'}
      <input
        class="resume-message"
        bind:value={message}
        placeholder="Message (default: continue)"
        title="Follow-up prompt sent to the agent's latest session"
      />
      {#if agent.tool === 'vibe'}
        <select bind:value={policy} title="Approval policy for the resume">
          {#each policies as p}
            <option value={p}>{p}</option>
          {/each}
        </select>
        <input type="number" bind:value={maxTurns} min="1" max="200" title="Max turns" />
      {/if}
      <button class="btn primary" disabled={!!busy} on:click={resume}>
        {busy === 'resume' ? 'Resuming…' : 'Resume'}
      </button>
      {#if resumeError}<span class="resume-error">{resumeError}</span>{/if}
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

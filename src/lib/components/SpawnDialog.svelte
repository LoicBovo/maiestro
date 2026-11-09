<script lang="ts">
  import { createEventDispatcher, onMount } from 'svelte'
  import { api } from '../api'
  import { projects, selectAgent } from '../state'
  import type { AgentTool } from '../types'

  const dispatch = createEventDispatcher<{ close: void }>()

  export let initialProjectId = ''

  const policies = ['ask', 'plan', 'accept-edits', 'smart-approve', 'auto-approve']

  let tool: AgentTool | '' = ''
  let projectId = initialProjectId
  let name = ''
  let cwd = ''
  let vibeAgent = 'auto-approve'
  let maxTurns = 25
  let submitting = false
  let error = ''
  let nameEl: HTMLInputElement

  onMount(() => nameEl?.focus())

  let lastProjectId = ''
  $: selectedProject = $projects.find((p) => p.id === projectId) ?? null
  // default the working directory to the project's main folder; keep a
  // hand-picked directory when switching between projects
  $: if (projectId !== lastProjectId) {
    const prev = $projects.find((p) => p.id === lastProjectId)
    if (!cwd.trim() || (prev && prev.dirs.includes(cwd))) {
      cwd = selectedProject?.dirs[0] ?? ''
    }
    // a project with a preferred agent pre-selects it; the user can still
    // change the tool afterwards
    if (selectedProject?.preferredTool) {
      tool = selectedProject.preferredTool
    }
    lastProjectId = projectId
  }

  async function browseCwd(): Promise<void> {
    const picked = await api.pickDirectory()
    if (picked) cwd = picked
  }

  async function submit(): Promise<void> {
    if (!tool) return
    submitting = true
    error = ''
    try {
      const agent = await api.spawnAgent({
        tool,
        name: name.trim() || undefined,
        cwd: cwd.trim(),
        projectId: projectId || null,
        options: {
          mode: 'terminal',
          ...(tool === 'vibe' ? { vibeAgent, maxTurns } : {}),
        },
      })
      selectAgent(agent.id)
      dispatch('close')
    } catch (e) {
      error = String((e as Error)?.message ?? e)
    } finally {
      submitting = false
    }
  }
</script>

<svelte:window on:keydown={(e) => e.key === 'Escape' && dispatch('close')} />

<div
  class="modal-backdrop"
  role="presentation"
  on:click|self={() => dispatch('close')}
  on:keydown={(e) => e.key === 'Escape' && dispatch('close')}
>
  <div class="modal">
    <h2>Spawn agent</h2>
    <form on:submit|preventDefault={submit}>
      <label>
        Tool
        <select bind:value={tool}>
          <option value="" disabled selected>Select a tool…</option>
          <option value="claude">Claude Code</option>
          <option value="vibe">Mistral Vibe</option>
        </select>
      </label>
      <label>
        Project
        <select bind:value={projectId}>
          <option value="">Solo (no project)</option>
          {#each $projects as p (p.id)}
            <option value={p.id}>{p.name}</option>
          {/each}
        </select>
      </label>
      <label>
        Name
        <input bind:this={nameEl} bind:value={name} maxlength="80" placeholder="Optional — auto-generated if empty" />
      </label>
      <label>
        Working directory
        <div class="dir-row">
          <input bind:value={cwd} placeholder="(default: project folder or home)" />
          <button type="button" class="btn browse" title="Choose a folder" on:click={browseCwd}>
            …
          </button>
        </div>
      </label>
      {#if tool === 'vibe'}
        <label>
          Approval policy
          <select bind:value={vibeAgent}>
            {#each policies as p}
              <option value={p}>{p}</option>
            {/each}
          </select>
        </label>
        <label>
          Max turns
          <input type="number" bind:value={maxTurns} min="1" max="200" />
        </label>
      {/if}
      <small>The agent's live CLI appears in its detail view — type the task and answer its questions right there</small>
      {#if error}
        <div class="error">{error}</div>
      {/if}
      <div class="modal-actions">
        <button type="button" class="btn" on:click={() => dispatch('close')}>Cancel</button>
        <button type="submit" class="btn primary" disabled={submitting || !tool}>
          {submitting ? 'Spawning…' : 'Spawn'}
        </button>
      </div>
    </form>
  </div>
</div>

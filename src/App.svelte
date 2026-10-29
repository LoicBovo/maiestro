<script lang="ts">
  import { onMount } from 'svelte'
  import { api } from './lib/api'
  import AgentCard from './lib/components/AgentCard.svelte'
  import AgentDetail from './lib/components/AgentDetail.svelte'
  import FilterBar from './lib/components/FilterBar.svelte'
  import PullRequestsPane from './lib/components/PullRequestsPane.svelte'
  import SpawnDialog from './lib/components/SpawnDialog.svelte'
  import logo from './assets/logo.png'
  import {
    agents,
    createProject,
    deleteProject,
    init,
    projectFilter,
    projects,
    removeAgent,
    selectAgent,
    selectedAgent,
    selectedId,
    visibleAgents,
  } from './lib/state'

  let showSpawn = false
  let showNewProject = false
  let newProjectName = ''
  let newProjectDirs: string[] = ['']
  let creatingProject = false

  onMount(() => {
    void init()
  })

  function countFor(filter: 'all' | 'solo' | string): number {
    return $agents.filter((a) =>
      filter === 'all' ? true : filter === 'solo' ? a.projectId == null : a.projectId === filter,
    ).length
  }

  function onCloseAgent(agent: typeof $agents[number]): void {
    const running = agent.status === 'running' || agent.status === 'blocked'
    if (running && !confirm('Stop and close this agent?\n"' + (agent.name ?? agent.task.slice(0, 80)) + '"')) return
    void removeAgent(agent.id)
  }

  function resetNewProjectForm(): void {
    newProjectName = ''
    newProjectDirs = ['']
  }

  function addProjectDir(): void {
    newProjectDirs = [...newProjectDirs, '']
  }

  function removeProjectDir(index: number): void {
    newProjectDirs = newProjectDirs.filter((_, i) => i !== index)
  }

  async function browseProjectDir(index: number): Promise<void> {
    const picked = await api.pickDirectory()
    if (picked) {
      newProjectDirs = newProjectDirs.map((d, i) => (i === index ? picked : d))
    }
  }

  async function submitNewProject(): Promise<void> {
    const dirs = newProjectDirs.map((d) => d.trim()).filter(Boolean)
    if (!newProjectName.trim() || !dirs[0] || creatingProject) return
    creatingProject = true
    try {
      await createProject(newProjectName.trim(), dirs)
      resetNewProjectForm()
      showNewProject = false
    } finally {
      creatingProject = false
    }
  }
</script>

<div class="app">
  <aside class="sidebar">
    <div class="sidebar-header">
      <div class="app-title">
        <img class="app-logo" src={logo} alt="Maiestro logo" />
        <h1>Maiestro</h1>
      </div>
      <button class="new-btn" on:click={() => (showSpawn = true)}>+ New agent</button>
    </div>
    <div class="projects">
      <div class="projects-label">Projects</div>
      <div class="project-item" class:active={$projectFilter === 'all'}>
        <button class="project-select" on:click={() => projectFilter.set('all')}>
          All agents <span class="project-count">{$agents.length}</span>
        </button>
      </div>
      <div class="project-item" class:active={$projectFilter === 'solo'}>
        <button class="project-select" on:click={() => projectFilter.set('solo')}>
          Solo <span class="project-count">{countFor('solo')}</span>
        </button>
      </div>
      {#each $projects as p (p.id)}
        <div class="project-item" class:active={$projectFilter === p.id}>
          <button
            class="project-select"
            title={p.dirs.join('\n')}
            on:click={() => projectFilter.set(p.id)}
          >
            {p.name} <span class="project-count">{countFor(p.id)}</span>
          </button>
          <button class="project-close" title="Delete project" on:click={() => deleteProject(p.id)}>
            x
          </button>
        </div>
      {/each}
      {#if showNewProject}
        <form class="new-project-form" on:submit|preventDefault={submitNewProject}>
          <input placeholder="Project name" bind:value={newProjectName} required />
          {#each newProjectDirs as dir, i (i)}
            <div class="dir-row">
              <input
                placeholder={i === 0 ? 'Main folder' : 'Folder ' + (i + 1)}
                bind:value={newProjectDirs[i]}
                readonly
                title={dir}
              />
              {#if i === 0}
                <span class="dir-main">main</span>
              {/if}
              <button
                type="button"
                class="btn browse"
                title="Choose a folder"
                on:click={() => browseProjectDir(i)}
              >…</button>
              {#if i > 0}
                <button
                  type="button"
                  class="btn browse"
                  title="Remove folder"
                  on:click={() => removeProjectDir(i)}
                >x</button>
              {/if}
            </div>
          {/each}
          <button type="button" class="add-dir-btn" on:click={addProjectDir}>+ Add folder</button>
          <div class="new-project-actions">
            <button
              type="submit"
              class="btn"
              disabled={creatingProject || !newProjectDirs[0]?.trim()}
            >
              {creatingProject ? 'Creating…' : 'Create'}
            </button>
            <button
              type="button"
              class="btn"
              on:click={() => {
                resetNewProjectForm()
                showNewProject = false
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      {:else}
        <button class="new-project-btn" on:click={() => (showNewProject = true)}>
          + New project
        </button>
      {/if}
    </div>
  </aside>

  <main class="list-pane">
    <FilterBar />
    <div class="agent-list">
      {#each $visibleAgents as agent (agent.id)}
        <AgentCard
          {agent}
          selected={agent.id === $selectedId}
          on:select={() => selectAgent(agent.id)}
          on:remove={() => onCloseAgent(agent)}
        />
      {:else}
        <div class="empty">No agents match. Spawn one with “+ New agent”.</div>
      {/each}
    </div>
  </main>

  <section class="detail-pane">
    {#if $selectedAgent}
      <AgentDetail agent={$selectedAgent} />
    {:else}
      <div class="empty">Select an agent to see its events.</div>
    {/if}
  </section>

  <PullRequestsPane />
</div>

{#if showSpawn}
  <SpawnDialog
    initialProjectId={$projectFilter === 'all' || $projectFilter === 'solo' ? '' : $projectFilter}
    on:close={() => (showSpawn = false)}
  />
{/if}

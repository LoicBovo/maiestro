<script lang="ts">
  import { api } from '../api'
  import { agents, projectFilter, projects } from '../state'
  import type { ProjectPRs } from '../types'

  let prs: ProjectPRs | null = null
  let loading = false
  let error: string | null = null

  /** the project whose PRs are shown; null when no single project is selected */
  $: project = $projects.find((p) => p.id === $projectFilter) ?? null
  $: projectId = project?.id ?? null
  // agents of the project that have finished — a fresh one may have opened a PR
  $: finished = $agents.filter(
    (a) => a.projectId === projectId && (a.status === 'done' || a.status === 'error'),
  ).length
  $: if (projectId) void refresh(projectId, finished)

  async function refresh(id: string, _finished: number): Promise<void> {
    loading = true
    error = null
    try {
      const result = await api.listProjectPRs(id)
      if (result.projectId === projectId) prs = result
    } catch (e) {
      error = (e as Error).message
      prs = null
    } finally {
      loading = false
    }
  }

  function openPr(url: string): void {
    void api.openExternal(url)
  }

  function timeAgo(iso: string): string {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000)
    if (s < 60) return 'just now'
    if (s < 3600) return Math.floor(s / 60) + 'm ago'
    if (s < 86_400) return Math.floor(s / 3600) + 'h ago'
    return Math.floor(s / 86_400) + 'd ago'
  }
</script>

<aside class="prs-pane">
  <header class="prs-header">
    <span class="prs-title">Open PRs{project ? ` · ${project.name}` : ''}</span>
    {#if projectId}
      <button class="prs-refresh" title="Refresh" disabled={loading} on:click={() => void refresh(projectId, finished)}>
        {loading ? 'Loading…' : 'Refresh'}
      </button>
    {/if}
  </header>

  {#if !projectId}
    <div class="prs-empty">Select a project in the sidebar to see its open pull requests.</div>
  {:else if error}
    <div class="prs-empty prs-error">{error}</div>
  {:else if prs}
    {#if prs.prs.length === 0}
      <div class="prs-empty">No open pull requests.</div>
    {:else}
      <div class="prs-list">
        {#each prs.prs as pr (pr.url)}
          <button class="pr-item" title={pr.url} on:click={() => openPr(pr.url)}>
            <div class="pr-top">
              <span class="pr-repo">{pr.repo}</span>
              <span class="pr-number">#{pr.number}</span>
            </div>
            <div class="pr-title">
              {#if pr.isDraft}<span class="pr-draft">draft</span>{/if}
              {pr.title}
            </div>
            <div class="pr-meta">
              <span class="pr-branch">{pr.branch}</span>
              <span class="pr-author">@{pr.author}</span>
              <span class="pr-time">{timeAgo(pr.updatedAt)}</span>
            </div>
          </button>
        {/each}
      </div>
    {/if}
    {#each prs.errors as e (e.dir)}
      <div class="prs-dir-error" title={e.message}>
        {e.dir.split('/').pop()}: {e.message.split('\n')[0]}
      </div>
    {/each}
  {:else if loading}
    <div class="prs-empty">Loading…</div>
  {/if}
</aside>

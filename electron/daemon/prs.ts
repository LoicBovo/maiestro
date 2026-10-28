import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { Project, ProjectPRs, PullRequest } from './types'

const execFileAsync = promisify(execFile)

const GH_TIMEOUT_MS = 20_000

/** Locations added to PATH so `gh` is found even when the app is launched
 * from Finder/Dock without the user's shell profile. */
const EXTRA_PATH = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
].join(':')

interface GhPullRequest {
  number: number
  title: string
  headRefName: string
  url: string
  isDraft: boolean
  updatedAt: string
  author?: { login?: string } | null
}

/**
 * Lists the open pull requests of every repository of the project by running
 * `gh pr list` in each of its directories. Directories that are not GitHub
 * checkouts (or where `gh` is missing) are reported in `errors`, never thrown.
 */
export async function listProjectPRs(project: Project): Promise<ProjectPRs> {
  const results = await Promise.all(
    project.dirs.map(async (dir) => {
      try {
        const { stdout } = await execFileAsync(
          'gh',
          [
            'pr',
            'list',
            '--state',
            'open',
            '--limit',
            '50',
            '--json',
            'number,title,headRefName,url,author,isDraft,updatedAt',
          ],
          { cwd: dir, timeout: GH_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env: ghEnv() },
        )
        return { dir, prs: JSON.parse(stdout) as GhPullRequest[], error: null }
      } catch (e) {
        return { dir, prs: [] as GhPullRequest[], error: (e as Error).message }
      }
    }),
  )

  const byKey = new Map<string, PullRequest>()
  const errors: { dir: string; message: string }[] = []
  for (const { dir, prs, error } of results) {
    if (error) {
      errors.push({ dir, message: error })
      continue
    }
    for (const pr of prs) {
      const repo = repoFromUrl(pr.url)
      const key = repo + '#' + pr.number
      if (byKey.has(key)) continue
      byKey.set(key, {
        repo,
        number: pr.number,
        title: pr.title,
        branch: pr.headRefName,
        author: pr.author?.login ?? 'unknown',
        url: pr.url,
        isDraft: pr.isDraft,
        updatedAt: pr.updatedAt,
        dir,
      })
    }
  }
  return {
    projectId: project.id,
    prs: [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    errors,
  }
}

/** Extracts "owner/repo" from a PR URL like https://github.com/owner/repo/pull/12 */
function repoFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const parts = u.pathname.split('/').filter(Boolean)
    return parts.length >= 2 ? parts[0] + '/' + parts[1] : u.hostname
  } catch {
    return 'unknown'
  }
}

function ghEnv(): NodeJS.ProcessEnv {
  const path = process.env.PATH ?? ''
  return { ...process.env, PATH: path + ':' + EXTRA_PATH }
}

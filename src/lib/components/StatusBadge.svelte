<script lang="ts">
  import type { AgentStatus } from '../types'

  export let status: AgentStatus
</script>

<span class="badge badge-{status}"><span class="dot"></span>{status}</span>

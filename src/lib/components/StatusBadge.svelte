<script lang="ts">
  import type { AgentStatus } from '../types'

  export let status: AgentStatus
</script>

<span class="badge badge-{status}" title={status}><span class="dot"></span></span>

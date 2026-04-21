<script lang="ts">
  type ServerStatusData = {
    apiHost: string;
    configuredNode: string;
    configuredNodeExists: boolean;
    serverNode: string;
    serverStatus: string;
    lastSuccessfulRefresh: number | null;
  };

  let {
    results
  }: {
    results: ServerStatusData;
  } = $props();

  const formatRefreshTime = (unixMs?: number | null): string => {
    if (!unixMs || unixMs <= 0) {
      return 'No successful refresh yet';
    }

    return new Date(unixMs).toLocaleString();
  };
</script>

<p class="server-status">
  Server status ({results.serverNode}): {results.serverStatus} | Configured node exists: {results.configuredNodeExists ? 'yes' : 'no'} | Configured node: {results.configuredNode} | API host: {results.apiHost}
</p>
<p class="last-refresh">Last successful refresh: {formatRefreshTime(results.lastSuccessfulRefresh)}</p>
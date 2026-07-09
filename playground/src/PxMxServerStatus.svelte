<script lang="ts">
  type ServerStatusData = {
    apiHost: string;
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
  {results.apiHost}: {results.serverStatus}
</p>
<p class="last-refresh">Last successful refresh: {formatRefreshTime(results.lastSuccessfulRefresh)}</p>
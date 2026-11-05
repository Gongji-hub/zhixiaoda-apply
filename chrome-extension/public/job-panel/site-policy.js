(function (root) {
  function siteFor(value) {
    try {
      const url = new URL(value);
      const host = url.hostname;
      if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') ||
          host.endsWith('.localhost') || host.endsWith('.local') || /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':')) return null;
      return { url: url.href, origin: url.origin, host, pattern: `https://${host}/*` };
    } catch { return null; }
  }
  const policy = { siteFor };
  root.JobApplySitePolicy = policy;
})(globalThis);

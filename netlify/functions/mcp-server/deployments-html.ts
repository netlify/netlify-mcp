// Self-contained so the function bundle needs no asset copying or frontend build.
export const deploymentsHtml = String.raw`<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Netlify deployments</title>
  <style>
    :root { color-scheme: light dark; font: 14px/1.5 system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; padding: 16px; color: var(--color-text-primary, CanvasText); background: var(--color-background-primary, Canvas); }
    header, .heading, .links { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    header { justify-content: space-between; }
    h2 { margin: 0; font-size: 17px; }
    button, a { color: inherit; }
    button { border: 1px solid #8886; border-radius: 7px; padding: 6px 12px; background: transparent; cursor: pointer; font: inherit; }
    button:disabled { opacity: .5; cursor: default; }
    #status, .details { color: var(--color-text-secondary, GrayText); font-size: 12px; }
    #status { margin: 6px 0 0; }
    article { border-top: 1px solid #8884; padding: 14px 0; overflow-wrap: anywhere; }
    article:last-child { padding-bottom: 0; }
    .heading { justify-content: space-between; }
    .badge { border-radius: 5px; padding: 2px 8px; background: #8882; font-size: 12px; }
    .badge[data-state="ready"] { background: #00ad9f22; }
    .badge[data-state="error"] { background: #e5484d22; }
    p { margin: 6px 0; }
    .error { white-space: pre-wrap; }
    .links { margin-top: 10px; font-size: 12px; }
  </style>
</head>
<body>
  <header><h2>Netlify deployments</h2><button id="refresh" disabled>Refresh</button></header>
  <p id="status" role="status">Loading deployments…</p>
  <main id="deployments"></main>
  <script>
    const list = document.querySelector('#deployments');
    const status = document.querySelector('#status');
    const refreshButton = document.querySelector('#refresh');
    let snapshot, timer, ready = false, refreshing = false, nextId = 0;
    const pending = new Map();

    // The small standard MCP Apps bridge; all authenticated reads go through the host.
    function notify(method, params) {
      window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
    }
    function request(method, params) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        const timeout = setTimeout(() => { pending.delete(id); reject(new Error('The host did not respond. Try refreshing.')); }, 15000);
        pending.set(id, { resolve, reject, timeout });
        window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
      });
    }
    window.addEventListener('message', event => {
      if (event.source !== window.parent || event.data?.jsonrpc !== '2.0') return;
      const message = event.data;
      // Requests from the host use an independent ID sequence from our requests.
      const waiting = !message.method && pending.get(message.id);
      if (message.method === 'ui/resource-teardown') {
        ready = false;
        clearTimeout(timer);
        refreshButton.disabled = true;
        window.parent.postMessage({ jsonrpc: '2.0', id: message.id, result: {} }, '*');
      } else if (waiting) {
        clearTimeout(waiting.timeout);
        pending.delete(message.id);
        message.error ? waiting.reject(new Error(message.error.message)) : waiting.resolve(message.result);
      } else if (message.method === 'ui/notifications/tool-result') {
        try { render(message.params); } catch (error) { showError(error); }
      }
    });

    function element(tag, text, className) {
      const node = document.createElement(tag);
      node.textContent = text;
      if (className) node.className = className;
      return node;
    }
    function link(label, href) {
      const node = element('a', label);
      node.href = href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
      node.addEventListener('click', event => {
        event.preventDefault();
        request('ui/open-link', { url: href }).catch(showError);
      });
      return node;
    }
    function schedule() {
      clearTimeout(timer);
      if (ready && snapshot?.hasActiveDeploys && !document.hidden) timer = setTimeout(refresh, 5000);
    }
    function showError(error) {
      clearTimeout(timer);
      status.textContent = 'Could not update deployments. ' + error.message;
    }
    function render(result) {
      if (result?.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text || 'Please retry.');
      if (!result?.structuredContent) return;
      snapshot = result.structuredContent;
      list.replaceChildren();
      for (const deploy of snapshot.deploys) {
        const card = element('article', '');
        const heading = element('div', '', 'heading');
        const badge = element('span', deploy.state, 'badge');
        badge.dataset.state = deploy.state;
        heading.append(element('strong', deploy.title || deploy.name), badge);
        card.append(heading);
        const date = new Date(deploy.createdAt);
        card.append(element('p', [deploy.context, deploy.branch, deploy.commit.slice(0, 7),
          isNaN(date.getTime()) ? '' : date.toLocaleString()].filter(Boolean).join(' · '), 'details'));
        if (deploy.error) card.append(element('p', deploy.error, 'error'));
        const links = element('div', '', 'links');
        if (deploy.deployUrl) links.append(link('Visit deploy ↗', deploy.deployUrl));
        links.append(link('Open in Netlify ↗', deploy.adminUrl));
        if (deploy.commitUrl) links.append(link('View commit ↗', deploy.commitUrl));
        card.append(links);
        list.append(card);
      }
      status.textContent = !snapshot.deploys.length ? 'No deploys yet.'
        : snapshot.hasActiveDeploys ? 'Updating every 5 seconds while deploys are active.' : 'Up to date.';
      refreshButton.disabled = !ready || refreshing;
      schedule();
    }
    async function refresh() {
      if (!ready || !snapshot || refreshing) return;
      clearTimeout(timer);
      refreshing = true;
      refreshButton.disabled = true;
      try {
        render(await request('tools/call', {
          name: 'netlify-refresh-deployments',
          arguments: { siteId: snapshot.siteId, ...(snapshot.deployId ? { deployId: snapshot.deployId } : {}) },
        }));
      } catch (error) { showError(error); }
      finally { refreshing = false; refreshButton.disabled = !ready; }
    }
    refreshButton.addEventListener('click', refresh);
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('pagehide', () => clearTimeout(timer));
    request('ui/initialize', {
      appInfo: { name: 'netlify-deployments', version: '1.0.0' },
      appCapabilities: {}, protocolVersion: '2026-01-26',
    }).then(() => {
      notify('ui/notifications/initialized', {});
      ready = true;
      refreshButton.disabled = !snapshot;
      schedule();
    }).catch(showError);
    new ResizeObserver(() => notify('ui/notifications/size-changed', {
      height: document.body.offsetHeight,
    })).observe(document.body);
  </script>
</body>
</html>`;

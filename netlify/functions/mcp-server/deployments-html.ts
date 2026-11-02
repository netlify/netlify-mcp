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
    header, .heading, .links, .filters, #custom-range { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
    header { justify-content: space-between; }
    h2 { margin: 0; font-size: 17px; }
    [hidden] { display: none !important; }
    .filters { margin: 12px 0; }
    .filters label { display: inline-flex; align-items: center; gap: 8px; }
    select, input { font: inherit; color: inherit; background: transparent; border: 1px solid #8886; border-radius: 5px; padding: 5px; max-width: 100%; }
    .select-wrap { position: relative; display: inline-flex; }
    .select-wrap select { appearance: none; padding: 6px 34px 6px 10px; }
    .select-wrap svg { position: absolute; inset-inline-end: 10px; top: 50%; width: 16px; height: 16px; transform: translateY(-50%); pointer-events: none; }
    .select-wrap:has(select:open) svg { transform: translateY(-50%) rotate(180deg); }
    @supports (appearance: base-select) {
      .select-wrap select, .select-wrap select::picker(select) { appearance: base-select; }
      .select-wrap select::picker-icon { display: none; }
      .select-wrap select::picker(select) { border: 1px solid #8886; border-radius: 7px; padding: 4px; }
      .select-wrap option { padding: 6px 10px; }
    }
    button, a { color: inherit; }
    button { border: 1px solid #8886; border-radius: 7px; padding: 6px 12px; background: transparent; cursor: pointer; font: inherit; }
    button:disabled { opacity: .5; cursor: default; }
    #status, #link-error, .details { color: var(--color-text-secondary, GrayText); font-size: 12px; }
    #status { margin: 6px 0 0; }
    #link-error:empty { margin: 0; }
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
  <p id="project" class="details"></p>
  <form id="filters" class="filters" hidden>
    <label>Status <span class="select-wrap"><select id="filter-status">
      <option value="">Any status</option><option value="error">Unsuccessful</option>
      <option value="ready">Successful</option><option value="enqueued">Enqueued</option>
      <option value="pending_review">Pending review</option><option value="accepted">Accepted</option>
      <option value="rejected">Rejected</option>
    </select><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></label>
    <label>Time frame <span class="select-wrap"><select id="filter-time">
      <option value="">Any time frame</option><option value="1">Last hour</option>
      <option value="24">Last day</option><option value="48">Last 2 days</option>
      <option value="168">Last 7 days</option><option value="custom">Custom</option>
    </select><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span></label>
    <span id="custom-range" hidden>
      <label>From <input id="filter-from" type="datetime-local"></label>
      <label>To <input id="filter-to" type="datetime-local"></label>
    </span>
    <button id="apply-filters" disabled>Apply</button>
  </form>
  <p id="status" role="status">Loading deployments…</p>
  <p id="link-error" role="status"></p>
  <main id="deployments"></main>
  <script>
    const list = document.querySelector('#deployments');
    const status = document.querySelector('#status');
    const linkError = document.querySelector('#link-error');
    const refreshButton = document.querySelector('#refresh');
    const project = document.querySelector('#project');
    const filters = document.querySelector('#filters');
    const filterStatus = document.querySelector('#filter-status');
    const filterTime = document.querySelector('#filter-time');
    const filterFrom = document.querySelector('#filter-from');
    const filterTo = document.querySelector('#filter-to');
    const applyFilters = document.querySelector('#apply-filters');
    let snapshot, timer, ready = false, refreshing = false, nextId = 0;
    let pollingStoppedOnError = false;
    const pollingDuration = 15 * 60 * 1000;
    let pollingDeadline = performance.now() + pollingDuration;
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
        setBusy(true);
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
        linkError.textContent = '';
        request('ui/open-link', { url: href }).catch(error => {
          linkError.textContent = 'Could not open the link. ' + error.message;
        });
      });
      return node;
    }
    function pollingExpired() {
      if (performance.now() < pollingDeadline) return false;
      status.textContent = 'Automatic updates paused—click Refresh to resume.';
      return true;
    }
    function schedule() {
      clearTimeout(timer);
      if (ready && snapshot?.hasActiveDeploys && !pollingStoppedOnError && !document.hidden && !pollingExpired()) timer = setTimeout(refresh, 5000);
    }
    function showError(error) {
      clearTimeout(timer);
      pollingStoppedOnError = true;
      status.textContent = 'Could not update deployments. ' + error.message;
    }
    function render(result) {
      if (result?.isError) throw new Error(result.content?.find(item => item.type === 'text')?.text || 'Please retry.');
      if (!result?.structuredContent) return;
      if (!snapshot || snapshot.siteId !== result.structuredContent.siteId) {
        const initial = result.structuredContent.filters;
        filterStatus.value = initial?.status ?? '';
        if (initial?.from != null && initial?.to != null) {
          filterTime.value = 'custom';
          const localTime = seconds => {
            const date = new Date(seconds * 1000);
            return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
          };
          filterFrom.value = localTime(initial.from);
          filterTo.value = localTime(initial.to);
          document.querySelector('#custom-range').hidden = false;
          filterFrom.required = filterTo.required = true;
        }
      }
      const previousProject = snapshot?.siteId === result.structuredContent.siteId ? snapshot.project : undefined;
      snapshot = { ...result.structuredContent, project: result.structuredContent.project ?? previousProject };
      project.replaceChildren();
      if (snapshot.project) {
        project.append(element('span', snapshot.project.name + (snapshot.project.teamName ? ' · Team: ' : '')));
        if (snapshot.project.teamName) project.append(snapshot.project.teamUrl
          ? link(snapshot.project.teamName + ' ↗', snapshot.project.teamUrl)
          : element('span', snapshot.project.teamName));
      }
      filters.hidden = !!snapshot.deployId;
      list.replaceChildren();
      for (const deploy of snapshot.deploys) {
        const card = element('article', '');
        const heading = element('div', '', 'heading');
        const badge = element('span', deploy.state, 'badge');
        badge.dataset.state = deploy.state;
        heading.append(element('strong', deploy.title || deploy.name), badge);
        card.append(heading);
        const date = new Date(deploy.createdAt);
        card.append(element('p', [deploy.context, deploy.branch,
          isNaN(date.getTime()) ? '' : 'Created ' + date.toLocaleString()].filter(Boolean).join(' · '), 'details'));
        if (deploy.error) card.append(element('p', deploy.error, 'error'));
        const links = element('div', '', 'links');
        if (deploy.deployUrl) links.append(link('Visit deploy ↗', deploy.deployUrl));
        links.append(link('Open in Netlify ↗', deploy.adminUrl));
        card.append(links);
        list.append(card);
      }
      if (!pollingStoppedOnError) status.textContent = !snapshot.deploys.length ? 'No deployments match these filters.'
        : snapshot.hasActiveDeploys ? 'Updating every 5 seconds while deploys are active.' : 'Up to date.' + (snapshot.deployId ? '' : ' Showing up to 5 matching deployments.');
      setBusy(!ready || refreshing);
      schedule();
    }
    function setBusy(busy) {
      for (const control of [refreshButton, applyFilters, filterStatus, filterTime, filterFrom, filterTo]) control.disabled = busy;
    }
    async function refresh(nextFilters) {
      if (!ready || !snapshot || refreshing || pollingStoppedOnError) return;
      clearTimeout(timer);
      if (pollingExpired()) return;
      refreshing = true;
      setBusy(true);
      try {
        render(await request('tools/call', {
          name: 'netlify-refresh-deployments',
          arguments: { siteId: snapshot.siteId, ...(snapshot.deployId ? { deployId: snapshot.deployId }
            : Object.fromEntries(Object.entries(nextFilters ?? snapshot.filters ?? {}).filter(([, value]) => value != null))) },
        }));
      } catch (error) { showError(error); }
      finally { refreshing = false; setBusy(!ready); }
    }
    refreshButton.addEventListener('click', () => {
      pollingStoppedOnError = false;
      pollingDeadline = performance.now() + pollingDuration;
      refresh();
    });
    filterTime.addEventListener('change', () => {
      const custom = filterTime.value === 'custom';
      document.querySelector('#custom-range').hidden = !custom;
      filterFrom.required = filterTo.required = custom;
    });
    filters.addEventListener('submit', event => {
      event.preventDefault();
      if (!ready || refreshing || !snapshot) return;
      const nextFilters = { status: filterStatus.value || null };
      if (filterTime.value) {
        const custom = filterTime.value === 'custom';
        const to = custom ? new Date(filterTo.value).getTime() : Date.now();
        const from = custom ? new Date(filterFrom.value).getTime() : to - Number(filterTime.value) * 3600000;
        if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) {
          status.textContent = 'Choose a valid time range with From before To.';
          return;
        }
        nextFilters.from = Math.floor(from / 1000);
        nextFilters.to = Math.floor(to / 1000);
      }
      pollingStoppedOnError = false;
      pollingDeadline = performance.now() + pollingDuration;
      refresh(nextFilters);
    });
    document.addEventListener('visibilitychange', schedule);
    window.addEventListener('pagehide', () => clearTimeout(timer));
    request('ui/initialize', {
      appInfo: { name: 'netlify-deployments', version: '1.0.0' },
      appCapabilities: {}, protocolVersion: '2026-01-26',
    }).then(() => {
      notify('ui/notifications/initialized', {});
      ready = true;
      setBusy(!snapshot);
      schedule();
    }).catch(showError);
    new ResizeObserver(() => notify('ui/notifications/size-changed', {
      height: document.body.offsetHeight,
    })).observe(document.body);
  </script>
</body>
</html>`;

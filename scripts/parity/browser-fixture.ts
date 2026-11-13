export type BrowserFixture = {
  origin: string
  startedAt: number
  requests: Array<{ path: string; method: string; headers: Record<string, string> }>
  dialogCount: number
  waitForDialog(previous: number, signal?: AbortSignal): Promise<void>
  waitForGate(key: string, signal?: AbortSignal): Promise<void>
  releaseGate(key: string): void
  stop(): Promise<void>
}

type DialogWaiter = { previous: number; finish(error?: unknown): void }
type GateWaiter = { finish(error?: unknown): void }
type FixtureGate = {
  arrived: boolean
  released: boolean
  arrivalWaiters: Set<GateWaiter>
  releaseWaiters: Set<() => void>
}

const DIALOG_WAIT_TIMEOUT_MS = 30_000

const pageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Parity fixture</title>
  <style>
    html, body { margin: 0; min-height: 2600px; scroll-behavior: auto; }
    body { position: relative; font: 16px sans-serif; }
    main { display: grid; justify-items: start; gap: 12px; padding: 16px; }
    #footer { position: absolute; top: 2580px; left: 0; width: 100%; height: 20px; }
    #ready { visibility: hidden; }
  </style>
</head>
<body>
  <main>
    <label for="text">Text field</label>
    <input id="text" type="text" value="seed">
    <button id="apply" type="button">Apply</button>
    <output id="result"></output>
    <label for="choice">Choice</label>
    <select id="choice"><option value="a">A</option><option value="b">B</option></select>
    <label><input id="check" type="checkbox"> Check</label>
    <div id="hover">Hover</div>
    <output id="hoverResult"></output>
    <button id="double" type="button">Double click</button>
    <output id="doubleResult">0</output>
    <div id="dragSource" draggable="true">Drag source</div>
    <div id="dragTarget">Drop target</div>
    <output id="dragResult"></output>
    <input id="upload" type="file">
    <a id="download" href="/download" download="download-proof.txt">Download proof</a>
    <button id="readyButton" type="button">Reveal ready</button>
    <output id="ready"></output>
  </main>
  <script>
    window.parityEvents = [];
    window.__parityWaitFnReady = false;
    document.addEventListener('mousemove', (event) => {
      window.parityEvents.push({ type: 'move', x: event.clientX, y: event.clientY });
    });
    document.addEventListener('mousedown', (event) => {
      window.parityEvents.push({ type: 'down', button: event.button });
    });
    document.addEventListener('mouseup', (event) => {
      window.parityEvents.push({ type: 'up', button: event.button });
    });
    document.addEventListener('wheel', (event) => {
      window.parityEvents.push({ type: 'wheel', deltaY: event.deltaY });
    }, { passive: true });
    document.querySelector('#apply').addEventListener('click', () => {
      document.querySelector('#result').textContent = 'applied:' + document.querySelector('#text').value;
    });
    document.querySelector('#hover').addEventListener('mouseenter', () => {
      document.querySelector('#hoverResult').textContent = 'hovered';
    });
    let doubleClicks = 0;
    document.querySelector('#double').addEventListener('dblclick', () => {
      doubleClicks += 1;
      document.querySelector('#doubleResult').textContent = String(doubleClicks);
    });
    document.querySelector('#dragSource').addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', 'dragged');
    });
    document.querySelector('#dragTarget').addEventListener('dragover', (event) => event.preventDefault());
    document.querySelector('#dragTarget').addEventListener('drop', (event) => {
      event.preventDefault();
      document.querySelector('#dragResult').textContent = event.dataTransfer.getData('text/plain');
    });
    document.querySelector('#readyButton').addEventListener('click', () => {
      void fetch('/wait-gate?key=selector').then((response) => {
        if (!response.ok) throw new Error('selector gate response failed');
        return fetch('/ready');
      }).then((response) => {
        if (!response.ok) throw new Error('ready fixture response failed');
        return response.text();
      }).then((value) => {
        document.querySelector('#ready').textContent = value;
        document.querySelector('#ready').style.visibility = 'visible';
        const proof = document.createElement('output');
        proof.id = 'selector-proof';
        proof.textContent = 'Selector gate proof';
        document.querySelector('main').append(proof);
        return fetch('/wait-gate?key=footer');
      }).then((response) => {
        if (!response.ok) throw new Error('footer gate response failed');
        const footer = document.createElement('footer');
        footer.id = 'footer';
        footer.textContent = 'Fixture footer';
        document.body.append(footer);
      }).catch((error) => {
        window.__parityWaitEffectError = String(error);
      });
    });
  </script>
</body>
</html>`

const watchPageHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Watch parity fixture</title>
  <style>
    html, body { margin: 0; padding: 0; background: #111827; }
  </style>
</head>
<body>
  <button id="watch-marker" type="button" data-state="red" data-clicks="0" style="position:fixed;left:0;top:0;width:240px;height:160px;margin:0;border:0;padding:6px 8px;box-sizing:border-box;display:flex;align-items:flex-start;justify-content:flex-start;background:rgb(225,30,30);color:#ffffff;font:16px sans-serif">Watch Marker: red (0)</button>
  <script>
    const marker = document.querySelector('#watch-marker');
    marker.addEventListener('click', () => {
      const clicks = Number(marker.getAttribute('data-clicks')) + 1;
      marker.setAttribute('data-clicks', String(clicks));
      if (clicks % 2 === 1) {
        marker.setAttribute('data-state', 'green');
        marker.style.background = 'rgb(20, 210, 50)';
        document.title = clicks === 1 ? 'CLI changed' : 'CLI changed again';
        marker.textContent = 'Watch Marker: green (' + clicks + ')';
      } else {
        marker.setAttribute('data-state', 'red');
        marker.style.background = 'rgb(225, 30, 30)';
        document.title = 'Watch parity fixture';
        marker.textContent = 'Watch Marker: red (' + clicks + ')';
      }
    });
  </script>
</body>
</html>`


const secondHtml = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Second</title></head><body>Second</body></html>'

function htmlResponse(body: string): Response {
  return new Response(body, {
    headers: {
      'cache-control': 'no-store',
      'content-type': 'text/html; charset=utf-8'
    }
  })
}

function textResponse(body: string, headers: Record<string, string> = {}, status = 200): Response {
  return new Response(body, {
    status,
    headers: { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8', ...headers }
  })
}

function abortReason(signal: AbortSignal): unknown {
  if (signal.reason !== undefined) return signal.reason
  const error = new Error('fixture dialog wait aborted')
  error.name = 'AbortError'
  return error
}

export function startBrowserFixture(): BrowserFixture {
  const startedAt = Date.now()
  const requests: BrowserFixture['requests'] = []
  const dialogWaiters = new Set<DialogWaiter>()
  const gates = new Map<string, FixtureGate>()
  let dialogCount = 0
  let stopped = false

  function waitForDialog(previous: number, signal?: AbortSignal): Promise<void> {
    if (dialogCount > previous) return Promise.resolve()
    if (stopped) return Promise.reject(new Error('browser fixture is stopped'))
    if (signal?.aborted) return Promise.reject(abortReason(signal))

    const waiting = Promise.withResolvers<void>()
    let timer: ReturnType<typeof setTimeout>
    let settled = false
    const waiter: DialogWaiter = {
      previous,
      finish(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        dialogWaiters.delete(waiter)
        if (error === undefined) waiting.resolve()
        else waiting.reject(error)
      }
    }
    const onAbort = () => waiter.finish(abortReason(signal!))

    timer = setTimeout(() => {
      const error = new Error('timed out waiting for fixture dialog opening')
      error.name = 'TimeoutError'
      waiter.finish(error)
    }, DIALOG_WAIT_TIMEOUT_MS)
    dialogWaiters.add(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    return waiting.promise
  }
  function gateFor(key: string): FixtureGate {
    let gate = gates.get(key)
    if (!gate) {
      gate = { arrived: false, released: false, arrivalWaiters: new Set(), releaseWaiters: new Set() }
      gates.set(key, gate)
    }
    return gate
  }

  function waitForGate(key: string, signal?: AbortSignal): Promise<void> {
    if (!key) return Promise.reject(new Error('fixture gate key must not be empty'))
    if (stopped) return Promise.reject(new Error('browser fixture is stopped'))
    const gate = gateFor(key)
    if (gate.arrived) return Promise.resolve()
    if (signal?.aborted) return Promise.reject(abortReason(signal))

    const waiting = Promise.withResolvers<void>()
    let timer: ReturnType<typeof setTimeout>
    let settled = false
    const waiter: GateWaiter = {
      finish(error) {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        gate.arrivalWaiters.delete(waiter)
        if (error === undefined) waiting.resolve()
        else waiting.reject(error)
      }
    }
    const onAbort = () => waiter.finish(abortReason(signal!))

    timer = setTimeout(() => {
      const error = new Error(`timed out waiting for fixture gate ${key}`)
      error.name = 'TimeoutError'
      waiter.finish(error)
    }, DIALOG_WAIT_TIMEOUT_MS)
    gate.arrivalWaiters.add(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    if (gate.arrived) waiter.finish()
    return waiting.promise
  }

  function releaseGate(key: string): void {
    if (!key) throw new Error('fixture gate key must not be empty')
    const gate = gateFor(key)
    gate.released = true
    for (const release of [...gate.releaseWaiters]) release()
  }

  async function holdGate(key: string): Promise<boolean> {
    const gate = gateFor(key)
    gate.arrived = true
    for (const waiter of [...gate.arrivalWaiters]) waiter.finish()
    if (stopped) return false
    if (!gate.released) {
      const waiting = Promise.withResolvers<void>()
      const release = () => waiting.resolve()
      gate.releaseWaiters.add(release)
      if (stopped || gate.released) release()
      await waiting.promise
      gate.releaseWaiters.delete(release)
    }
    return !stopped
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname
      const headers = Object.fromEntries(request.headers.entries())
      requests.push({ path, method: request.method, headers })

      if (path === '/watch-page') return htmlResponse(watchPageHtml)

      if (path === '/page' || path === '/') return htmlResponse(pageHtml)
      if (path === '/second') return htmlResponse(secondHtml)
      if (path === '/wait-load') {
        const key = url.searchParams.get('key')
        if (!key) return textResponse('missing gate key', {}, 400)
        const script = `/wait-gate?key=${encodeURIComponent(key)}`
        return htmlResponse(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Wait load fixture</title></head><body>Load gate<script src="${script}"></script></body></html>`)
      }
      if (path === '/wait-gate') {
        const key = url.searchParams.get('key')
        if (!key) return textResponse('missing gate key', {}, 400)
        if (!await holdGate(key)) return textResponse('fixture stopped', {}, 503)
        return textResponse('window.__parityWaitGateReleased = true;', { 'content-type': 'text/javascript; charset=utf-8' })
      }
      if (path === '/resource') return textResponse('resource-proof')
      if (path === '/intercept') return textResponse('intercept-proof')
      if (path === '/echo') return Response.json({ value: request.headers.get('x-parity') })
      if (path === '/auth') {
        const expected = `Basic ${Buffer.from('parity:fixture-only').toString('base64')}`
        if (request.headers.get('authorization') !== expected) {
          return textResponse('authentication required', {
            'www-authenticate': 'Basic realm="parity"'
          }, 401)
        }
        return textResponse('authenticated')
      }
      if (path === '/download') {
        return textResponse('download-proof\n', {
          'content-disposition': 'attachment; filename="download-proof.txt"'
        })
      }
      if (path === '/dialog-opening') {
        if (request.method !== 'POST') return new Response('method not allowed', { status: 405 })
        dialogCount += 1
        for (const waiter of [...dialogWaiters]) {
          if (dialogCount > waiter.previous) waiter.finish()
        }
        return textResponse('dialog opening observed')
      }
      if (path === '/ready') return textResponse('Ready')
      return textResponse('not found', {}, 404)
    }
  })

  return {
    origin: server.url.origin,
    startedAt,
    requests,
    get dialogCount() { return dialogCount },
    waitForDialog,
    waitForGate,
    releaseGate,
    async stop() {
      if (stopped) return
      stopped = true
      for (const waiter of [...dialogWaiters]) waiter.finish(new Error('browser fixture stopped while waiting for dialog opening'))
      for (const [key, gate] of gates) {
        for (const waiter of [...gate.arrivalWaiters]) waiter.finish(new Error(`browser fixture stopped while waiting for gate ${key}`))
        gate.released = true
        for (const release of [...gate.releaseWaiters]) release()
      }
      server.stop(true)
    }
  }
}

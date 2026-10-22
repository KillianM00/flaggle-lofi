// Dependency-free WebDriver client for geckodriver + a static file server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT } from './harness.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
};

// Serves the project root. Walks forward if the port is taken — a killed run
// can leave its listener behind, and the next run shouldn't die on that.
export function serve(port = 8731, attempts = 12) {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    let tries = 0;
    const close = () => {
      // Without this a keep-alive socket from the browser holds the port open
      // long after the run finishes, and the next run gets EADDRINUSE.
      if (server.closeAllConnections) server.closeAllConnections();
      server.close();
    };
    server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE' || ++tries >= attempts) return reject(err);
      server.listen(port + tries, '127.0.0.1');
    });
    server.on('listening', () => {
      const actual = server.address().port;
      resolve({ server, close, url: `http://127.0.0.1:${actual}`, port: actual });
    });
    server.listen(port, '127.0.0.1');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function startDriver(port = 4444) {
  const proc = spawn('geckodriver', ['--port', String(port), '--log', 'error'], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${base}/status`);
      if (r.ok) return { proc, base };
    } catch {
      /* not up yet */
    }
    await sleep(250);
  }
  proc.kill();
  throw new Error('geckodriver did not start');
}

async function call(base, method, endpoint, body) {
  const res = await fetch(base + endpoint, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.value || {};
    throw new Error(`${method} ${endpoint} -> ${res.status} ${err.error || ''}: ${err.message || ''}`);
  }
  return json.value;
}

export async function newSession({ headless = true, driverPort = 4444 } = {}) {
  const { proc, base } = await startDriver(driverPort);
  const args = headless ? ['-headless'] : [];
  const value = await call(base, 'POST', '/session', {
    capabilities: {
      alwaysMatch: {
        'moz:firefoxOptions': {
          args,
          prefs: {
            'browser.tabs.remote.autostart': false,
            'media.autoplay.default': 0,
            'dom.webaudio.enabled': true,
          },
        },
        pageLoadStrategy: 'normal',
        acceptInsecureCerts: false,
      },
    },
  });
  const sid = value.sessionId;
  const url = (p) => `${base}/session/${sid}${p}`;

  const api = {
    async go(u) {
      return call(base, 'POST', `/session/${sid}/url`, { url: u });
    },
    async execute(script, args = []) {
      return call(base, 'POST', `/session/${sid}/execute/sync`, { script, args });
    },
    async executeAsync(script, args = []) {
      return call(base, 'POST', `/session/${sid}/execute/async`, { script, args });
    },
    async screenshot(file) {
      const b64 = await call(base, 'GET', `/session/${sid}/screenshot`);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      return file;
    },
    async setTimeouts(timeouts) {
      return call(base, 'POST', `/session/${sid}/timeouts`, timeouts);
    },
    async setWindow(width, height) {
      return call(base, 'POST', `/session/${sid}/window/rect`, { width, height, x: 0, y: 0 });
    },
    async logs() {
      try {
        return await call(base, 'POST', `/session/${sid}/moz/log`, {});
      } catch {
        return [];
      }
    },
    async waitFor(script, { timeout = 8000, interval = 100, label = 'condition' } = {}) {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        last = await api.execute(`return (${script});`);
        if (last) return last;
        await sleep(interval);
      }
      throw new Error(`timed out waiting for ${label} (last value: ${JSON.stringify(last)})`);
    },
    async quit() {
      try {
        await call(base, 'DELETE', `/session/${sid}`);
      } catch {
        /* already gone */
      }
      proc.kill();
    },
    url,
  };
  return api;
}

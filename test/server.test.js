import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createApp } from '../server.js';
import { createStore } from '../lib/store.js';
import { fixture } from './helpers.js';

const PUBLIC_ORIGIN = 'https://santa.example';
const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';

async function appFixture(t, suppliedStore, options = { publicOrigin: PUBLIC_ORIGIN }) {
  const data = await fixture(t);
  const store = suppliedStore ?? await createStore({ dataDir: data.dataDir });
  const server = createApp({ store, ...options });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    ...data,
    base,
    store,
    get: (path) => fetch(`${base}${path}`),
    reveal: (id, origin = PUBLIC_ORIGIN) => fetch(`${base}/api/reveal/${encodeURIComponent(id)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(origin === null ? {} : { Origin: origin }),
      },
      body: '{}',
    }),
  };
}

test('public API has no assignment fields and every public GET leaves state untouched', async (t) => {
  const app = await appFixture(t);
  const initial = await readFile(app.statePath, 'utf8');
  const response = await app.get('/api/participants');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
  const payload = await response.json();
  assert.deepEqual(Object.keys(payload), ['participants']);
  assert.deepEqual(payload.participants, app.store.list());
  for (const participant of payload.participants) {
    assert.deepEqual(Object.keys(participant).sort(), ['id', 'name', 'revealed']);
  }
  for (const path of ['/', '/styles.css', '/app.js', '/background.js', '/healthz']) {
    const asset = await app.get(path);
    assert.equal(asset.status, 200, path);
    await asset.text();
  }
  const attemptedReveal = await app.get(`/api/reveal/${encodeURIComponent(app.store.list()[0].id)}`);
  assert.ok([404, 405].includes(attemptedReveal.status));
  assert.equal(await readFile(app.statePath, 'utf8'), initial);
});

test('private files and source code are never served', async (t) => {
  const app = await appFixture(t);
  for (const path of ['/state.json', '/participants.txt', '/data/state.json', '/data/participants.txt', '/server.js', '/lib/store.js', '/.env']) {
    const response = await app.get(path);
    assert.equal(response.status, 404, path);
    const body = await response.text();
    assert.ok(!body.includes('recipientId'), path);
    assert.ok(!body.includes(app.dataDir), path);
  }
});

test('reveal requires the configured origin and rejected requests consume nothing', async (t) => {
  const app = await appFixture(t);
  const { id } = app.store.list()[0];
  const initial = await readFile(app.statePath, 'utf8');
  for (const origin of [null, 'null', 'https://evil.example', 'https://santa.example.evil.example']) {
    const response = await app.reveal(id, origin);
    assert.equal(response.status, 403, String(origin));
    await response.text();
  }
  assert.equal(await readFile(app.statePath, 'utf8'), initial);
  const success = await app.reveal(id);
  assert.equal(success.status, 200);
});

test('an unset or empty public origin accepts direct local HTTP reveals', async (t) => {
  for (const options of [{}, { publicOrigin: '' }]) {
    const app = await appFixture(t, undefined, options);
    const [first, second] = app.store.list();
    const numericHost = await app.reveal(first.id, app.base);
    assert.equal(numericHost.status, 200);
    assert.equal(typeof (await numericHost.json()).recipient, 'string');

    const localhost = app.base.replace('127.0.0.1', 'localhost');
    const namedHost = await fetch(`${localhost}/api/reveal/${second.id}`, {
      method: 'POST', headers: { Origin: localhost },
    });
    assert.equal(namedHost.status, 200);
    assert.equal(typeof (await namedHost.json()).recipient, 'string');
  }
});

test('local mode still rejects foreign, missing, and forwarded origins without consuming names', async (t) => {
  const app = await appFixture(t, undefined, {});
  const { id } = app.store.list()[0];
  const initial = await readFile(app.statePath, 'utf8');
  for (const origin of [null, 'null', 'https://evil.example', app.base.replace('http:', 'https:'), `${app.base}1`]) {
    const response = await app.reveal(id, origin);
    assert.equal(response.status, 403, String(origin));
    await response.text();
  }
  const spoofed = await fetch(`${app.base}/api/reveal/${id}`, {
    method: 'POST',
    headers: {
      Origin: 'https://evil.example',
      'X-Forwarded-Host': 'evil.example',
      'X-Forwarded-Proto': 'https',
    },
  });
  assert.equal(spoofed.status, 403);
  await spoofed.text();
  assert.equal(await readFile(app.statePath, 'utf8'), initial);
});

test('concurrent HTTP reveals return one recipient once and advertise the consumed name', async (t) => {
  const app = await appFixture(t);
  const participant = app.store.list()[0];
  const responses = await Promise.all([app.reveal(participant.id), app.reveal(participant.id)]);
  assert.deepEqual(responses.map(({ status }) => status).sort(), [200, 409]);
  for (const response of responses) {
    assert.match(response.headers.get('cache-control') ?? '', /no-store/i);
    const payload = await response.json();
    if (response.status === 200) {
      assert.deepEqual(Object.keys(payload), ['recipient']);
      assert.notEqual(payload.recipient, participant.name);
      assert.ok(app.store.list().some(({ name }) => name === payload.recipient));
    } else {
      assert.equal(payload.recipient, undefined);
    }
  }
  const listing = await (await app.get('/api/participants')).json();
  assert.equal(listing.participants.find(({ id }) => id === participant.id).revealed, true);
  const retry = await app.reveal(participant.id);
  assert.equal(retry.status, 409);
});

test('unknown participants return 404 without returning a recipient', async (t) => {
  const app = await appFixture(t);
  const response = await app.reveal(UNKNOWN_ID);
  assert.equal(response.status, 404);
  assert.equal((await response.json()).recipient, undefined);
  assert.ok(app.store.list().every(({ revealed }) => !revealed));
});

test('storage failures report unavailable health and do not expose internal errors', async (t) => {
  const store = {
    list: () => [{ id: UNKNOWN_ID, name: 'Alice', revealed: false }],
    healthy: () => false,
    reveal: async () => {
      throw Object.assign(new Error('PRIVATE /app/data/state.json recipient=Bob'), { statusCode: 503 });
    },
  };
  const app = await appFixture(t, store);
  const health = await app.get('/healthz');
  assert.equal(health.status, 503);
  const response = await app.reveal(UNKNOWN_ID);
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.ok(!body.includes('PRIVATE'));
  assert.ok(!body.includes('/app/data'));
  assert.ok(!body.includes('Bob'));
});

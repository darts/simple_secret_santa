import assert from 'node:assert/strict';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { parseParticipants } from '../lib/participants.js';
import { createStore } from '../lib/store.js';
import { fixture, hasStatus } from './helpers.js';

function assertFreshDraw(state, input, previousIds) {
  const configuration = parseParticipants(input);
  const byId = new Map(state.participants.map(participant => [participant.id, participant]));
  assert.deepEqual(state.participants.map(({ name }) => name).sort(), configuration.map(({ name }) => name).sort());
  assert.equal(new Set(state.participants.map(({ recipientId }) => recipientId)).size, configuration.length);
  for (const participant of state.participants) {
    assert.ok(!previousIds.has(participant.id), 'a changed draw must replace every participant ID');
    assert.equal(participant.revealed, false);
    const recipient = byId.get(participant.recipientId);
    assert.ok(recipient);
    assert.notEqual(recipient.name, participant.name);
    const rules = configuration.find(({ name }) => name === participant.name);
    assert.ok(!rules.exclusions.includes(recipient.name));
  }
}

test('saved assignments, participant IDs, and reveal flags survive restart', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const initial = await data.readState();
  const participant = store.list()[0];
  const result = await store.reveal(participant.id);
  const saved = await data.readState();
  const savedParticipant = saved.participants.find(({ id }) => id === participant.id);
  assert.equal(savedParticipant.revealed, true);
  assert.equal(result.recipient, saved.participants.find(({ id }) => id === savedParticipant.recipientId).name);
  assert.notEqual(result.recipient, participant.name);
  assert.deepEqual(saved.participants.map(({ id, recipientId }) => ({ id, recipientId })),
    initial.participants.map(({ id, recipientId }) => ({ id, recipientId })));

  const restarted = await createStore({ dataDir: data.dataDir });
  assert.deepEqual(restarted.list(), store.list());
  assert.deepEqual(await data.readState(), saved);
  await assert.rejects(restarted.reveal(participant.id), hasStatus(409));
});

test('public participant list contains only names, IDs, and reveal status', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const participants = store.list();
  assert.equal(participants.length, 4);
  assert.equal(new Set(participants.map(({ id }) => id)).size, 4);
  for (const participant of participants) {
    assert.deepEqual(Object.keys(participant).sort(), ['id', 'name', 'revealed']);
    assert.equal(participant.revealed, false);
  }
});

test('equivalent participant ordering and exclusion ordering reuse the saved draw', async (t) => {
  const data = await fixture(t, 'Alice Bob Cara\nBob\nCara\nDave\n');
  const store = await createStore({ dataDir: data.dataDir });
  const initial = await data.readState();
  await writeFile(data.participantsPath, '\nDave\nCara\n\nBob\nAlice Cara Bob\n');
  const restarted = await createStore({ dataDir: data.dataDir });
  assert.deepEqual(restarted.list(), store.list());
  assert.deepEqual(await data.readState(), initial);
});

test('valid participant and exclusion changes create a fresh draw on startup', async (t) => {
  for (const changed of ['Alice\nBob\nCara\nEve\n', 'Alice Bob Cara\nBob\nCara\nDave\n']) {
    const data = await fixture(t);
    const store = await createStore({ dataDir: data.dataDir });
    const previousIds = new Set(store.list().map(({ id }) => id));
    await store.reveal(store.list()[0].id);
    await writeFile(data.participantsPath, changed);
    const restarted = await createStore({ dataDir: data.dataDir });
    assertFreshDraw(await data.readState(), changed, previousIds);
    assert.equal(restarted.healthy(), true);
    assert.ok(restarted.list().every(({ revealed }) => !revealed));
  }
});

test('corrupt or unsupported saved state is never replaced by a fresh draw', async (t) => {
  for (const invalid of ['{bad json', '{}', '{"version":999}']) {
    const data = await fixture(t);
    await writeFile(data.statePath, invalid);
    await assert.rejects(createStore({ dataDir: data.dataDir }));
    assert.equal(await readFile(data.statePath, 'utf8'), invalid);
  }
});

test('concurrent claims of the same name have exactly one winner', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const { id } = store.list()[0];
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => store.reveal(id)));
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  for (const result of results.filter(({ status }) => status === 'rejected')) {
    assert.equal(result.reason.statusCode, 409);
  }
  assert.equal((await data.readState()).participants.filter(({ revealed }) => revealed).length, 1);
  assert.equal(store.healthy(), true);
});

test('concurrent claims of different names persist every claim without lost updates', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const participants = store.list();
  const results = await Promise.all(participants.map(({ id }) => store.reveal(id)));
  assert.equal(new Set(results.map(({ recipient }) => recipient)).size, participants.length);
  assert.ok((await data.readState()).participants.every(({ revealed }) => revealed));
  const restarted = await createStore({ dataDir: data.dataDir });
  assert.ok(restarted.list().every(({ revealed }) => revealed));
});

test('unknown IDs do not alter persisted state or poison subsequent requests', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const initial = await readFile(data.statePath, 'utf8');
  await assert.rejects(store.reveal('not-a-participant'), hasStatus(404));
  assert.equal(await readFile(data.statePath, 'utf8'), initial);
  assert.equal(store.healthy(), true);
  await store.reveal(store.list()[0].id);
});

for (const failAfterWrite of [false, true]) {
  test(`storage failure ${failAfterWrite ? 'after' : 'before'} writing fails closed for all queued reveals`, async (t) => {
    const data = await fixture(t);
    let fail = false;
    let writes = 0;
    const persist = async (nextState, statePath) => {
      writes += 1;
      if (fail && !failAfterWrite) throw new Error('injected storage failure');
      await writeFile(statePath, JSON.stringify(nextState));
      if (fail) throw new Error('injected storage failure');
    };
    const store = await createStore({ dataDir: data.dataDir, persist });
    const participants = store.list();
    const initialWrites = writes;
    fail = true;
    const results = await Promise.allSettled(participants.map(({ id }) => store.reveal(id)));
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      assert.equal(result.reason.statusCode, 503);
    }
    assert.equal(writes, initialWrites + 1);
    assert.equal(store.healthy(), false);
    await assert.rejects(store.reveal(participants[0].id), hasStatus(503));
  });
}

test('refresh preserves the saved draw and claims for equivalent whitespace and ordering', async (t) => {
  const data = await fixture(t, 'Alice Bob Cara\nBob\nCara\nDave\n');
  const store = await createStore({ dataDir: data.dataDir });
  await store.reveal(store.list()[0].id);
  const saved = await readFile(data.statePath, 'utf8');
  const listing = store.list();
  await writeFile(data.participantsPath, '\nDave\r\nCara\n\n Bob \nAlice\tCara Bob Bob\n');
  assert.equal(await store.refresh(), false);
  assert.equal(store.healthy(), true);
  assert.deepEqual(store.list(), listing);
  assert.equal(await readFile(data.statePath, 'utf8'), saved);
});

test('refresh resets IDs, assignments, and claim flags for valid participant or exclusion changes', async (t) => {
  for (const changed of ['Alice\nBob\nCara\nEve\n', 'Alice Bob Cara\nBob\nCara\nDave\n']) {
    const data = await fixture(t);
    const store = await createStore({ dataDir: data.dataDir });
    const previousIds = new Set(store.list().map(({ id }) => id));
    await store.reveal(store.list()[0].id);
    await writeFile(data.participantsPath, changed);
    assert.equal(await store.refresh(), true);
    assertFreshDraw(await data.readState(), changed, previousIds);
    assert.equal(store.healthy(), true);
    assert.ok(store.list().every(({ revealed }) => !revealed));
    assert.equal(await store.refresh(), false);
  }
});

for (const [label, invalid] of [
  ['missing', null],
  ['invalid', 'Alice Nobody\nBob\nCara\nDave\n'],
  ['impossible', 'Alice Bob\nBob\n'],
]) {
  test(`${label} participant input suspends reveals without erasing saved claims and recovers when restored`, async (t) => {
    const data = await fixture(t);
    const originalInput = await readFile(data.participantsPath, 'utf8');
    const store = await createStore({ dataDir: data.dataDir });
    const participant = store.list()[0];
    await store.reveal(participant.id);
    const saved = await readFile(data.statePath, 'utf8');
    const listing = store.list();
    if (invalid === null) await unlink(data.participantsPath);
    else await writeFile(data.participantsPath, invalid);

    await assert.rejects(store.refresh(), hasStatus(503));
    assert.equal(store.healthy(), false);
    await assert.rejects(store.reveal(participant.id), hasStatus(503));
    assert.equal(await readFile(data.statePath, 'utf8'), saved);

    await writeFile(data.participantsPath, originalInput);
    assert.equal(await store.refresh(), false);
    assert.equal(store.healthy(), true);
    assert.deepEqual(store.list(), listing);
    assert.equal(await readFile(data.statePath, 'utf8'), saved);
    await assert.rejects(store.reveal(participant.id), hasStatus(409));
  });
}

test('reveal checks edited participant input before using a stale ID', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const previousIds = new Set(store.list().map(({ id }) => id));
  const staleId = store.list()[0].id;
  const changed = 'Eve\nFinn\nGrace\nHugo\n';
  await writeFile(data.participantsPath, changed);

  await assert.rejects(store.reveal(staleId), hasStatus(404));
  assertFreshDraw(await data.readState(), changed, previousIds);
  assert.equal(store.healthy(), true);
  const fresh = store.list()[0];
  const result = await store.reveal(fresh.id);
  assert.ok(store.list().some(({ name }) => name === result.recipient));
  assert.notEqual(result.recipient, fresh.name);
});

test('reveal notices invalid edited input without a preceding refresh', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const { id } = store.list()[0];
  const saved = await readFile(data.statePath, 'utf8');
  await writeFile(data.participantsPath, 'Alice\n');
  await assert.rejects(store.reveal(id), hasStatus(503));
  assert.equal(store.healthy(), false);
  assert.equal(await readFile(data.statePath, 'utf8'), saved);
});

test('concurrent refreshes and reveals reset once and retain every subsequent claim', async (t) => {
  const data = await fixture(t);
  const store = await createStore({ dataDir: data.dataDir });
  const oldParticipants = store.list();
  const previousIds = new Set(oldParticipants.map(({ id }) => id));
  const changed = 'Alice Bob Cara\nBob\nCara\nDave\n';
  await writeFile(data.participantsPath, changed);
  const pending = [store.refresh(), store.refresh(), ...oldParticipants.map(({ id }) => store.reveal(id))];
  const results = await Promise.allSettled(pending);
  assert.deepEqual(results.slice(0, 2), [
    { status: 'fulfilled', value: true },
    { status: 'fulfilled', value: false },
  ]);
  for (const result of results.slice(2)) {
    assert.equal(result.status, 'rejected');
    assert.equal(result.reason.statusCode, 404);
  }
  assertFreshDraw(await data.readState(), changed, previousIds);

  const participants = store.list();
  const claims = await Promise.all(participants.flatMap(({ id }) => [store.refresh(), store.reveal(id)]));
  const recipients = [];
  for (let index = 0; index < claims.length; index += 2) {
    assert.equal(claims[index], false);
    recipients.push(claims[index + 1].recipient);
  }
  assert.equal(new Set(recipients).size, participants.length);
  assert.ok((await data.readState()).participants.every(({ revealed }) => revealed));
  const restarted = await createStore({ dataDir: data.dataDir });
  assert.deepEqual(restarted.list(), store.list());
});

for (const failAfterWrite of [false, true]) {
  test(`reset persistence failure ${failAfterWrite ? 'after' : 'before'} writing stays closed until restart`, async (t) => {
    const data = await fixture(t);
    let fail = false;
    let writes = 0;
    const persist = async (nextState, statePath) => {
      writes += 1;
      if (fail && !failAfterWrite) throw new Error('injected reset failure');
      await writeFile(statePath, JSON.stringify(nextState));
      if (fail) throw new Error('injected reset failure');
    };
    const store = await createStore({ dataDir: data.dataDir, persist });
    const previousIds = new Set(store.list().map(({ id }) => id));
    const staleId = store.list()[0].id;
    await store.reveal(staleId);
    const saved = await readFile(data.statePath, 'utf8');
    const initialWrites = writes;
    const changed = 'Alice Bob Cara\nBob\nCara\nDave\n';
    await writeFile(data.participantsPath, changed);
    fail = true;

    await assert.rejects(store.refresh(), hasStatus(503));
    assert.equal(store.healthy(), false);
    if (!failAfterWrite) assert.equal(await readFile(data.statePath, 'utf8'), saved);
    fail = false;
    await assert.rejects(store.refresh(), hasStatus(503));
    await assert.rejects(store.reveal(staleId), hasStatus(503));
    assert.equal(writes, initialWrites + 1);

    const restarted = await createStore({ dataDir: data.dataDir, persist });
    assert.equal(restarted.healthy(), true);
    assertFreshDraw(await data.readState(), changed, previousIds);
    assert.ok(restarted.list().every(({ revealed }) => !revealed));
  });
}

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { canonicalConfiguration, matchParticipants, parseParticipants } from './participants.js';

export async function persistState(state, statePath) {
  const temporaryPath = `${statePath}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, statePath);
    const directory = await open(dirname(statePath), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(error => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function failure(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

function validateState(state) {
  const invalid = () => { throw new Error('Saved state is invalid. Restore a backup or explicitly start a new draw.'); };
  if (!state || state.version !== 1 || !Array.isArray(state.configuration) || !Array.isArray(state.participants)) invalid();
  const configuration = state.configuration;
  if (configuration.length < 2 || configuration.some(p => !p || typeof p.name !== 'string'
    || !p.name || /\s/u.test(p.name) || !Array.isArray(p.exclusions)
    || p.exclusions.some(name => typeof name !== 'string'))) invalid();
  const configuredNames = new Set(configuration.map(p => p.name));
  if (configuredNames.size !== configuration.length) invalid();
  for (const p of configuration) {
    if (p.exclusions.some(name => !configuredNames.has(name))) invalid();
  }
  if (state.participants.length !== configuration.length) invalid();
  const ids = new Map();
  const names = new Set();
  const rules = new Map(configuration.map(p => [p.name, p]));
  for (const p of state.participants) {
    if (!p || typeof p.id !== 'string' || !/^[a-f0-9-]{36}$/.test(p.id) || ids.has(p.id)
      || !rules.has(p.name) || names.has(p.name) || typeof p.revealed !== 'boolean') invalid();
    ids.set(p.id, p);
    names.add(p.name);
  }
  const recipients = new Set();
  for (const p of state.participants) {
    const recipient = ids.get(p.recipientId);
    if (!recipient || recipients.has(p.recipientId) || p.id === p.recipientId
      || rules.get(p.name).exclusions.includes(recipient.name)) invalid();
    recipients.add(p.recipientId);
  }
}

function newDraw(participants) {
  const matches = matchParticipants(participants);
  const ids = new Map(participants.map(p => [p.name, randomUUID()]));
  return {
    version: 1,
    configuration: canonicalConfiguration(participants),
    participants: participants.map(({ name }) => ({
      id: ids.get(name), name, recipientId: ids.get(matches.get(name)), revealed: false,
    })),
  };
}

export async function createStore({ dataDir, persist = persistState }) {
  const directory = resolve(dataDir);
  try {
    if (!(await stat(directory)).isDirectory()) throw new Error('Not a directory.');
    await access(directory, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`Data directory must exist and be writable: ${directory}`);
  }
  async function readParticipants() {
    let input;
    try { input = await readFile(join(directory, 'participants.txt'), 'utf8'); }
    catch { throw new Error(`Cannot read participants.txt in ${directory}.`); }
    return parseParticipants(input);
  }
  const participants = await readParticipants();
  const configuration = canonicalConfiguration(participants);
  const statePath = join(directory, 'state.json');
  let state;
  let saved;
  try { saved = await readFile(statePath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Cannot read saved state. Check file permissions.');
  }
  if (saved !== undefined) {
    try { state = JSON.parse(saved); }
    catch { throw new Error('Saved state is corrupt. Restore a backup or explicitly start a new draw.'); }
    validateState(state);
    await chmod(statePath, 0o600);
  }
  if (!state || JSON.stringify(state.configuration) !== JSON.stringify(configuration)) {
    state = newDraw(participants);
    await persist(state, statePath);
  }
  let storageHealthy = true;
  let inputHealthy = true;
  let pending = Promise.resolve();
  const healthy = () => storageHealthy && inputHealthy;
  function enqueue(task) {
    const operation = pending.then(task);
    pending = operation.catch(() => {});
    return operation;
  }
  async function commit(next) {
    try { await persist(next, statePath); }
    catch {
      // A failure after rename may have consumed a claim or replaced a draw.
      // Never serve from potentially stale memory until the process restarts.
      storageHealthy = false;
      throw failure('The state could not be saved. Check storage and restart the server.', 503);
    }
    state = next;
  }
  // Called only inside the same queue as reveals, so a reset cannot overwrite a
  // concurrent claim. New IDs make requests from the previous draw harmless.
  async function refresh() {
    if (!storageHealthy) throw failure('The state could not be saved. Check storage and restart the server.', 503);
    let next;
    try {
      const updated = await readParticipants();
      if (JSON.stringify(canonicalConfiguration(updated)) === JSON.stringify(state.configuration)) {
        inputHealthy = true;
        return false;
      }
      next = newDraw(updated);
    } catch (error) {
      inputHealthy = false;
      throw failure(`Participant file needs correction: ${error.message}`, 503);
    }
    await commit(next);
    inputHealthy = true;
    return true;
  }
  return {
    healthy,
    refresh: () => enqueue(refresh),
    list: () => {
      if (!healthy()) throw failure('The list is unavailable. Ask the organizer to check the server.', 503);
      return state.participants.map(({ id, name, revealed }) => ({ id, name, revealed }));
    },
    reveal(id) {
      // The queue covers both the availability check and the entire durable write.
      return enqueue(async () => {
        await refresh();
        const participant = state.participants.find(p => p.id === id);
        if (!participant) throw failure('This name is not on the list.', 404);
        if (participant.revealed) throw failure('This name has already been opened.', 409);
        const next = structuredClone(state);
        next.participants.find(p => p.id === id).revealed = true;
        await commit(next);
        return { recipient: state.participants.find(p => p.id === participant.recipientId).name };
      });
    },
  };
}

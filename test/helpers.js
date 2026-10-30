import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const PARTICIPANTS = 'Alice\nBob\nCara\nDave\n';

export async function fixture(t, participants = PARTICIPANTS) {
  const dataDir = await mkdtemp(join(tmpdir(), 'secret-santa-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const participantsPath = join(dataDir, 'participants.txt');
  const statePath = join(dataDir, 'state.json');
  await writeFile(participantsPath, participants);
  return {
    dataDir,
    participantsPath,
    statePath,
    readState: async () => JSON.parse(await readFile(statePath, 'utf8')),
  };
}

export function hasStatus(statusCode) {
  return (error) => error.statusCode === statusCode;
}

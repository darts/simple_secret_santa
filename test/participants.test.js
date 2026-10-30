import assert from 'node:assert/strict';
import test from 'node:test';
import { matchParticipants, parseParticipants } from '../lib/participants.js';

test('participant lines accept whitespace, blank lines, and forward exclusions', () => {
  assert.deepEqual(parseParticipants('\r\n Alice\tBob Cara \r\nBob\r\n\nCara\n'), [
    { name: 'Alice', exclusions: ['Bob', 'Cara'] },
    { name: 'Bob', exclusions: [] },
    { name: 'Cara', exclusions: [] },
  ]);
});

test('participant parsing rejects duplicate names, unknown exclusions, and fewer than two people', () => {
  for (const input of ['', '\n\n', 'Alice\n', 'Alice\nAlice\n', 'Alice Nobody\nBob\n']) {
    assert.throws(() => parseParticipants(input), undefined, JSON.stringify(input));
  }
});

test('directional exclusions produce a valid nonreciprocal assignment', () => {
  const participants = parseParticipants('Alice Bob\nBob\nCara\n');
  const assignment = matchParticipants(participants);
  assert.ok(assignment instanceof Map);
  assert.equal(assignment.get('Alice'), 'Cara');
  assert.equal(assignment.get('Bob'), 'Alice');
  assert.equal(assignment.get('Cara'), 'Bob');
});

test('two participants can draw each other', () => {
  const assignment = matchParticipants(parseParticipants('Alice\nBob\n'));
  assert.equal(assignment.get('Alice'), 'Bob');
  assert.equal(assignment.get('Bob'), 'Alice');
});

test('matching finds the full solution under tight constraints', () => {
  const participants = parseParticipants('Alice Dave\nBob Cara Dave\nCara Alice Bob\nDave Alice Cara\n');
  const expected = { Alice: 'Cara', Bob: 'Alice', Cara: 'Dave', Dave: 'Bob' };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const assignment = matchParticipants(participants);
    assert.equal(assignment.size, participants.length);
    for (const [name, recipient] of Object.entries(expected)) {
      assert.equal(assignment.get(name), recipient);
    }
  }
});

test('randomized matching always gives each participant a distinct eligible recipient', () => {
  const participants = parseParticipants('Alice Bob\nBob Cara\nCara Dave\nDave\nEve Alice\n');
  const names = new Set(participants.map(({ name }) => name));
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const assignment = matchParticipants(participants);
    assert.equal(assignment.size, participants.length);
    assert.equal(new Set(assignment.values()).size, participants.length);
    for (const participant of participants) {
      const recipient = assignment.get(participant.name);
      assert.ok(names.has(recipient));
      assert.notEqual(recipient, participant.name);
      assert.ok(!participant.exclusions.includes(recipient));
    }
  }
});

test('impossible matching fails instead of returning partial assignments', () => {
  for (const input of ['Alice Bob\nBob\n', 'Alice Cara\nBob Cara\nCara Alice\n']) {
    assert.throws(() => matchParticipants(parseParticipants(input)));
  }
});

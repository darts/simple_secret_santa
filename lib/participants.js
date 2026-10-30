import { randomInt } from 'node:crypto';

export function parseParticipants(text) {
  const participants = [];
  const names = new Set();
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    const [name, ...excluded] = line.trim().split(/\s+/u);
    if (names.has(name)) throw new Error(`Duplicate participant "${name}" on line ${index + 1}.`);
    names.add(name);
    participants.push({ name, exclusions: [...new Set(excluded)].sort() });
  }
  if (participants.length < 2) throw new Error('At least two participants are required.');
  for (const { name, exclusions } of participants) {
    for (const excluded of exclusions) {
      if (!names.has(excluded)) throw new Error(`Unknown exclusion "${excluded}" for "${name}".`);
    }
  }
  return participants;
}

export function canonicalConfiguration(participants) {
  return participants.map(({ name, exclusions }) => ({
    name, exclusions: [...new Set(exclusions)].sort(),
  })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Augmenting paths find a complete matching whenever one exists, without an
// arbitrary retry limit. Shuffling randomizes the result, not uniformly.
export function matchParticipants(participants) {
  const candidates = new Map(participants.map(({ name, exclusions }) => [
    name, shuffled(participants.filter(p => p.name !== name && !exclusions.includes(p.name)).map(p => p.name)),
  ]));
  const recipientToGiver = new Map();
  function augment(giver, seen) {
    for (const recipient of candidates.get(giver)) {
      if (seen.has(recipient)) continue;
      seen.add(recipient);
      const previous = recipientToGiver.get(recipient);
      if (previous === undefined || augment(previous, seen)) {
        recipientToGiver.set(recipient, giver);
        return true;
      }
    }
    return false;
  }
  for (const { name } of shuffled(participants)) {
    if (!augment(name, new Set())) throw new Error('No valid draw exists for these participants and exclusions.');
  }
  return new Map([...recipientToGiver].map(([recipient, giver]) => [giver, recipient]));
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const html = readFileSync(resolve('index.html'), 'utf8');
const edge = readFileSync(resolve('supabase/functions/drive-duel-live-feed/index.ts'), 'utf8');

const script = html.match(/<script>\s*([\s\S]*?)<\/script>/)?.[1];
if (!script) throw Error('Drive Duel application script not found');

function sportsDbParser() {
  const start = script.indexOf('function sportsDbMatch(e){');
  const end = script.indexOf('\nasync function fetchSportsDbDay(', start);
  if (start < 0 || end < 0) throw Error('SportsDB adapter missing');
  return new Function(script.slice(start, end) + '\nreturn sportsDbMatch;')();
}

const nfl = {
  idEvent: '1234567',
  idLeague: '4391',
  strLeague: 'NFL',
  strAwayTeam: 'Carolina Panthers',
  strHomeTeam: 'Green Bay Packers',
  strTimestamp: '2026-10-29T20:15:00',
  strStatus: 'NS',
  intAwayScore: null,
  intHomeScore: null
};

test('browser script stays syntactically valid', () => {
  assert.doesNotThrow(() => new Function(script));
});

test('independent NFL fixture displays as a distinct limited-source game', () => {
  const game = sportsDbParser()(nfl);
  assert.equal(game.id, 'tsdb-1234567');
  assert.equal(game.status.type.state, 'pre');
  assert.equal(game.source, 'TheSportsDB');
  assert.equal(game.partial, true);
  assert.equal(game.competitions[0].competitors[0].score, '—');
});

test('independent NFL game rejects unrelated leagues', () => {
  assert.equal(sportsDbParser()({ ...nfl, strLeague: 'NBA', idLeague: '4387' }), null);
});

test('independent NFL scores do not certify possession history or enable scoring', () => {
  assert.match(edge, /provider:"TheSportsDB \(independent backup\)"/);
  assert.match(edge, /scoringSafe:false,note:"Independent scoreboard available/);
  assert.match(script, /dataset\.verified=automaticReady\?'true':'false'/);
  assert.match(script, /automaticReady=payload\.scoringSafe===true/);
});

test('weekly fixture listing falls back when the edge service is down', () => {
  assert.match(script, /Direct scoreboard fallback/);
  assert.match(script, /TheSportsDB backup/);
  assert.match(script, /footballWeekDates\(/);
  assert.doesNotMatch(script, /Could not reach ESPN right now/);
});

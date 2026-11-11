const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Leagues } = require('../leagues');
const { MatchStats } = require('../match-stats');

test('deleted league files are retried after restart without making reports visible', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bluff-delete-test-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(target), /^bluff-delete-test-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  const stats = new MatchStats(root);
  const leagues = new Leagues(root, stats, {});
  const league = { code: '01234567', owner: 'host', members: ['host'], endedAt: 1 };
  leagues.save(league);
  stats.save({ id: 'league-report', leagueCode: league.code, status: 'completed' });
  stats.save({ id: 'ordinary-report', status: 'completed' });
  const lockedFile = path.join(root, 'matches', 'league-report.json');
  const rm = fs.rmSync;
  const locked = t.mock.method(fs, 'rmSync', (file, options) => {
    if (file === lockedFile) throw Object.assign(new Error('simulated file lock'), { code: 'EBUSY' });
    return rm(file, options);
  });
  const log = t.mock.method(console, 'error', () => {});
  assert.deepEqual(leagues.command('host', { action: 'delete', code: league.code }), { deleted: true, cleanupPending: true });
  assert.equal(stats.matches.has('league-report'), false);
  assert.deepEqual(leagues.list('host'), []);
  assert.equal(fs.existsSync(lockedFile), true);
  assert.equal(log.mock.callCount(), 1);
  locked.mock.restore();

  const reloadedStats = new MatchStats(root);
  const reloadedLeagues = new Leagues(root, reloadedStats, {});
  assert.equal(fs.existsSync(lockedFile), false);
  assert.equal(fs.existsSync(path.join(root, 'leagues', league.code + '.json')), false);
  assert.deepEqual([...reloadedStats.matches.keys()], ['ordinary-report']);
  assert.deepEqual(reloadedLeagues.list('host'), []);
});

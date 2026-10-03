const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { Script } = require('node:vm');
const test = require('node:test');

const source = readFileSync('helloquiz-anki-turbo.user.js', 'utf8');

test('userscript parses as JavaScript', () => {
  assert.doesNotThrow(() => new Script(source));
});

test('site selectors do not pin generated CSS-module hashes', () => {
  const generatedCssModuleClass = /-module__[A-Za-z0-9_-]{6}__[A-Za-z0-9_-]+/g;
  assert.deepEqual(source.match(generatedCssModuleClass), null);
});

test('quiz list discovery is anchored to learn-mode links', () => {
  assert.match(source, /querySelector\('table a\[href\*="\?learn"\]'\)/);
  assert.match(source, /learnLink\.closest\('table'\)/);
});

// The userscript is one IIFE with no exports, so lift a top-level helper out
// of the source by name (brace-matched) and evaluate it on its own.
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}' && --depth === 0) return source.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
}

function load(...names) {
  const body = names.map(extractFunction).join('\n');
  return new Function(`${body}; return { ${names.join(', ')} };`)();
}

test('parseIntervalLabel reads the grading buttons\' intervals', () => {
  const { parseIntervalLabel } = load('parseIntervalLabel');
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  assert.equal(parseIntervalLabel('again (in 59 sec)'), 59 * 1000);
  assert.equal(parseIntervalLabel('again (in 4 min)'), 4 * MIN);
  assert.equal(parseIntervalLabel('hard (in 9 min)'), 9 * MIN);
  assert.equal(parseIntervalLabel('good (in 3 hours)'), 3 * 60 * MIN);
  assert.equal(parseIntervalLabel('good (in 4 days)'), 4 * DAY);
  assert.equal(parseIntervalLabel('good (in 1 day)'), DAY);
  assert.equal(parseIntervalLabel('easy (next wk)'), 7 * DAY);
  assert.equal(parseIntervalLabel('easy (in 3 wk)'), 21 * DAY);
  assert.equal(parseIntervalLabel('easy (in 2 mo)'), 60 * DAY);
  assert.equal(parseIntervalLabel('easy (next yr)'), 365 * DAY);
  assert.equal(parseIntervalLabel('again'), null);
  assert.equal(parseIntervalLabel('again (soon)'), null);
});

test('card tracker follows the cards\' next appearances', () => {
  const t = load('newCardTracker', 'trackCardBatch', 'trackCardAnswer', 'trackedCardsLeft');
  const at = (hhmm) => Date.parse(`2026-10-03T${hhmm}:00Z`);
  const MIN = 60 * 1000;
  const DAY = 24 * 60 * MIN;
  const tracker = t.newCardTracker();

  t.trackCardBatch(tracker, ['A', 'B', 'C', 'D']);
  assert.equal(t.trackedCardsLeft(tracker, at('12:00')), 4);
  // wrong on the map: no buttons, the site's 5 minutes
  t.trackCardAnswer(tracker, 'A', 1, null, at('12:00'));
  assert.equal(t.trackedCardsLeft(tracker, at('12:00')), 3);
  t.trackCardAnswer(tracker, 'B', 3, 2 * DAY, at('12:01'));
  assert.equal(t.trackedCardsLeft(tracker, at('12:01')), 2);
  // C answered at 12:06: D left, and A is due again
  t.trackCardAnswer(tracker, 'C', 1, 5 * MIN, at('12:06'));
  assert.equal(t.trackedCardsLeft(tracker, at('12:06')), 2);
  t.trackCardAnswer(tracker, 'D', 3, 4 * DAY, at('12:07'));
  assert.equal(t.trackedCardsLeft(tracker, at('12:07')), 1);

  // practice more at 12:08 brings back only A; C isn't due until 12:11
  t.trackCardBatch(tracker, ['A']);
  assert.equal(t.trackedCardsLeft(tracker, at('12:08')), 1);
  // A answered only after 12:12: C has come back meanwhile
  t.trackCardAnswer(tracker, 'A', 3, DAY, at('12:12'));
  assert.equal(t.trackedCardsLeft(tracker, at('12:12')), 1);
});

test('card tracker treats a passed card without a readable interval as gone', () => {
  const t = load('newCardTracker', 'trackCardBatch', 'trackCardAnswer', 'trackedCardsLeft');
  const tracker = t.newCardTracker();
  t.trackCardBatch(tracker, ['A']);
  t.trackCardAnswer(tracker, 'A', 3, null, 0);
  assert.equal(t.trackedCardsLeft(tracker, 10 * 365 * 24 * 60 * 60 * 1000), 0);
});

test('ratingFromBody reads the rating from a guess request body', () => {
  const { ratingFromBody } = load('ratingFromBody');
  assert.equal(ratingFromBody('{"guess":"1","loadId":"x","rating":3}'), 3);
  assert.equal(ratingFromBody('not json'), null);
  assert.equal(ratingFromBody(undefined), null);
});

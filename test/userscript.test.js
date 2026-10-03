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

test('countCardsLeft counts every card of the queue response', () => {
  const { countCardsLeft } = load('countCardsLeft');
  const queue = [
    { state: null, due: null },
    { state: 1, due: '2026-10-02T15:30:00Z' },
    { state: 2, due: '2099-01-01T00:00:00Z' }, // a ?more card can be due later
  ];
  assert.equal(countCardsLeft(queue), 3);
  assert.equal(countCardsLeft([{ state: 2, due: '2099-01-01T00:00:00Z' }]), 1);
  assert.equal(countCardsLeft([]), 0);
  assert.equal(countCardsLeft(null), null);
});

test('cardsLeftAfterRating keeps failed cards queued', () => {
  const { cardsLeftAfterRating } = load('cardsLeftAfterRating');
  assert.equal(cardsLeftAfterRating(5, 1), 5);
  assert.equal(cardsLeftAfterRating(5, 2), 4);
  assert.equal(cardsLeftAfterRating(5, 4), 4);
  assert.equal(cardsLeftAfterRating(0, 3), 0);
  assert.equal(cardsLeftAfterRating(null, 3), null);
  assert.equal(cardsLeftAfterRating(5, null), 5);
});

test('ratingFromBody reads the rating from a guess request body', () => {
  const { ratingFromBody } = load('ratingFromBody');
  assert.equal(ratingFromBody('{"guess":"1","loadId":"x","rating":3}'), 3);
  assert.equal(ratingFromBody('not json'), null);
  assert.equal(ratingFromBody(undefined), null);
});

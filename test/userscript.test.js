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

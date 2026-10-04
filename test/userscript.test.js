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

test('chooseNextQuiz walks the remembered order, not the live one', () => {
  const { chooseNextQuiz } = load('chooseNextQuiz');
  const q = (id, overdueCount) => ({ id, title: id, overdueCount });
  const order = [q('A', 45), q('B', 1), q('C', 2), q('D', 1), q('E', 0)];

  // B was finished and dropped to the end of the live list: still C next.
  const live = [q('A', 45), q('C', 2), q('D', 1), q('E', 0), q('B', 0)];
  assert.deepEqual(chooseNextQuiz(order, live, 'B'), { id: 'C', order });
  assert.equal(chooseNextQuiz(order, live, 'C').id, 'D');

  // a quiz the live list says is done meanwhile is skipped
  const liveCDone = [q('A', 45), q('D', 1), q('B', 0), q('C', 0)];
  assert.equal(chooseNextQuiz(order, liveCDone, 'B').id, 'D');

  // without a live list, the remembered counts decide
  assert.equal(chooseNextQuiz(order, null, 'A').id, 'B');
});

test('chooseNextQuiz starts over from the live list at the end', () => {
  const { chooseNextQuiz } = load('chooseNextQuiz');
  const q = (id, overdueCount) => ({ id, title: id, overdueCount });
  const order = [q('A', 45), q('B', 1), q('C', 2), q('D', 1)];
  const live = [q('A', 30), q('C', 0), q('B', 0), q('D', 0), q('F', 3)];

  // D was last in line: the live list becomes the new order
  assert.deepEqual(chooseNextQuiz(order, live, 'D'), { id: 'A', order: live });
  // never the current quiz itself
  assert.equal(chooseNextQuiz(order, live, 'A').id, 'F');
  // a quiz outside the remembered order starts over too
  assert.deepEqual(chooseNextQuiz(order, live, 'X'), { id: 'A', order: live });
  // nothing overdue anywhere
  assert.deepEqual(chooseNextQuiz(order, [q('A', 0)], 'D'), { id: null, order: [q('A', 0)] });
});

test('SCRIPT_VERSION and UPDATE_URL match the userscript header', () => {
  const header = (name) => source.match(new RegExp(`^// @${name}\\s+(\\S+)`, 'm'))[1];
  assert.equal(source.match(/const SCRIPT_VERSION = '([^']+)'/)[1], header('version'));
  assert.equal(source.match(/const UPDATE_URL = '([^']+)'/)[1], header('updateURL'));
});

test('compareVersions compares numerically, part by part', () => {
  const { compareVersions } = load('compareVersions');
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.9.1', '1.9.0'), 1);
  assert.equal(compareVersions('2.0', '1.99.99'), 1);
  assert.equal(compareVersions('1.9', '1.9.0'), 0);
  assert.equal(compareVersions('1.9.0', '1.9.0'), 0);
});

test('parseScriptVersion reads @version from a published script', () => {
  const { parseScriptVersion } = load('parseScriptVersion');
  assert.equal(parseScriptVersion(source), source.match(/^\/\/ @version\s+(\S+)/m)[1]);
  assert.equal(parseScriptVersion('// ==UserScript==\n// @version      2.0.1\n'), '2.0.1');
  assert.equal(parseScriptVersion('<html>404</html>'), null);
  assert.equal(parseScriptVersion(null), null);
});

test('browseQuizIdFromPath recognizes only the browse route', () => {
  const { browseQuizIdFromPath } = load('browseQuizIdFromPath');
  assert.equal(browseQuizIdFromPath('/quiz/dS9lE6vjHuOK/browse'), 'dS9lE6vjHuOK');
  assert.equal(browseQuizIdFromPath('/quiz/dS9lE6vjHuOK/browse/'), 'dS9lE6vjHuOK');
  assert.equal(browseQuizIdFromPath('/quiz/dS9lE6vjHuOK/browse/extra'), null);
  assert.equal(browseQuizIdFromPath('/quiz/dS9lE6vjHuOK'), null);
  assert.equal(browseQuizIdFromPath('/learn'), null);
});

test('cardMatchesQuery searches the question loosely', () => {
  const { cardMatchesQuery } = load('normalizeSearchText', 'cardMatchesQuery');
  const card = { question: 'Bad Tölz-Wolfratshausen', answer: '11.4,47.7', hint: 'Bayern', customHint: 'Isar' };
  assert.equal(cardMatchesQuery(card, 'tolz'), true);
  assert.equal(cardMatchesQuery(card, 'TÖLZ'), true);
  assert.equal(cardMatchesQuery(card, 'bad wolfrats'), true);
  assert.equal(cardMatchesQuery(card, '  bad   tolz '), true);
  assert.equal(cardMatchesQuery(card, 'bad munchen'), false);
  assert.equal(cardMatchesQuery(card, ''), true);
  assert.equal(cardMatchesQuery(card, '   '), true);
  // answers and hints aren't shown, so they don't match either
  assert.equal(cardMatchesQuery(card, '47.7'), false);
  assert.equal(cardMatchesQuery(card, 'bayern'), false);
  assert.equal(cardMatchesQuery(card, 'isar'), false);
  // API nulls and numbers don't throw
  assert.equal(cardMatchesQuery({ question: 45, answer: null, hint: null }, '45'), true);
  assert.equal(cardMatchesQuery({ question: null }, 'x'), false);
});

test('compareCardsByQuestion sorts naturally', () => {
  const { compareCardsByQuestion } = load('compareCardsByQuestion');
  const sorted = [{ question: '10' }, { question: '2' }, { question: 'b' }, { question: 'A' }, { question: null }]
    .sort(compareCardsByQuestion).map((c) => c.question);
  assert.deepEqual(sorted, [null, '2', '10', 'A', 'b']);
});

test('buildPunishRequest rates the card "again" through the guess endpoint', () => {
  const { buildPunishRequest } = load('buildPunishRequest');
  const { url, init } = buildPunishRequest('DDZCULBN4Rwf7  ', { id: 'fBz40iFNThz2T', answer: '63' });
  assert.equal(url, '/api/game/DDZCULBN4Rwf7%20%20/question/fBz40iFNThz2T/guess');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['Content-Type'], 'text/plain;charset=UTF-8');
  assert.deepEqual(JSON.parse(init.body), { guess: '63', loadId: '', rating: 1 });
  assert.equal(JSON.parse(buildPunishRequest('p', { id: 'x', answer: null }).init.body).guess, '');
});

test('shouldSendPunish blocks repeats while pending or done', () => {
  const { shouldSendPunish } = load('shouldSendPunish');
  assert.equal(shouldSendPunish(undefined), true);
  assert.equal(shouldSendPunish({ error: 'x' }), true);
  assert.equal(shouldSendPunish('pending'), false);
  assert.equal(shouldSendPunish('done'), false);
});

test('userscript has no literal combining marks (they break when served without a charset)', () => {
  assert.equal(/[̀-ͯ]/.test(source), false);
});

test('isImageQuestion recognizes image cards', () => {
  const { isImageQuestion } = load('isImageQuestion');
  assert.equal(isImageQuestion({ question: 'https://i.imgur.com/abc123.png' }), true);
  assert.equal(isImageQuestion({ question: 'https://cdn.example.com/poles/7?w=200' }), true);
  assert.equal(isImageQuestion({ question: '//cdn.example.com/a.jpg' }), true);
  assert.equal(isImageQuestion({ question: '/uploads/sign.webp' }), true);
  assert.equal(isImageQuestion({ question: 'data:image/png;base64,AAAA' }), true);
  assert.equal(isImageQuestion({ question: 'whatever', questionFormat: 'image' }), true);
  assert.equal(isImageQuestion({ question: 'München' }), false);
  assert.equal(isImageQuestion({ question: '45' }), false);
  assert.equal(isImageQuestion({ question: 'Bad Tölz / Wolfratshausen' }), false);
  assert.equal(isImageQuestion({ question: '/not an image' }), false);
  assert.equal(isImageQuestion({ question: null }), false);
});

test('normalQuizIdFromLocation recognizes only the normal quiz page', () => {
  const { normalQuizIdFromLocation } = load('normalQuizIdFromLocation');
  assert.equal(normalQuizIdFromLocation('/quiz/nUVUMfYMZvop', ''), 'nUVUMfYMZvop');
  assert.equal(normalQuizIdFromLocation('/quiz/nUVUMfYMZvop/', ''), 'nUVUMfYMZvop');
  assert.equal(normalQuizIdFromLocation('/quiz/nUVUMfYMZvop', '?learn'), null);
  assert.equal(normalQuizIdFromLocation('/quiz/nUVUMfYMZvop', '?x=1&learn'), null);
  assert.equal(normalQuizIdFromLocation('/quiz/nUVUMfYMZvop/browse', ''), null);
  assert.equal(normalQuizIdFromLocation('/quiz/nUVUMfYMZvop/remixes', ''), null);
  assert.equal(normalQuizIdFromLocation('/quiz/new', '?remix=nUVUMfYMZvop'), null);
  assert.equal(normalQuizIdFromLocation('/learn', ''), null);
});

test('isQuizInDeck tells whether a quiz is in the anki deck list', () => {
  const { isQuizInDeck } = load('isQuizInDeck');
  const deck = [{ id: 'A', deletedAt: null }, { id: 'B', deletedAt: '2026-01-01' }];
  assert.equal(isQuizInDeck(deck, 'A'), true);
  assert.equal(isQuizInDeck(deck, 'C'), false);
  assert.equal(isQuizInDeck(deck, 'B'), false); // removed from the deck
  assert.equal(isQuizInDeck([], 'A'), false);
  assert.equal(isQuizInDeck(null, 'A'), null); // unknown
});

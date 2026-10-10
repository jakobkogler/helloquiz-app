# Normal quiz pages — design

Bring the userscript's anki-mode features to the normal (non-anki) quiz
pages, e.g. `https://helloquiz.app/quiz/Ao2Kdw8zHt81`, and let playing a
normal game grade the quiz's anki cards.

## Goal

Playing a quiz the normal way gets the same countdown, review pause and
progress box as anki mode, and — when switched on — also does your anki
reviews: each card answered in the normal game is graded on the anki
side.

## Scope

In:

- Normal quiz pages `/quiz/<id>` (no `?learn`), in the site's **normal**
  mode only.
- Countdown (shared duration with the anki page of the same quiz), review
  pause after mistakes, progress box, settings block, two new grading
  settings.

Out:

- The site's *show answers*, *type answer* and *draw* modes: the script
  stays out of them (only the existing *anki mode* / *browse cards* links
  remain).
- *Finish today's cards*, the end-of-quiz nav buttons (*next quiz*, …),
  the practice-more preview, the *N other overdue quizzes* line.
- The site's own keys (a, d, s, space, p) are left alone.

## Architecture

One codebase, one set of machinery: the script gets a **page mode** —
`'anki'`, `'normal'`, or none — instead of only asking "is this an anki
page?". The timer, the question mirror, the review pause (with its
pre-paint hiding and map-click blocking), the settings block and the
progress box run in both modes. Mode-specific code branches only where the
pages differ:

| Concern | anki mode | normal mode |
|---|---|---|
| start of a run | "Click to start" pause | the site's *▶ start* button (no extra pause) |
| answer outcome | console `correct`/`incorrect` + grading buttons | console `correct`/`incorrect` only |
| grading | the site's grading buttons (auto-grade by speed) | the anki API, see *Grading* |
| end of a run | nav buttons (practice more, next quiz, …) | the site's start screen (score, *▶ start*) |
| progress box | cards left (own tracker) + other overdue quizzes | questions left from the site's *x/y* |
| finish today's cards | yes | no |

A separate module for normal pages was rejected: it would duplicate the
trickiest parts (mirror, pre-paint hiding, click blocking, tab-switch
handling), and every fix would have to be made twice.

### Page mode

- `anki`: `/learn`, or `/quiz/<id>?learn` (as today).
- `normal`: `/quiz/<id>` without `?learn` (not `/browse`, `/remixes`,
  `/new`, …), while the site's mode radio `opt-mode-Normal` is checked.
  Switching the radio to another mode turns the features off (as leaving
  anki mode does today); switching back turns them on.
- none: everything else.

## Settings

Settings stay one shared object in localStorage; each page shows only the
ones that apply. The block goes into the site's settings panel on the
normal page as it does on anki pages.

| Setting | anki page | normal page |
|---|---|---|
| countdown on/off, seconds, *quiz timer override* (per quiz title — the normal and anki page of a quiz share it) | ✓ | ✓ |
| pause after mistakes | ✓ | ✓ |
| **always pause after answer** — new, stored `pauseAfterAnswer`, default off; pauses after right answers too (and after mistakes, even with that pause off) | — | ✓ |
| show cards left | ✓ | ✓ (as progress) |
| auto-grade by speed + thresholds | ✓ | — (the *grade anki: correct answers* row has its own two thresholds instead) |
| finish today's cards | ✓ | — |
| **grade anki: wrong answers** — new, stored `gradeAnkiWrong`, default off | — | ✓ |
| **grade anki: correct answers by speed: easy _ % / good _ %** — new, stored `gradeAnkiCorrect` (thresholds `gradeAnkiEasy` / `gradeAnkiGood`, default 66 / 33, separate from the anki page's), default off | — | ✓ |

Help texts of the two new settings say: this grades the quiz's cards on
the anki page, so playing the normal quiz also does your anki reviews; a
wrong answer or a timeout grades *again*, a correct one is graded by speed
with its own thresholds; every answer counts, also the repeats of
*recycle missed answers*. For a quiz that isn't in the anki deck both are greyed out
with a short note ("not in your anki deck").

Both sync across tabs like the other settings.

## Game flow (normal mode)

- **Start:** the countdown starts when the first question appears after
  *▶ start*.
- **Answer detection:** the site's guess request
  `POST /api/game/<game>/question/<card>/guess` (body
  `{"guess", "game", "loadId"}`, no `rating`) names the answered card; the
  console message `0 'correct'` / `0 'incorrect'` follows. A new game,
  `POST /api/quiz/<id>/new` (body `{"mode":"Normal"}`), resets the per-game
  state.
- **Correct in time:** the countdown stops; the site moves on; the next
  question's countdown starts.
- **Wrong:** with *pause after mistakes* on, the mirror keeps showing the
  missed question, the site's next question stays hidden, map clicks are
  blocked and the countdown doesn't start. A map click/tap or key 1
  continues: the next question appears and its countdown starts. With the
  pause off, it moves straight on. With *always pause after answer* on, a
  correct answer pauses the same way.
- **Timeout:** as in anki mode — the bar greys out, the question stays
  answerable, and whatever is answered then counts as failed (grade 1);
  the pause follows.
- **The site's pause (‖, p) / stop (■):** while the site shows no
  question, the countdown is paused (resumes with the question). Stop ends
  the game; the start screen has no countdown.
- **Wrong last answer:** like anki mode's end-of-quiz pause — the missed
  question stays on screen and the end screen (score, *▶ start*) shows
  only after the continue click, so that click can't start a new game.

## Grading the anki card

Only with a *grade anki* setting on, and only for a quiz in the anki deck
(`GET /api/quiz/anki`, once per page).

- **When:** right after the answer's console message — every answer,
  including the repeats of a missed card that *recycle missed answers*
  brings back.
- **Rating:**
  - wrong, or after a timeout: 1 (*grade anki: wrong answers*);
  - correct: from the leftover countdown with the row's own thresholds —
    4 easy, 3 good, 2 hard (*grade anki: correct answers*);
  - correct with the countdown off: 3 (good).
- **Request:** the card browser's punish path —
  the anki play id from `GET /api/quiz/<id>/anki/question` (or its `?more`
  card), then `POST /api/game/<play>/question/<card>/guess` with
  `{"guess": <card's answer>, "loadId": "", "rating": <rating>}`. The
  card's answer comes from the site's own
  `GET /api/quiz/<id>/question?personalHints=true` response (seen through
  the fetch hook), else fetched once. The play id is fetched once per page
  and refetched after a failure.
- **Failure:** a short toast "couldn't grade the anki card"; the game
  carries on. With `DEBUG` on, each grading logs card, rating and result.

## Progress box (normal mode)

- With *show cards left* on and the compact popover closed (✖): the
  top-right box shows *N questions left*, where N = y − x from the site's
  progression *x/y*. Taken from the site's numbers on every pass, so
  recycled questions are counted however the site counts them. The site's
  progression line is hidden meanwhile.
- With *show cards left* off: no box, the site's progression shows as
  usual.

## Release

- Version 1.15.0 (new minor), with its own CHANGELOG section.
- README: a section for normal quiz pages and the two new settings.
- `docs/helloquiz-api.md`: `POST /api/quiz/<id>/new`, the normal guess
  body, `/question?personalHints=true`.

## Testing

- Unit tests for the pure pieces: the rating choice (wrong, timeout, by
  speed, no countdown); parsing *x/y* into questions left; the page-mode decision (anki,
  normal, other site mode, other pages).
- Headless smoke test on a stub normal-quiz page (start, questions, guess
  requests, console messages): the pause holds the next question and the
  countdown; the right grading requests go out, again for each recycled
  answer; nothing is sent with the settings off or for a quiz not in the
  deck; anki pages behave as before.
- Finally a check on the real site by the user.

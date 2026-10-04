# HelloQuiz Anki Turbo

A [Tampermonkey](https://www.tampermonkey.net/) / [Violentmonkey](https://violentmonkey.github.io/) userscript that adds Anki-mode enhancements to [helloquiz.app](https://helloquiz.app): a per-question countdown that auto-fails cards you answer too slowly, a review pause after mistakes, and keyboard shortcuts.

## Features

- **Per-question countdown** — a thin timer bar counts down from a configurable number of seconds. When it runs out, the card is automatically graded as failed ("again"), so slowly scanning the map for the right city/region gets penalized automatically. The bar's color previews the auto-grade zones below as it counts down — green, then orange, then red — whether or not auto-grading is actually turned on.
- **Auto-grade by speed** (off by default) — when a question is answered correctly in time, the card grades itself from how much of the countdown was left, instead of asking you for *hard* / *good* / *easy*. The two thresholds are configurable percentages of the countdown, by default 66% and 33%: with the default 10 second countdown an answer within 3.4s is *easy*, within 6.7s *good*, and anything slower *hard*. Answering too slowly still fails the card as before. Needs the countdown to be enabled.
- **Review pause after mistakes** — when you answer wrong (or time out), the quiz pauses on the current card so you can study and learn it before moving on. This replaces the app's own **"force correct click"** mode, which doesn't work correctly for city quizzes — the review pause gives you the same "look at the right answer before continuing" effect on every quiz type.
- **Adjusted hints** — the hint below the question (and its *display* / *edit* actions) always belongs to the question you actually see, so viewing and changing hints works even in the pause mode and on the grading and end-of-quiz screens.
- **Links between the anki and normal quiz** — the action list next to the quiz title gets a *normal quiz* link in anki mode, which opens the same quiz outside of anki mode, and an *anki mode* link on the normal quiz page, which goes the other way.
- **Open all due quizzes at once** — a button next to the *quizzes* heading on `/learn` opens every quiz that has overdue questions in its own tab, so a study session starts with exactly the quizzes that need work. This needs pop-ups to be allowed (see the note below).
- **Settings** — the quiz's settings panel is extended, so that you can enable/disable the countdown timer, set the timer duration, enable/disable auto-grading (and its two thresholds), and enable/disable the review pause. The timer duration defaults to one value for all quizzes, but you can override it per quiz — tick *quiz timer override* while in a quiz to give just that one its own duration. Each setting has a **?** next to it that shows a short explanation of what it does. All settings are remembered across sessions and sync instantly to every other helloquiz.app tab open in the same browser, but are stored locally, so they are not synced across devices.
- **Keyboard shortcuts** with matching on-screen key badges:
  - <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> — grade the current card (again / hard / good / easy)
  - <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> — end-of-quiz navigation: practice more (`▶`) / select quiz (`⇋`) / next quiz / most overdue quiz (`→`).
  - <kbd>Esc</kbd> — jump back to the `/learn` (anki mode) list.
  - <kbd>1</kbd> / <kbd>2</kbd> / <kbd>3</kbd> / <kbd>4</kbd> open the first / second / third / forth quiz in the list
- **Card browser** — a *browse* link on every `/learn` row (and *browse cards* in a quiz's title) opens `/quiz/<id>/browse`: all cards of that quiz, searchable by their question (case and accents don't matter); image quizzes show a small thumbnail of each picture. For a quiz in your anki deck, each card has a **punish** button that rates it *again* right away, so a card you just found out you forgot — say an area code while playing GeoGuessr — comes back in your next review.
- **Update notice** — every 3 hours the script checks the published version on GitHub, and when a newer one is out, the `/learn` quiz list shows a banner with links to *update* (your userscript manager then offers the new version), the *changelog*, and *dismiss* (hides it until an even newer version). It never shows inside a quiz.
- **Auto pause/resume** — the countdown pauses when you switch tabs or the window loses focus, and resumes where it left off when you come back.
- **Next quiz in line** — the end-of-quiz screen gets a *next quiz* button (key <kbd>3</kbd>) that works through the anki quiz list in order: start with the second quiz, and it takes you to the third, fourth, … The site's own button, which always goes back to the most overdue quiz, stays as *most overdue quiz* (key <kbd>4</kbd>). The order is the list as it was on `/learn` (finished quizzes drop down the live list, so it isn't followed directly); quizzes without overdue cards by now are skipped, and once the end is reached it starts over from the current list.
- **Cards left** — while the compact view's popover is closed (the ✖ tab, the default when a quiz opens), a small box shows how many cards are still coming in the quiz, e.g. `12 cards left`, and below it how many other quizzes still have overdue cards (`4 other overdue quizzes`); opening ⓘ or ⚙ replaces it as usual. The count follows each card's next appearance: answering a card schedules it by the interval its grading button shows (e.g. *again (in 4 min)*, or 5 minutes for a wrong answer on the map), and it counts again once that time has come — whether it comes back in the same run or on *practice more*. The count is updated on every answer and every batch of cards the quiz loads, and starts fresh when you reopen the quiz. Can be turned off in the settings (*show cards left*).
- **Settings popover closes on re-click** — the compact view's icon strip (ⓘ / ✖ / ⚙) normally does nothing when you click the already-active ⓘ or ⚙ tab again; this makes that click close the popover too, the same as clicking ✖.

## Installation

1. Install a userscript manager such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/).
2. Install the script from its [raw URL](https://raw.githubusercontent.com/jakobkogler/helloquiz-app/main/helloquiz-anki-turbo.user.js) — most userscript managers will detect it and prompt to install. Alternatively, open `helloquiz-anki-turbo.user.js` and let the manager install it (or add it as a new script and paste the contents).
3. Navigate to an [Anki-mode page on helloquiz.app](https://helloquiz.app/learn) — the script activates automatically.

> **Note:** This currently works best with the app's **"force correct click"** setting **disabled**. With it enabled the review pause doesn't behave correctly (in particular on city quizzes), so leave it off for now — the review pause covers the same use case.

> **Note:** The script currently only works correctly in the app's **compact** quiz mode. In the full-map mode some parts (e.g. the settings panel additions) don't display properly yet.

> **Note:** The *open … due quizzes* button opens several tabs at once, which browsers block by default. On the first click you will likely get only one tab (or none) plus a "pop-ups blocked" hint in the address bar — **allow pop-ups for helloquiz.app** there and click the button again. The script shows a banner telling you how many tabs were blocked, so you always know it happened.

## Screenshots

The countdown bar across the top, and the *Anki Turbo Config* options in the quiz's settings panel:

![The countdown timer bar and the Anki Turbo Config settings](screenshots/config-timer.png)

Keyboard-shortcut badges and labels on the buttons, including the end-of-quiz *next quiz* (next in line) and *most overdue quiz* buttons:

![Keyboard shortcut hints and the next quiz button on the end-of-quiz screen](screenshots/keyboard-shortcuts.png)

The review pause after a wrong answer, so you can study the map you just missed — it works even on city quizzes — and the cards still left in the quiz, with the number of other overdue quizzes:

![The review pause after a mistake and the cards-left box](screenshots/pause.png)

The card browser, where you can search a quiz's cards and punish the ones you forgot:

![The card browser with its search box and punish buttons](screenshots/card-browser.png)

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for what changed in each version.

## Development

The regression suite uses Node's built-in test runner and has no package
dependencies:

```bash
npm test
```

It checks that the userscript parses, that selectors do not pin generated
CSS-module hashes from a particular helloquiz.app build, and that quiz-list
discovery stays anchored to learn-mode links.

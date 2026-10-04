# Changelog

All notable changes to the HelloQuiz Anki Turbo userscript, newest first.
From 1.10.0 on, every version has its own section; older releases are
grouped by minor version (each including its patch releases).

## 1.12.0 — 2026-10-04

- The cards-left box also shows how many other quizzes still have overdue
  cards, e.g. *4 other overdue quizzes*.

## 1.11.0 — 2026-10-04

- **Card browser** at `/quiz/<id>/browse`, linked from every `/learn` row
  (*browse*) and the quiz title (*browse cards*): all cards of a quiz,
  searchable by question (image quizzes show thumbnails). For a quiz in
  your anki deck, each card has a **punish** button that rates it *again*
  right away.
- The normal (non-anki) quiz page gets an *anki mode* link next to the
  quiz title, the counterpart of the anki page's *normal quiz* link.

## 1.10.1 — 2026-10-03

- Fixed *next quiz* saying no quiz is overdue at the end of the list instead
  of starting over (e.g. with the first quiz you skipped): it now fetches the
  current quiz list itself when clicked.

## 1.10.0 — 2026-10-03

- **Update notice**: every 3 hours the script checks the published version,
  and the `/learn` quiz list shows a banner when a newer one is available
  (with *update*, *changelog* and *dismiss*). Never shown inside a quiz.

## 1.9 — 2026-10-03

- New **next quiz** button (key <kbd>3</kbd>) on the end-of-quiz screen. It
  works through the anki quiz list in order (second, third, fourth quiz, …),
  skipping quizzes that have no overdue cards left, and starts over from the
  current list at the end.
- The site's own "next quiz" button is now labelled **most overdue quiz**
  and moved to key <kbd>4</kbd>.

## 1.8 — 2026-10-03

- **Cards left**: while the compact popover is closed (✖), a small box shows
  how many cards are still coming in the quiz. Can be turned off in the
  settings (*show cards left*).
- The count follows each card's next appearance. It reads the interval from
  the grading button (e.g. *again (in 4 min)*), uses 5 minutes for a wrong
  answer on the map, and counts the card again once that time has passed,
  in the same run or on *practice more*.
- Debug logging of the tracked cards (with `DEBUG` on), and an
  `hqCardsDebug()` console helper.

## 1.7 — 2026-08-17

- Settings sync live to every other open helloquiz.app tab.
- Clicking the already-active ⓘ or ⚙ tab closes the compact settings popover.

## 1.6 — 2026-08-17

- **Auto-grade by speed** (off by default): a correct answer grades itself
  from how much of the countdown was left.
- Each setting has a **?** badge that explains it; tighter, clearer labels
  in the settings panel.
- The countdown bar is colored by the auto-grade zones (green, orange, red).
- The countdown only starts once a question is actually on screen.
- Fixed the grading buttons flashing up briefly before an auto-grade click.

## 1.5 — 2026-08-17

- Button on `/learn` that opens every quiz with overdue cards in its own tab.

## 1.4 — 2026-07-17 to 2026-08-06

- The hint line and hint edits always belong to the question you see, also
  during the review pause and on the grading and end-of-quiz screens:
  - the hint prompt is prefilled with, and saved to, the displayed
    question's hint;
  - hints collapsed behind *display* stay collapsed for each new question;
  - a fallback hint line where the site shows none (pause screens, grading
    screen), styled like the site's own;
  - default hints are no longer erased, and image questions are recognized
    too.
- A *normal quiz* link next to the quiz title opens the quiz outside anki mode.
- Site selectors no longer depend on the site's generated CSS class names,
  so a site rebuild doesn't break the script.
- `hqHintDebug()` console helper.

## 1.3 — 2026-07-13 to 2026-07-15

- Per-quiz timer duration (*quiz timer override*).
- Fixed spurious timer resets from clicks on the map.
- The question display is cleared once the end-of-quiz buttons show (no
  leftover question image).
- Internal cleanup and performance work (less work per page update, idle
  while the tab is hidden).

## 1.2 — 2026-07-12 to 2026-07-13

- The settings live in the site's own quiz settings panel.
- The review pause also works at the end of a quiz, and independently of
  the countdown.
- The script loads on every page, so it also activates after in-app
  navigation into anki mode.
- The <kbd>Esc</kbd> badge only shows inside anki quizzes; clearer shortcut
  hints.
- Fixed image quizzes.

## 1.1 — 2026-07-12

- Improved settings panel.

## 1.0 — 2026-07-12

- First release: per-question countdown that fails slow answers, review
  pause after mistakes, keyboard shortcuts with key badges.
- Better support for the site's "force correct click" mode.

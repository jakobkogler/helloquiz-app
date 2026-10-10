# More details

Smaller features of the HelloQuiz Anki Turbo userscript, beyond the ones in the [README](../README.md).

- **Open all due quizzes at once** — a button next to the *quizzes* heading on `/learn` opens every quiz that has overdue questions in its own tab, so a study session starts with exactly the quizzes that need work. This needs pop-ups to be allowed (see the note in the README's [Installation](../README.md#installation) section).
- **Settings popover closes on re-click** — the compact view's icon strip (ⓘ / ✖ / ⚙) normally does nothing when you click the already-active ⓘ or ⚙ tab again; this makes that click close the popover too, the same as clicking ✖.
- **Update notice** — every 3 hours the script checks the published version on GitHub, and when a newer one is out, the `/learn` quiz list shows a banner with links to *update* (your userscript manager then offers the new version), the *changelog*, and *dismiss* (hides it until an even newer version). It never shows inside a quiz.

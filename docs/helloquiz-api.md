# helloquiz.app API notes (unofficial)

Observed endpoints of helloquiz.app that the Anki Turbo userscript relies on.
These are reverse-engineered from browser dev tools, not documented by the
site — they can change without notice. All requests are same-origin and
authenticated by the normal session cookies; no extra headers are needed
beyond what the browser sends anyway.

## GET `/api/quiz/anki`

The user's anki quizzes in priority order (most overdue first). Fetched by the
site regularly, on `/learn` and while in a quiz.

```json
{
  "error": false,
  "message": [
    {
      "id": "FrG2k08jXzk5",
      "deletedAt": null,
      "title": "Bangladesh subdivisions (lvl2): districts in Bengali",
      "due": 0,
      "overdueCount": "45",
      "hasStarted": true
    }
  ]
}
```

- `overdueCount` — overdue cards, as a string.
- `due` — a timestamp in ms (the list is sorted by it); its exact meaning
  isn't pinned down.

The userscript remembers this order (as of `/learn`) for its *next quiz*
button, and uses the latest response for the current overdue counts. The
card browser uses it to tell whether a quiz is in the deck (only then can its
cards be punished).

## GET `/api/quiz/{quizId}`

The quiz's details (works for any quiz, also without logging in):

```json
{
  "error": false,
  "message": {
    "id": "nUVUMfYMZvop",
    "title": "South Africa phone codes (2 digits)",
    "description": "Can you guess South Africa's 2 digit phone codes?",
    "creator": { "displayName": "emily", "handle": "emily", "id": 1 },
    "options": { "geojson": "https://emily.bz/geojson/phone/ZA_2.json" },
    "type": 2,
    "remixOf": null
  }
}
```

The card browser takes its heading from `title`.

## GET `/api/quiz/{quizId}/question`

Every card of the quiz (no scheduling state):

```json
{
  "error": false,
  "message": [
    { "id": "fBz40iFNThz2T", "question": "45", "answer": "63", "hint": null, "customHint": null, "ownedBy": "dS9lE6vjHuOK", "options": {} }
  ]
}
```

Used by the userscript's card browser.

## GET `/api/quiz/{quizId}/anki/question`

Returns the anki (spaced-repetition) state of every question in the quiz,
including hints. Fetched by the site when a quiz is opened in learn mode.

```json
{
  "error": false,
  "message": [
    {
      "id": "WmcLqXqFgPxUI",
      "question": "Tana Tidung",
      "answer": "365",
      "questionFormat": null,
      "answerFormat": null,
      "questionType": null,
      "answerPossibilities": null,
      "questionOptions": null,
      "quizQuestionOptions": null,
      "ownedBy": "qx34YaIByIcP",
      "stability": 0.06023002,
      "difficulty": 9.59339291,
      "state": 2,
      "lastReviewed": "2026-07-14T20:51:47.072Z",
      "due": "2026-07-15T21:28:34.391Z",
      "reviews": 9,
      "lapses": 6,
      "play": "byMndtOKxP9ed  ",
      "hint": "ddd",
      "customHint": "ddd"
    }
  ]
}
```

Notable fields:

- `id` — the question id used by the other endpoints.
- `answer` — the value submitted as `guess` when answering.
- `stability` / `difficulty` / `state` / `due` / `reviews` / `lapses` — FSRS
  scheduling state.
- `play` — the current play/game id (used in the guess endpoint URL; may
  contain trailing spaces, so URL-encode it).
- `hint` / `customHint` — the shown hint; `customHint` is the user-edited
  one and takes precedence.

The userscript reads this response (via its fetch/XHR hooks) to build its
question-id → hint map, and as the batch of cards the cards-left count starts
from.

The same request is made again by *practice more* on the end-of-quiz screen.
If that returns no cards, the site follows up with
`GET /api/quiz/{quizId}/anki/question?more`, which has the same response shape
but a `message` list holding a single question.

## POST `/api/game/{playId}/question/{questionId}/guess`

Submits an answer for `questionId` together with its anki rating.

```json
{ "guess": "366", "loadId": "aJ3E6", "rating": 1 }
```

- `guess` — the chosen answer value (see `answer` above).
- `rating` — FSRS rating (1 = again … 4 = easy).
- `loadId` — an id generated when the question was loaded.

**Important side effect:** the response immediately loads the *next*
question into the app. From this moment the DOM (question label, hint line,
hint edit button) belongs to the next question, even though the review pause
still displays the answered one. The userscript therefore remembers
`questionId` from this request as "the question currently displayed".

The server accepts a guess for **any** card of the quiz, not just the one
currently loaded, with the quiz's play id (`play` from the anki question
list) and an empty `loadId` (verified 2026-10-04). The card browser's
*punish* sends `{"guess": <answer>, "loadId": "", "rating": 1}` this way.

## PUT `/api/question/{questionId}/hint`

Sets the custom hint of a question.

```json
{ "hint": "abc" }
```

Because of the preloading described above, clicking "edit" on the hint line
can target a different question than the one on screen (e.g. the preloaded
next question during the review pause). The userscript resolves the
question the user is actually looking at (by matching the displayed
question text against the question list above) and rewrites `questionId`
in this request — and the prefill of the site's hint prompt — to that
question whenever they differ.

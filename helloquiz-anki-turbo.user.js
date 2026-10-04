// ==UserScript==
// @name         HelloQuiz Anki Turbo
// @namespace    https://github.com/jakobkogler/helloquiz-app
// @version      1.12.0
// @description  Anki mode enhancements for helloquiz.app: a per-question countdown that auto-fails cards you find too slowly, optional auto-grading of correct answers by how fast they were, a review pause after mistakes (study the map, continue on click), and keyboard shortcuts with visual key hints.
// @author       Jakob Kogler
// @match        https://helloquiz.app/*
// @icon         https://www.google.com/s2/favicons?sz=64&domain=helloquiz.app
// @updateURL    https://raw.githubusercontent.com/jakobkogler/helloquiz-app/main/helloquiz-anki-turbo.user.js
// @downloadURL  https://raw.githubusercontent.com/jakobkogler/helloquiz-app/main/helloquiz-anki-turbo.user.js
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const DEBUG = false;
  // Must match @version above (a test checks); compared against the
  // published script to tell whether an update is available.
  const SCRIPT_VERSION = '1.12.0';
  const UPDATE_URL = 'https://raw.githubusercontent.com/jakobkogler/helloquiz-app/main/helloquiz-anki-turbo.user.js';
  const CHANGELOG_URL = 'https://github.com/jakobkogler/helloquiz-app/blob/main/CHANGELOG.md';
  // End-of-quiz navigation buttons: the symbol identifying each button in
  // the DOM and the keyboard shortcut bound to it. Single source of truth
  // for click detection, keyboard handling, and the kbd badges.
  const NAV_BUTTONS = [
    { key: '1', symbol: '▶' }, // practice more (continues in the same quiz)
    { key: '2', symbol: '⇋' }, // select quiz
    { key: '3', symbol: '⇥' }, // next quiz in the remembered order (our own button)
    { key: '4', symbol: '→' }, // most overdue quiz (the site's "next quiz")
  ];
  const NEXT_QUIZ_SYMBOL = '⇥';
  const MOST_OVERDUE_SYMBOL = '→';
  const NAV_SYMBOL_BY_KEY = Object.fromEntries(NAV_BUTTONS.map((b) => [b.key, b.symbol]));
  const PRACTICE_MORE_SYMBOL = NAV_BUTTONS[0].symbol;
  const STORAGE_KEY = 'helloquiz-anki-timer-settings';

  // Next.js CSS-module hashes change whenever helloquiz.app rebuilds a
  // stylesheet. Match the stable module/local class names instead of a
  // particular generated hash so routine site deployments do not silently
  // disable the timer, question mirror, or grading controls.
  const QUIZ_CONTAINER_SELECTOR = '[class*="quiz-module"][class*="__mapQuiz"]';
  const MAP_CONTAINER_SELECTOR = '[class*="map-quiz-module"][class*="__map"]';
  const QUIZ_CONTENT_SELECTOR = '[class*="quiz-module"][class*="__content"]';
  const QUIZ_TITLE_SELECTOR = '[class*="quiz-module"][class*="__titleText"]';
  const TITLE_ACTIONS_SELECTOR = '[class*="quiz-module"][class*="__remixButton"]';
  const COMPACT_SETTINGS_TABS_SELECTOR = '[class*="quiz-module"][class*="__compactSettingsTabs"]';
  const GRADING_CONTAINER_SELECTOR =
    '[class*="generic-quiz-module"][class*="__controlButtonsAnki"]';

  // ---------- Persisted settings ----------

  function loadSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* corrupted or unavailable - use defaults */ }
    return {};
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        seconds: TIMER_SECONDS,
        running: running,
        reviewPause: reviewPause,
        perQuizSeconds: perQuizSeconds,
        autoGrade: autoGrade,
        autoGradeEasy: autoGradeEasy,
        autoGradeGood: autoGradeGood,
        showCardsLeft: showCardsLeft,
      }));
    } catch (e) { /* storage unavailable - not critical */ }
  }

  const saved = loadSettings();
  let TIMER_SECONDS = typeof saved.seconds === 'number' && saved.seconds > 0 ? saved.seconds : 10;
  let running = typeof saved.running === 'boolean' ? saved.running : true;
  // When true, pause after a wrong answer/timeout so you can study the map
  // before continuing. When false, jump straight to the next question.
  let reviewPause = typeof saved.reviewPause === 'boolean' ? saved.reviewPause : true;
  // TIMER_SECONDS is the global default used everywhere. A quiz can override
  // just its own duration: perQuizSeconds maps a quiz title to its seconds.
  // Quizzes without an entry fall back to the global default.
  let perQuizSeconds = (saved.perQuizSeconds && typeof saved.perQuizSeconds === 'object') ? saved.perQuizSeconds : {};
  // Auto-grade: when a question is answered correctly in time, grade it from
  // how much of the countdown was left instead of asking. Off by default -
  // it takes the hard/good/easy decision out of the user's hands.
  let autoGrade = typeof saved.autoGrade === 'boolean' ? saved.autoGrade : false;
  // Thresholds on the leftover countdown: at or above `easy` the card is
  // graded easy, at or above `good` it's good, anything slower is hard.
  // With the default 10s timer that makes an answer within 3.4s easy, within
  // 6.7s good, and slower than that hard.
  let autoGradeEasy = percentOr(saved.autoGradeEasy, 66);
  let autoGradeGood = percentOr(saved.autoGradeGood, 33);
  // A stored pair that isn't ordered would make one of the grades
  // unreachable; fall back to the defaults rather than guess which one to fix.
  if (autoGradeGood >= autoGradeEasy) {
    autoGradeEasy = 66;
    autoGradeGood = 33;
  }

  // Show the "cards left" tab in the compact settings popover.
  let showCardsLeft = typeof saved.showCardsLeft === 'boolean' ? saved.showCardsLeft : true;

  // A stored percentage of the countdown, or the default when it's missing or
  // out of range.
  function percentOr(value, fallback) {
    return (typeof value === 'number' && value > 0 && value < 100) ? value : fallback;
  }

  // ---------- Cross-tab settings sync ----------

  // Changing a setting in one tab only writes localStorage there; every other
  // open tab is still running on the values it loaded at its own page load.
  // The browser's 'storage' event fires in those OTHER tabs (never the one
  // that wrote it) whenever the key changes, which is what keeps them in
  // sync without a reload.
  function onStorageChange(e) {
    if (e.key !== STORAGE_KEY || !e.newValue) return;
    let data;
    try {
      data = JSON.parse(e.newValue);
    } catch (err) {
      return; // corrupted write from elsewhere - ignore, keep what we have
    }

    const prevRunning = running;
    const prevReviewPause = reviewPause;
    const prevEffectiveSeconds = effectiveSeconds();

    // saveSettings() always writes the full object, so every field is
    // normally present; the type checks are only a defensive fallback to the
    // CURRENT value (not the factory default) in case a stray/older write
    // ever left one out.
    if (typeof data.seconds === 'number' && data.seconds > 0) TIMER_SECONDS = data.seconds;
    if (typeof data.running === 'boolean') running = data.running;
    if (typeof data.reviewPause === 'boolean') reviewPause = data.reviewPause;
    if (data.perQuizSeconds && typeof data.perQuizSeconds === 'object') perQuizSeconds = data.perQuizSeconds;
    if (typeof data.autoGrade === 'boolean') autoGrade = data.autoGrade;
    if (typeof data.showCardsLeft === 'boolean') showCardsLeft = data.showCardsLeft;
    autoGradeEasy = percentOr(data.autoGradeEasy, autoGradeEasy);
    autoGradeGood = percentOr(data.autoGradeGood, autoGradeGood);
    if (autoGradeGood >= autoGradeEasy) {
      autoGradeEasy = 66;
      autoGradeGood = 33;
    }

    if (DEBUG) console.log('[helloquiz-timer] settings synced from another tab');

    // The panel's own poll-driven refresh only rebuilds on a quiz change, so
    // a remote edit would otherwise sit stale on screen until then. Tear it
    // down and let the next pass rebuild it from the values just applied.
    removeSettingsPanel();
    ensureSettingsPanel();
    updateForceClickWarning();

    // If the pause was switched off remotely while this tab is sitting on an
    // overlay, continue immediately instead of leaving it stuck - same as
    // flipping the checkbox locally.
    if (!reviewPause && prevReviewPause && overlayEl && !proceedFromOverlay()) {
      hideReviewOverlay();
      pendingReview = false;
    }

    const container = findMapContainer();
    if (running !== prevRunning) {
      if (running) {
        if (container) startTimer(container);
      } else {
        clearTimer();
        timedOut = false;
        resetBarIdle();
      }
    } else if (running && effectiveSeconds() !== prevEffectiveSeconds) {
      // The duration changed under an already-ticking countdown - restart it
      // with the new duration, exactly like editing it locally does.
      if (container) startTimer(container);
    }
  }

  // ---------- State ----------

  let timerBar, timerBarWrap, timerInterval, timeoutHandle;
  let currentQuestionSig = '';
  let currentQuizTitle = '';
  let timedOut = false;
  let buttonsWerePresent = false;
  let pendingReview = true; // start paused: first question waits for a click
  let overlayEl = null;
  let navPausePending = false;      // paused before revealing end-of-quiz nav buttons
  let navButtonsWerePresent = false;
  let navPauseArmed = false;        // a fresh press began during the pause (a real continue)

  // Timer bookkeeping for pause/resume on tab switch
  let timerDeadline = 0;      // Date.now() when timer would expire
  let pausedRemaining = null; // seconds left when paused, or null if not paused
  let timerFullSeconds = TIMER_SECONDS; // full duration of the current countdown (the progress-bar denominator); may differ from the global default when the quiz overrides it
  // The leftover-time fraction for the answer that's about to earn grading
  // buttons, captured by onAnswerDetected (see there for why) and consumed by
  // watchForGradingButtons once those buttons actually appear.
  let pendingAutoGradeFraction = null;

  // Does the given quiz title have its own duration override?
  function hasQuizOverride(title) {
    return !!title && Object.prototype.hasOwnProperty.call(perQuizSeconds, title) &&
      typeof perQuizSeconds[title] === 'number' && perQuizSeconds[title] > 0;
  }

  // Seconds to use for the current quiz: its override if it has one, else the
  // global default.
  function effectiveSeconds() {
    if (hasQuizOverride(currentQuizTitle)) return perQuizSeconds[currentQuizTitle];
    return TIMER_SECONDS;
  }

  // ---------- DOM finders ----------

  function findQuizContainer() {
    return document.querySelector(QUIZ_CONTAINER_SELECTOR);
  }

  function findMapContainer() {
    return document.querySelector(MAP_CONTAINER_SELECTOR);
  }

  function findQuestionEl() {
    return document.querySelector(QUIZ_CONTENT_SELECTOR + ' h2:not(.' + MIRROR_CLASS + ')');
  }

  function findQuizTitleEl() {
    return document.querySelector(QUIZ_TITLE_SELECTOR);
  }

  // The bracketed action list next to the title ([remixes / new remix / ...])
  function findTitleActionsEl() {
    return document.querySelector(TITLE_ACTIONS_SELECTOR);
  }

  // The container holding the anki grading buttons (again/hard/good/easy)
  function findGradingContainer() {
    return document.querySelector(GRADING_CONTAINER_SELECTOR);
  }

  function findAgainButton() {
    const container = findGradingContainer();
    if (!container) return null;
    return container.querySelector('button[title="1"]');
  }

  // ---------- Timer bar ----------

  function removeTimerBar() {
    if (timerBarWrap && timerBarWrap.parentNode) {
      timerBarWrap.parentNode.removeChild(timerBarWrap);
    }
    timerBar = null;
    timerBarWrap = null;
  }

  function makeTimerBar(container) {
    // Remove any stale bar from a previous quiz's DOM first
    removeTimerBar();

    const wrap = document.createElement('div');
    wrap.className = TIMER_BAR_CLASS;
    wrap.style.cssText = `
      position: relative;
      height: 6px;
      width: 100%;
      background: #ddd;
      z-index: 999;
    `;
    const bar = document.createElement('div');
    bar.style.cssText = `
      height: 100%;
      width: 100%;
      background: orange;
      transition: width 100ms linear, background-color 200ms linear;
    `;
    wrap.appendChild(bar);
    container.parentNode.insertBefore(wrap, container);
    timerBarWrap = wrap;
    return bar;
  }

  function clearTimer() {
    clearInterval(timerInterval);
    clearTimeout(timeoutHandle);
    timerInterval = null;
    timeoutHandle = null;
    pausedRemaining = null;
    setMirrorActive(false);
  }

  function resetBarIdle() {
    if (timerBar) {
      timerBar.style.width = '100%';
      timerBar.style.background = running ? 'orange' : '#999';
    }
  }

  // The bar's color at a given percent of the countdown remaining, matching
  // the auto-grade zones (see autoGradeButtonTitle below) so the bar always
  // previews what an answer right now would earn: still green in the easy
  // zone, orange once only "good" is left, red once even that's gone.
  // Applies whether or not auto-grading is actually switched on - the zones
  // exist either way, this just makes them visible.
  function timerBarColor(remainingPct) {
    if (remainingPct >= autoGradeEasy) return '#2ecc40'; // easy
    if (remainingPct >= autoGradeGood) return 'orange';  // good
    return 'crimson';                                    // hard
  }

  function runCountdown(container, seconds) {
    // (Re)start the visual + timeout for `seconds` from now.
    clearInterval(timerInterval);
    clearTimeout(timeoutHandle);

    if (!timerBar || !document.body.contains(timerBar)) {
      timerBar = makeTimerBar(container);
    }

    timerDeadline = Date.now() + seconds * 1000;
    setMirrorActive(true);

    timerInterval = setInterval(() => {
      const remaining = Math.max(0, (timerDeadline - Date.now()) / 1000);
      const pct = timerFullSeconds > 0 ? (remaining / timerFullSeconds) * 100 : 0;
      timerBar.style.width = pct + '%';
      timerBar.style.background = timerBarColor(pct);
      if (remaining <= 0) {
        clearInterval(timerInterval);
      }
    }, 100);

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      setMirrorActive(false);
      if (timerBar) {
        timerBar.style.background = '#555';
        timerBar.style.width = '0%';
      }
    }, seconds * 1000);
  }

  // Is the user looking at a live question right now? Everything that starts a
  // countdown goes through startTimer, so this is the one place that decides
  // whether there is anything to count down for. Three ways there isn't: a
  // pause is in progress (review pause, or the "Click to start" screen), the
  // mirror is showing a status message instead of a question, or the quiz
  // hasn't rendered a question at all yet.
  // (A pause always has pendingReview set, so that flag alone covers it -
  // checking overlayEl too would only add a way to block a legitimate start
  // if the marker ever outlives the pause by a pass.)
  function questionIsLive() {
    if (pendingReview) return false;
    if (mirrorIsStatus) return false;
    return hasQuestionOnScreen();
  }

  function startTimer(container) {
    // Guarded centrally rather than per caller: besides a question appearing,
    // the settings panel starts timers too (ticking "timer countdown",
    // changing a duration), and neither should do anything while the question
    // is still hidden behind a pause.
    if (!questionIsLive()) {
      if (DEBUG) console.log('[helloquiz-timer] startTimer ignored: no question on screen');
      return;
    }
    if (DEBUG) console.log('[helloquiz-timer] startTimer called, running =', running, 'seconds =', effectiveSeconds());
    clearTimer();
    timedOut = false;

    if (!timerBar || !document.body.contains(timerBar)) {
      timerBar = makeTimerBar(container);
    }

    if (!running) {
      // No countdown, but the question is now active — highlight it the same
      // way the timer does, so pause mode looks identical to timing mode.
      resetBarIdle();
      setMirrorActive(true);
      return;
    }

    timerBar.style.width = '100%';
    timerBar.style.background = timerBarColor(100);
    timerFullSeconds = effectiveSeconds();
    runCountdown(container, timerFullSeconds);
  }

  // ---------- Pause/resume on tab switch or window blur ----------

  function pauseTimer() {
    // Only pause if a countdown is actually active
    if (!timerInterval && !timeoutHandle) return;
    const remaining = (timerDeadline - Date.now()) / 1000;
    if (remaining > 0 && !timedOut) {
      pausedRemaining = remaining;
      clearInterval(timerInterval);
      clearTimeout(timeoutHandle);
      timerInterval = null;
      timeoutHandle = null;
      setMirrorActive(false);
      if (DEBUG) console.log('[helloquiz-timer] paused with', remaining.toFixed(1), 's remaining');
    }
  }

  function resumeTimer() {
    if (pausedRemaining === null || !running || overlayEl) return;
    const container = findMapContainer();
    if (container) {
      if (DEBUG) console.log('[helloquiz-timer] resuming with', pausedRemaining.toFixed(1), 's remaining');
      runCountdown(container, pausedRemaining);
    }
    pausedRemaining = null;
  }

  function onVisibilityChange() {
    if (document.hidden) {
      pauseTimer();
    } else {
      // Both the poll and the mutation observer idle while the tab is
      // hidden - run one pass right away so nothing stays stale until the
      // next tick.
      pollPass();
      resumeTimer();
    }
  }

  function onWindowBlur() {
    // Fires when the window loses focus (e.g. alt-tab to another app),
    // which visibilitychange alone does NOT catch if the browser window
    // stays visible on screen.
    pauseTimer();
  }

  function onWindowFocus() {
    resumeTimer();
  }

  // ---------- Question hiding (CSS-based, flash-free) ----------

  // A class on <html> + stylesheet rule hides the question content. The
  // class is applied at document-start, BEFORE the page renders anything,
  // so the question is never visible even on a fresh page load. Using
  // <html> instead of <body> because <body> doesn't exist yet at
  // document-start.

  const HIDE_CLASS = 'hq-timer-hide-question';
  const MIRROR_CLASS = 'hq-timer-mirror';
  const KBD_CLASS = 'hq-timer-kbd'; // must be declared before installHideStyle() runs at document-start
  const BROWSE_HTML_CLASS = 'hq-browse-page'; // on <html> while the card browser is shown; declared before installHideStyle() runs
  const NAVSYM_CLASS = 'hq-timer-navsym'; // wraps the ▶/⇋/→ glyph so we can hide it via CSS
  const NAV_HIDE_CLASS = 'hq-nav-hide';   // hides end-of-quiz nav buttons during the pause
  const TIMER_BAR_CLASS = 'hq-timer-bar'; // marks the injected timer bar (for the mutation filter)
  const HINT_DISPLAY_CLASS = 'hq-hint-display'; // our own "display" toggle in the hint line
  const HINT_HIDE_CLASS = 'hq-hint-hide';   // on <html> while no question is displayed (status message)
  const HINT_LINE_CLASS = 'hq-hint-line';   // our fallback hint line on the end-of-quiz pause screen
  const HINT_EDIT_CLASS = 'hq-hint-edit';   // the "edit" action in our fallback hint line
  const QUIZ_LINK_CLASS = 'hq-quiz-link';   // our link to the normal quiz in the title's action list
  const OPEN_DUE_CLASS = 'hq-open-due';     // our "open due quizzes" button above the /learn list
  const OPEN_DUE_HELP_CLASS = 'hq-open-due-help'; // that button's help badge + text
  const TOAST_CLASS = 'hq-toast';           // transient status banner (e.g. popup blocker warning)
  const HELP_CLASS = 'hq-help';             // the "?" badge next to a control
  const HELP_TEXT_CLASS = 'hq-help-text';   // the explanation it toggles
  const HELP_OPEN_CLASS = 'hq-help-open';   // on both while the explanation is shown
  const NUM_CLASS = 'hq-num';               // the small seconds / percentage boxes
  const MIRROR_ACTIVE_CLASS = 'hq-timer-mirror-active';
  let mirrorActive = false;

  function setMirrorActive(active) {
    mirrorActive = active;
    const mirror = document.querySelector('h2.' + MIRROR_CLASS);
    if (mirror) mirror.classList.toggle(MIRROR_ACTIVE_CLASS, active);
    else ensureMirror();
  }

  // The real question <h2> stays hidden at ALL times on anki pages (via
  // the CSS rule below). We render our own mirror <h2> in the same
  // position and fully control its text. This way, after a wrong answer
  // the mirror can keep showing the OLD question (the one that was
  // answered) while the site's real label already contains the next one.
  let mirrorText = 'Click to start';
  // Some quizzes ask about a picture: the question <h2> holds an <img> and has
  // no text. When that's the case we mirror the rendered markup instead of a
  // string; mirrorHTML is null for ordinary text questions.
  let mirrorHTML = null;

  function findContentElForMirror() {
    return document.querySelector(QUIZ_CONTENT_SELECTOR);
  }

  // A question is an image question when its <h2> contains an <img>.
  function questionHasImage(qEl) {
    return !!(qEl && qEl.querySelector('img'));
  }

  // Stable key for "has the question changed?". Image questions have empty
  // textContent, so two different ones look identical by text alone — fall
  // back to the image URL so the change is still detected.
  function questionSignature(qEl) {
    if (!qEl) return '';
    const img = qEl.querySelector('img');
    if (img) return 'img:' + (img.getAttribute('src') || '');
    return 'txt:' + qEl.textContent;
  }

  // Snapshot the current question into the mirror's state. We snapshot (rather
  // than reference the live node) so the mirror can keep showing the answered
  // question during a review pause while the site swaps in the next one.
  // Is the mirror showing a status message ("Click to start") rather than
  // an actual question? While true, no question is displayed at all.
  let mirrorIsStatus = true;

  function captureQuestionToMirror(qEl) {
    if (questionHasImage(qEl)) {
      mirrorHTML = qEl.innerHTML;
    } else {
      mirrorHTML = null;
      mirrorText = qEl.textContent;
    }
    mirrorIsStatus = false;
  }

  // Show a plain-text status in the mirror (e.g. "Click to start"), clearing
  // any image markup left over from a previous image question.
  function setMirrorMessage(text) {
    mirrorText = text;
    mirrorHTML = null;
    mirrorIsStatus = true;
  }

  // Replace whatever question the mirror shows with a plain status message
  // (or nothing), drop the active highlight, and render immediately.
  function resetMirror(text) {
    setMirrorMessage(text);
    setMirrorActive(false);
    ensureMirror();
  }

  function ensureMirror() {
    const contentEl = findContentElForMirror();
    if (!contentEl) return;
    let mirror = contentEl.querySelector('h2.' + MIRROR_CLASS);
    if (!mirror) {
      mirror = document.createElement('h2');
      mirror.className = MIRROR_CLASS;
      const realH2 = contentEl.querySelector('h2:not(.' + MIRROR_CLASS + ')');
      if (realH2) contentEl.insertBefore(mirror, realH2);
      else contentEl.insertBefore(mirror, contentEl.firstChild);
    }
    if (mirrorHTML !== null) {
      if (mirror.innerHTML !== mirrorHTML) mirror.innerHTML = mirrorHTML;
    } else if (mirror.textContent !== mirrorText || mirror.firstElementChild) {
      // The firstElementChild check catches leftover markup from an image
      // question: its textContent is '' just like an empty message, so the
      // text comparison alone would leave the <img> in place.
      mirror.textContent = mirrorText;
    }
    mirror.classList.toggle(MIRROR_ACTIVE_CLASS, mirrorActive);
  }

  function removeMirror() {
    document.querySelectorAll('h2.' + MIRROR_CLASS).forEach((el) => el.remove());
  }

  // React re-renders can destroy or replace our mirror element; the 200ms
  // poll is too slow to restore it without a visible flash. A
  // MutationObserver callback runs as a microtask BEFORE the browser
  // paints, so restoring the mirror here means text and highlight always
  // appear together, never a partially-styled frame.
  let mirrorObserver = null;
  let observerBusy = false;

  // Is this node one of the elements the script injected itself (or inside
  // one)? Mutations confined to those are just our own DOM writes echoing
  // back through the observer - the watchers have nothing to react to.
  function isOwnNode(node) {
    if (node === hideStyleEl) return true;
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el) return false;
    return !!el.closest(
      '.' + MIRROR_CLASS +
      ', kbd.' + KBD_CLASS +
      ', span.' + NAVSYM_CLASS +
      ', span.' + HINT_DISPLAY_CLASS +
      ', p.' + HINT_LINE_CLASS +
      ', .' + TIMER_BAR_CLASS +
      ', .' + SETTINGS_BLOCK_CLASS +
      ', button.' + OPEN_DUE_CLASS +
      ', .' + HELP_CLASS +
      ', .' + HELP_TEXT_CLASS +
      ', .' + TOAST_CLASS +
      ', .hq-nav-msg'
    );
  }

  function isRelevantMutation(record) {
    if (isOwnNode(record.target)) return false;
    if (record.type === 'childList') {
      // Inserting/removing our own elements registers on their (site-owned)
      // parent; the record is still ours if every changed node is ours.
      for (const n of record.addedNodes) if (!isOwnNode(n)) return true;
      for (const n of record.removedNodes) if (!isOwnNode(n)) return true;
      return false;
    }
    return true;
  }

  function installMirrorObserver() {
    if (mirrorObserver) return;
    mirrorObserver = new MutationObserver((records) => {
      if (!scriptActive || observerBusy) return;
      invalidateNavScan(); // the DOM changed - any cached nav scan is stale
      // Hidden tab: no paint is imminent, so pre-paint work is pointless
      // (and background churn is wasted CPU). The refocus pass in
      // onVisibilityChange catches up when the tab comes back.
      if (document.hidden) return;
      // Skip the pass entirely when the mutations are only our own writes.
      if (!records.some(isRelevantMutation)) return;
      observerBusy = true; // our own DOM writes below also trigger mutations
      try {
        ensureMirror();
        ensureListKbdHints();
        ensureOpenDueButton();
        ensureNavKbdHints();
        ensureSettingsPanel();
        ensureCardsPopover();
        updateForceClickWarning();
        // Also detect quiz/question changes right here (pre-paint) instead
        // of waiting for the 200ms poll: when a grading button swaps in
        // the next question, the mirror updates in the same frame. This is
        // also what keeps a correct answer's auto-grade click invisible -
        // watchForGradingButtons reacting only on the 200ms poll left the
        // real grading buttons on screen for up to 200ms before the
        // programmatic click, which is long enough to see as a flash.
        watchForQuizChange();
        watchForNewQuestion();
        watchForGradingButtons();
        watchForNavButtons();
        // After the watchers: the hint sync learns from / enforces against
        // the mirror, which the watchers above may just have updated.
        watchDisplayedQuestion();
        ensureHintMirror();
        ensureFallbackHintLine();
      } finally {
        observerBusy = false;
      }
    });
    mirrorObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function setMirrorToCurrentQuestion() {
    const qEl = findQuestionEl();
    if (qEl) captureQuestionToMirror(qEl);
    ensureMirror();
  }

  let hideStyleEl = null;

  function installHideStyle() {
    const style = document.createElement('style');
    style.textContent = `
      html.${HIDE_CLASS} ${QUIZ_CONTENT_SELECTOR} h2:not(.${MIRROR_CLASS}) {
        display: none !important;
      }
      h2.${MIRROR_CLASS} {
        padding: 2px 10px;
        border-radius: 6px;
        outline: 2px solid transparent;
        transition: none !important;
      }
      kbd.${KBD_CLASS} {
        display: inline-block;
        min-width: 1.2em;
        margin-right: 6px;
        padding: 1px 5px;
        border: 1px solid currentColor;
        border-radius: 4px;
        font-family: ui-monospace, monospace;
        font-size: 0.85em;
        line-height: 1.3;
        text-align: center;
        opacity: 0.75;
      }
      /* Menu variant: keep "anki mode" on one line with a compact badge */
      menu a[href="/learn"] {
        white-space: nowrap;
      }
      menu a[href="/learn"] kbd.${KBD_CLASS} {
        min-width: 0;
        margin-right: 4px;
        padding: 0 3px;
        font-size: 0.7em;
      }
      h2.${MIRROR_CLASS}.${MIRROR_ACTIVE_CLASS} {
        background: rgba(255, 165, 0, 0.22);
        outline-color: rgba(255, 165, 0, 0.55);
      }
      /* End-of-quiz nav buttons: show the full text label (which the site
         collapses to just a glyph on the map view) and hide the bare
         ▶/⇋/⇥/→ symbol, so they read "practice more" / "select quiz" /
         "next quiz" / "most overdue quiz". */
      [class*="controlButtonsAnki"] button [class*="expanded"] {
        display: inline !important;
      }
      span.${NAVSYM_CLASS} {
        display: none !important;
      }
      /* Hide the end-of-quiz nav buttons while the after-a-wrong-last-answer
         pause is active (kept in layout via visibility so revealing them
         doesn't shift anything). */
      html.${NAV_HIDE_CLASS} [class*="controlButtonsAnki"] {
        visibility: hidden !important;
      }
      /* Our own hint "display" toggle; the site styles the hint line's
         spans via descendant selectors, so it mostly inherits that look. */
      span.${HINT_DISPLAY_CLASS} {
        cursor: pointer;
        margin-right: 4px;
      }
      /* While the mirror shows a status message ("Click to start") instead
         of a question, the site's hint line belongs to the still-hidden
         question - hide it entirely. */
      html.${HINT_HIDE_CLASS} [class*="scoreAndHint"] {
        display: none !important;
      }
      /* Our fallback hint line borrows the site's own hint class for its
         look when one has been observed. These defaults cover entry points
         where the site has not rendered a hint line yet. */
      p.${HINT_LINE_CLASS} {
        margin: 0;
      }
      p.${HINT_LINE_CLASS} span {
        cursor: pointer;
      }
      /* The "open due quizzes" button next to the /learn list's heading.
         Borrows the key badge's look (transparent, currentColor border) so it
         fits whichever theme the site is rendered in. Sitting inside an <h2>,
         it has to opt out of the heading's own typography - hence the
         absolute font size and the explicit weight/transform resets. */
      button.${OPEN_DUE_CLASS} {
        display: inline-flex;
        align-items: center;
        vertical-align: middle;
        margin: 0 0 0 12px;
        padding: 4px 10px;
        border: 1px solid currentColor;
        border-radius: 6px;
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 0.9rem;
        font-weight: normal;
        text-transform: none;
        letter-spacing: normal;
        cursor: pointer;
        opacity: 0.8;
      }
      button.${OPEN_DUE_CLASS}:hover:not(:disabled) {
        opacity: 1;
      }
      button.${OPEN_DUE_CLASS}:disabled {
        opacity: 0.4;
        cursor: default;
      }
      /* A "?" badge that toggles a short explanation, used by the config rows
         and the button above. Click rather than hover: an explanation that
         pops up while the pointer only passes over a row is more distracting
         than helpful. The text sits in the normal flow underneath its row
         rather than floating, so nothing can clip it inside the site's
         settings panel. Both elements are spans (they live inside <p>s and
         <h2>s, where a <div> would not be valid). */
      span.${HELP_CLASS} {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        vertical-align: middle;
        width: 1.2em;
        height: 1.2em;
        margin-left: 6px;
        border: 1px solid currentColor;
        border-radius: 50%;
        font-family: system-ui, sans-serif;
        font-size: 0.75rem;
        font-weight: normal;
        line-height: 1;
        text-transform: none;
        letter-spacing: normal;
        cursor: pointer;
        opacity: 0.55;
        user-select: none;
      }
      span.${HELP_CLASS}:hover,
      span.${HELP_CLASS}.${HELP_OPEN_CLASS} {
        opacity: 1;
      }
      span.${HELP_TEXT_CLASS} {
        display: none;
        margin: 4px 0 2px;
        padding: 5px 8px;
        border-left: 2px solid currentColor;
        border-radius: 0 4px 4px 0;
        /* Grey works out as a slight lightening or darkening of whatever the
           site's own background is, so this needs no theme handling. */
        background: rgba(127, 127, 127, 0.15);
        font-family: system-ui, sans-serif;
        font-size: 0.8rem;
        font-weight: normal;
        line-height: 1.4;
        text-align: left;
        text-transform: none;
        letter-spacing: normal;
        opacity: 0.85;
      }
      span.${HELP_TEXT_CLASS}.${HELP_OPEN_CLASS} {
        display: block;
      }
      /* The seconds/percentage boxes. The browser's spin-button arrows eat
         into the box's content width without shrinking themselves, so a
         narrow width clips the digits behind them well before the box looks
         full - dropping the arrows is what actually lets these go this
         small. text-align keeps a 1-2 digit value from looking lost in the
         box, and MozAppearance is Firefox's equivalent of the WebKit rule. */
      input.${NUM_CLASS} {
        width: 2.3em;
        padding: 1px 2px;
        text-align: center;
        -moz-appearance: textfield;
      }
      input.${NUM_CLASS}::-webkit-outer-spin-button,
      input.${NUM_CLASS}::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      /* The card browser (/quiz/<id>/browse) replaces the site's 404, whose
         own inline style forces a white page; keep the site's colors. */
      html.${BROWSE_HTML_CLASS} body {
        background: var(--bg, #f0f0ff) !important;
        color: var(--text, #222) !important;
      }
      .hq-browse {
        max-width: var(--max-width, 1200px);
        margin: 20px auto 40px;
        padding: 0 16px;
      }
      .hq-browse h1 { margin: 0 0 4px; font-size: 24px; }
      .hq-browse .hq-browse-search {
        width: 100%;
        max-width: 420px;
        font-size: 16px;
        padding: 6px 10px;
        border: 1px solid var(--hl, #95f);
        border-radius: 8px;
        background: var(--bg, #fff);
        color: var(--text, #222);
      }
      .hq-browse .hq-browse-count { margin-left: 8px; opacity: 0.7; }
      .hq-browse .hq-browse-explain { max-width: 900px; margin: 8px 0 14px; opacity: 0.85; line-height: 1.4; }
      .hq-browse .hq-browse-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
        gap: 0 24px;
        margin-top: 8px;
      }
      .hq-browse .hq-browse-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 4px 8px;
        border-bottom: 1px solid var(--bg-minishade, #e0e0ff);
      }
      .hq-browse .hq-browse-question { min-width: 0; overflow-wrap: anywhere; }
      .hq-browse .hq-browse-action { flex: none; text-align: right; }
      .hq-browse button {
        border: 1px solid var(--hl, #95f);
        border-radius: 6px;
        background: transparent;
        color: var(--text, #222);
        padding: 2px 10px;
        cursor: pointer;
      }
      .hq-browse button:disabled { opacity: 0.6; cursor: default; }
      .hq-browse img.hq-browse-image {
        display: block;
        max-width: 160px;
        max-height: 64px;
        border-radius: 4px;
      }
      .hq-browse .hq-browse-error { color: var(--warning-shade, #c33); }
    `;
    // Prefer <head> when it exists (more stable across hydration);
    // fall back to <html> at document-start when head isn't there yet.
    (document.head || document.documentElement).appendChild(style);
    hideStyleEl = style;
  }

  function ensureHideStyle() {
    // React hydration can discard nodes it doesn't know about, removing
    // our stylesheet - which un-hides the real question label so both
    // labels show. Reinstall whenever it's gone.
    if (!hideStyleEl || !hideStyleEl.isConnected) {
      if (hideStyleEl && hideStyleEl.parentNode) {
        hideStyleEl.parentNode.removeChild(hideStyleEl);
      }
      installHideStyle();
      if (DEBUG) console.log('[helloquiz-timer] reinstalled hide stylesheet');
    }
  }

  function hideQuestion() {
    document.documentElement.classList.add(HIDE_CLASS);
  }

  function showQuestion() {
    document.documentElement.classList.remove(HIDE_CLASS);
  }

  // ---------- Anki-page detection ----------

  // The script loads on the whole site (@match https://helloquiz.app/*) so
  // that SPA navigation INTO an anki page (e.g. from the landing page) is
  // caught even when the first page load wasn't an anki page. Every feature
  // therefore checks at runtime whether we're actually on an anki page.

  function isAnkiPage() {
    if (location.pathname === '/learn') return true;
    if (location.pathname.startsWith('/quiz/') && new URLSearchParams(location.search).has('learn')) return true;
    return false;
  }

  // Apply immediately at document-start, before first render
  installHideStyle();
  if (isAnkiPage()) {
    hideQuestion();
  }

  // ---------- Review pause (after wrong answer) ----------

  function markPendingReview(reason) {
    pendingReview = true;
    // The real question label is permanently hidden on anki pages; the
    // mirror label simply won't be updated while a review is pending, so
    // it keeps showing the question that was answered.
    if (DEBUG) console.log('[helloquiz-timer] pending review (' + reason + '), will pause before next timer start');
  }

  function showReviewOverlay(container) {
    hideReviewOverlay();
    if (!container) return;

    // No visible button: continuing happens by clicking the map or
    // pressing 1 (the mirror label says "Click to start" at quiz start,
    // and after mistakes the frozen old question signals the pause).
    // A detached marker element preserves the overlayEl truthiness
    // contract that all the handlers rely on.
    overlayEl = document.createElement('span');

    if (DEBUG) console.log('[helloquiz-timer] review pause active, timer paused');
  }

  function hideReviewOverlay() {
    if (overlayEl && overlayEl.parentNode) {
      overlayEl.parentNode.removeChild(overlayEl);
    }
    overlayEl = null;
  }

  // Is there a question on screen to reveal? The <h2> can be missing entirely
  // (or sit there empty) while the quiz is still loading its first question.
  function hasQuestionOnScreen() {
    const qEl = findQuestionEl();
    if (!qEl) return false;
    return !!qEl.textContent.trim() || questionHasImage(qEl);
  }

  // Continue from a pause: reveal the question and start its countdown.
  // Returns false when there is nothing to continue to - a click arriving
  // before the quiz has rendered its first question must not start a
  // countdown on a screen that still says "Click to start".
  function proceedFromOverlay() {
    const wasNavPause = navPausePending;
    // The end-of-quiz pause has no question by definition; it's the buttons
    // that are waiting to be revealed there.
    if (!wasNavPause && !hasQuestionOnScreen()) {
      if (DEBUG) console.log('[helloquiz-timer] continue ignored: no question on screen yet');
      return false;
    }
    hideReviewOverlay();
    pendingReview = false;
    if (wasNavPause) {
      // End-of-quiz pause: reveal the nav buttons. The last question is no
      // longer relevant on this screen, so stop mirroring it.
      endNavPause();
      resetMirror('');
      return true;
    }
    setMirrorToCurrentQuestion();
    const container = findMapContainer();
    if (container) startTimer(container);
    return true;
  }

  // ---------- Pause before the end-of-quiz buttons (wrong last answer) ----------

  // When the last question of a quiz is answered wrong while pause mode is on,
  // the site jumps straight to the nav buttons (practice more / select / next
  // quiz) with no next question for the normal pause to attach to. Hide those
  // buttons and wait for a click first, so the final mistake gets a review
  // pause too. Continuing reuses the same map-tap / key-1 / click machinery.

  // Nav-button lookup used to run its own full-document [class*=...] query
  // on every call - up to ~9 scans in a single watcher pass, since several
  // watchers each look up several symbols. Instead, do ONE scan per DOM
  // generation and let every lookup share it. The generation counter is
  // bumped whenever the DOM may have changed (each observer callback, each
  // poll tick, and defensively in the key handlers).
  let navScanGen = 0;
  let navScanCache = null; // { gen, bySymbol }

  function invalidateNavScan() {
    navScanGen++;
  }

  function scanNavButtons() {
    if (navScanCache && navScanCache.gen === navScanGen) return navScanCache.bySymbol;
    const bySymbol = {};
    const spans = document.querySelectorAll('span[class*="generic-quiz-module"][class*="expanded"]');
    for (const span of spans) {
      const button = span.closest('button');
      if (!button) continue;
      const text = button.textContent;
      for (const { symbol } of NAV_BUTTONS) {
        if (!bySymbol[symbol] && text.includes(symbol)) bySymbol[symbol] = button;
      }
    }
    navScanCache = { gen: navScanGen, bySymbol };
    return bySymbol;
  }

  function anyNavButtonPresent() {
    const bySymbol = scanNavButtons();
    return NAV_BUTTONS.some(({ symbol }) => bySymbol[symbol]);
  }

  // Shared look of the small fixed banners at the top of the screen (the
  // review-pause hint and the transient toasts).
  const BANNER_CSS = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100001;
    background: rgba(30, 30, 30, 0.9);
    color: #fff;
    font-family: system-ui, sans-serif;
    font-size: 14px;
    padding: 8px 14px;
    border-radius: 8px;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
    user-select: none;
  `;

  function showNavPauseMessage() {
    if (document.querySelector('.hq-nav-msg')) return;
    const msg = document.createElement('div');
    msg.className = 'hq-nav-msg';
    msg.textContent = 'Review the map, then click to continue';
    msg.style.cssText = BANNER_CSS + 'cursor: pointer;';
    document.body.appendChild(msg);
  }

  function removeNavPauseMessage() {
    document.querySelectorAll('.hq-nav-msg').forEach((el) => el.remove());
  }

  // A banner that disappears on its own, for one-off feedback that has no
  // place in the page itself (currently only the popup-blocker warning).
  let toastTimer = null;

  function showToast(text) {
    removeToast();
    const el = document.createElement('div');
    el.className = TOAST_CLASS;
    el.textContent = text;
    el.style.cssText = BANNER_CSS;
    document.body.appendChild(el);
    toastTimer = setTimeout(removeToast, 8000);
  }

  function removeToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = null;
    }
    document.querySelectorAll('.' + TOAST_CLASS).forEach((el) => el.remove());
  }

  // A "?" badge plus the explanation it shows and hides. Returned as a pair
  // so the caller decides where each one goes; the text is a block, so it
  // lands under the row the badge sits in.
  function makeHelp(text) {
    const badge = document.createElement('span');
    badge.className = HELP_CLASS;
    badge.textContent = '?';

    const body = document.createElement('span');
    body.className = HELP_TEXT_CLASS;
    body.textContent = text;

    badge.addEventListener('click', (e) => {
      // The badge sits inside the site's own settings popover; don't let the
      // click travel on to whatever handlers that has.
      e.preventDefault();
      e.stopPropagation();
      const open = !body.classList.contains(HELP_OPEN_CLASS);
      body.classList.toggle(HELP_OPEN_CLASS, open);
      badge.classList.toggle(HELP_OPEN_CLASS, open);
    });

    return { badge, body };
  }

  // The common case: badge at the end of the controls, explanation below them
  // (it's a block, so it stacks under the row).
  function appendHelp(row, text) {
    const { badge, body } = makeHelp(text);
    row.appendChild(badge);
    row.appendChild(body);
  }

  function startNavPause() {
    navPausePending = true;
    navPauseArmed = false;
    document.documentElement.classList.add(NAV_HIDE_CLASS);
    // Reuse the overlay marker so the map-tap / key-1 continue handlers fire.
    overlayEl = document.createElement('span');
    showNavPauseMessage();
    if (DEBUG) console.log('[helloquiz-timer] nav pause: hiding end-of-quiz buttons until click');
  }

  function endNavPause() {
    navPausePending = false;
    navPauseArmed = false;
    document.documentElement.classList.remove(NAV_HIDE_CLASS);
    removeNavPauseMessage();
  }

  // A press that BEGINS during the pause is a genuine continue gesture. The
  // tap that answered the last question started before the pause, so it never
  // arms — which is how we ignore its trailing click without any timers.
  function onNavPausePointerDown() {
    if (navPausePending) navPauseArmed = true;
  }

  // The first armed click ANYWHERE reveals the buttons. Registered before the
  // other click handlers and swallowed so it doesn't also activate whatever is
  // underneath. Covers the case where the end-of-quiz screen has no map to tap.
  function onNavPauseClick(e) {
    if (!scriptActive || !navPausePending || !navPauseArmed) return;
    // Clicks on the hint line (display toggle / edit) are interactions with
    // the hint, not a continue gesture - leave them to onHintDisplayClick.
    // Same for anything in the settings panel.
    if (e.target && e.target.closest &&
        e.target.closest('p.' + HINT_LINE_CLASS + ', [class*="scoreAndHint"]')) {
      return;
    }
    if (isSettingsTarget(e.target)) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    if (DEBUG) console.log('[helloquiz-timer] nav pause: click -> reveal buttons');
    proceedFromOverlay();
  }

  function watchForNavButtons() {
    const present = anyNavButtonPresent();
    if (present) {
      if (!navButtonsWerePresent) {
        if (reviewPause && pendingReview) {
          startNavPause();
        } else {
          // Buttons are visible straight away (no review pause needed,
          // e.g. the last answer was correct) - the last question is no
          // longer relevant on this screen, so stop mirroring it.
          resetMirror('');
        }
      }
      // Keep the pause enforced across React re-renders.
      if (navPausePending) {
        document.documentElement.classList.add(NAV_HIDE_CLASS);
        showNavPauseMessage();
      }
    } else if (navPausePending) {
      // Buttons vanished before continuing (e.g. quiz changed) — clean up.
      hideReviewOverlay();
      endNavPause();
    }
    navButtonsWerePresent = present;
  }

  // ---------- Map interaction during review ----------

  // While the review button is up, the map stays interactive. A plain
  // click (tap) on the map acts as "continue": it's swallowed so the site
  // can't register it as an answer to the still-hidden question, and then
  // proceeds to reveal the question and start the timer. A click-hold-move
  // (drag) pans the map normally without continuing.

  const TAP_THRESHOLD_PX = 5;
  let reviewPointerDown = null;
  let suppressMapClicksUntil = 0;

  // The settings panel is rendered inside the map container, so a click on one
  // of its controls looks exactly like a tap on the map. Changing a setting is
  // not a "continue" gesture, so those clicks are left alone. The selector is
  // deliberately loose: everything the site's settings module renders (panel
  // and the button that opens it) shares that class prefix.
  function isSettingsTarget(target) {
    return !!(target && target.closest &&
      target.closest('[class*="anki-settings"], .' + SETTINGS_BLOCK_CLASS));
  }

  function onReviewPointerDown(e) {
    if (!overlayEl) return;
    const container = findMapContainer();
    if (container && container.contains(e.target) && !isSettingsTarget(e.target)) {
      reviewPointerDown = { x: e.clientX, y: e.clientY };
    } else {
      reviewPointerDown = null;
    }
  }

  function onReviewPointerUp(e) {
    if (!overlayEl || !reviewPointerDown) return;
    const dx = e.clientX - reviewPointerDown.x;
    const dy = e.clientY - reviewPointerDown.y;
    reviewPointerDown = null;

    const isTap = dx * dx + dy * dy <= TAP_THRESHOLD_PX * TAP_THRESHOLD_PX;
    if (!isTap) return; // drag: let the map pan freely

    // Swallow the tap so deck.gl never sees the release, and suppress the
    // trailing click event the browser will still fire.
    e.stopPropagation();
    e.preventDefault();
    suppressMapClicksUntil = Date.now() + 350;

    // Swallowing the pointerup leaves the gesture recognizer thinking the
    // pointer is still down (sticky drag mode). A synthetic pointercancel
    // tells it to cleanly abort the interaction: no tap, no stuck drag.
    try {
      const cancel = new PointerEvent('pointercancel', {
        bubbles: true,
        cancelable: false,
        pointerId: e.pointerId,
        pointerType: e.pointerType,
        isPrimary: e.isPrimary,
        clientX: e.clientX,
        clientY: e.clientY,
      });
      e.target.dispatchEvent(cancel);
    } catch (err) {
      /* best effort - proceed regardless */
    }

    if (DEBUG) console.log('[helloquiz-timer] map tap during review -> continue');
    proceedFromOverlay();
  }

  function onReviewMapClickBlock(e) {
    // Block plain clicks inside the map while reviewing, and briefly after
    // a tap-to-continue (the browser fires the click AFTER our pointerup
    // handler has already removed the overlay).
    if (!overlayEl && Date.now() >= suppressMapClicksUntil) return;
    if (isSettingsTarget(e.target)) return; // the panel sits inside the map
    const container = findMapContainer();
    if (container && container.contains(e.target)) {
      e.stopPropagation();
      e.preventDefault();
      if (DEBUG) console.log('[helloquiz-timer] blocked map click during review');
    }
  }

  // ---------- Console hook (detect correct/incorrect) ----------

  function onAnswerDetected(args) {
    if (!scriptActive) return;
    if (!isAnkiPage()) return;
    // The site logs: console.log(0, 'correct') or console.log(0, 'incorrect')
    // Only check string args — skip objects to avoid expensive serialization
    for (let i = 0; i < args.length; i++) {
      if (typeof args[i] !== 'string') continue;
      const s = args[i].toLowerCase();
      if (s === 'incorrect') {
        clearTimer();
        markPendingReview('incorrect answer');
        return;
      }
      if (s === 'correct') {
        if (DEBUG) console.debug('[helloquiz-timer] correct answer detected');
        // The clock has to be read here, before clearTimer() throws the
        // countdown away: this console message fires the instant the site
        // registers the answer, which is BEFORE it renders the grading
        // buttons into the DOM. By the time watchForGradingButtons notices
        // those buttons, the timer state used to already be gone.
        pendingAutoGradeFraction = remainingFraction();
        clearTimer();
        // "Force correct click" mode keeps you on the same card after a
        // wrong click (logging "incorrect", which set pendingReview) and
        // finally logs "correct" once you click the right answer — without
        // ever showing grading buttons. Clicking the correct answer already
        // served as the review, so clear pendingReview to let the next card
        // start immediately instead of forcing a redundant continue-click.
        // (For a timeout, watchForGradingButtons re-sets pendingReview
        // afterwards, so that pause is unaffected.)
        pendingReview = false;
        return;
      }
    }
  }

  function installConsoleHook() {
    ['log', 'warn', 'info', 'debug'].forEach((method) => {
      const original = console[method].bind(console);
      console[method] = function (...args) {
        original(...args);
        try {
          onAnswerDetected(args);
        } catch (err) {
          /* swallow - never let our hook break the page's own logging */
        }
      };
    });
  }

  // ---------- Hint tracking (displayed vs. preloaded question) ----------

  // The site preloads the next question the moment a guess is submitted:
  // during our review pause, the real (hidden) question label, the hint
  // line, and its "edit" button all already belong to the NEXT question
  // while the user still sees the answered one. To make the hint line and
  // hint editing refer to the DISPLAYED question instead, we
  //  - remember every question's id and hint from the quiz's anki
  //    question-list response (GET /api/quiz/<id>/anki/question),
  //  - remember which question was just answered from the guess request
  //    (POST /api/game/<play>/question/<id>/guess),
  //  - while a review is pending, overwrite the hint line's text with the
  //    answered question's hint (ensureHintMirror) and rewrite the target
  //    id of hint edits (PUT /api/question/<id>/hint) to the answered
  //    question. See docs/helloquiz-api.md for the endpoints.

  // ---------- Cards left ----------

  // How many cards are still coming in this quiz session, tracked per card:
  //  - the batch: cards of the latest anki question-list response (opening
  //    the quiz, "practice more", or the single card of the follow-up ?more
  //    request) that haven't been answered yet,
  //  - plus every answered card whose next appearance has already come -
  //    each answer schedules its card at now + the interval the grading
  //    button promised ("again (in 4 min)", "good (in 4 days)", ...).
  //    A wrong answer on the map shows no buttons; the site then reschedules
  //    the card in 5 minutes.
  // The count is re-evaluated on those events only (an answer, a new batch),
  // not on a clock, so it doesn't jump while a card is on screen. All of it
  // is per quiz and in memory only: reopening a quiz starts fresh.

  // "again (in 4 min)" / "hard (in 59 sec)" / "easy (next wk)" -> ms, or
  // null when the label carries no interval this understands.
  function parseIntervalLabel(text) {
    const m = /\(\s*(?:in\s+)?(\d+(?:[.,]\d+)?|an?|next)\s*([a-z]+)\.?\s*\)/i.exec(String(text || ''));
    if (!m) return null;
    const n = /^\d/.test(m[1]) ? parseFloat(m[1].replace(',', '.')) : 1;
    const unit = m[2].toLowerCase();
    const MS = [
      [/^(s|secs?|seconds?)$/, 1000],
      [/^(m|mins?|minutes?)$/, 60 * 1000],
      [/^(h|hrs?|hours?)$/, 60 * 60 * 1000],
      [/^(d|days?)$/, 24 * 60 * 60 * 1000],
      [/^(w|wks?|weeks?)$/, 7 * 24 * 60 * 60 * 1000],
      [/^(mo|mos|months?)$/, 30 * 24 * 60 * 60 * 1000],
      [/^(y|yrs?|years?)$/, 365 * 24 * 60 * 60 * 1000],
    ];
    for (const [re, ms] of MS) if (re.test(unit)) return n * ms;
    return null;
  }

  // The tracker state: `batch` holds the unanswered ids of the latest list,
  // `due` maps each answered id to when it comes back (ms; Infinity when
  // unknown, i.e. not this session).
  function newCardTracker() {
    return { batch: Object.create(null), due: Object.create(null) };
  }

  function trackCardBatch(tracker, ids) {
    tracker.batch = Object.create(null);
    for (const id of ids) {
      tracker.batch[id] = true;
      delete tracker.due[id]; // it's back in the queue
    }
  }

  // intervalMs: what the clicked grading button promised, or null when no
  // button was involved (a wrong answer on the map: the site's fixed 5
  // minutes) or it couldn't be read (a passed card: not this session).
  function trackCardAnswer(tracker, id, rating, intervalMs, nowMs) {
    delete tracker.batch[id];
    let interval = intervalMs;
    if (interval === null || interval === undefined) {
      interval = rating === 1 || rating === null || rating === undefined ? 5 * 60 * 1000 : Infinity;
    }
    tracker.due[id] = nowMs + interval;
  }

  function trackedCardsLeft(tracker, nowMs) {
    let left = Object.keys(tracker.batch).length;
    for (const id in tracker.due) if (tracker.due[id] <= nowMs) left++;
    return left;
  }

  function ratingFromBody(body) {
    try {
      const data = typeof body === 'string' ? JSON.parse(body) : null;
      return data && typeof data.rating === 'number' ? data.rating : null;
    } catch (e) { return null; }
  }

  const QUIZ_ID_RE = /\/api\/quiz\/([^/]+)\/anki\/question/;
  const ANKI_QUIZZES_RE = /\/api\/quiz\/anki(?:\?|$)/;
  let cardTracker = newCardTracker();
  let cardTrackerQuizId = null;
  // id -> question text, for the log. Kept per tracker (not taken from
  // questionInfoById, which a single-card ?more response rebuilds).
  let cardQuestionText = Object.create(null);
  let cardsLeft = null; // null until the quiz's question list has been seen

  // The intervals shown on the grading buttons at the moment one of them
  // was clicked (by the user, a 1-4 key, auto-grade or the timeout), indexed
  // by rating. Consumed by the guess request that click sends.
  let pendingGradeIntervals = null;
  let pendingGradeIntervalsAt = 0;

  function onGradingButtonClick(e) {
    const button = e.target && e.target.closest && e.target.closest('button[title]');
    if (!button || !button.closest(GRADING_CONTAINER_SELECTOR)) return;
    const intervals = {};
    button.parentElement.querySelectorAll('button[title]').forEach((b) => {
      intervals[b.title] = parseIntervalLabel(b.textContent);
    });
    pendingGradeIntervals = intervals;
    pendingGradeIntervalsAt = Date.now();
  }

  function onCardQueue(url, list) {
    const m = QUIZ_ID_RE.exec(url || '');
    const quizId = m ? decodeURIComponent(m[1]) : null;
    if (quizId !== cardTrackerQuizId) {
      cardTracker = newCardTracker();
      cardTrackerQuizId = quizId;
      cardQuestionText = Object.create(null);
    }
    const cards = list.filter((q) => q && typeof q.id === 'string');
    for (const q of cards) {
      if (typeof q.question === 'string') cardQuestionText[q.id] = q.question.trim();
    }
    trackCardBatch(cardTracker, cards.map((q) => q.id));
    cardsLeft = trackedCardsLeft(cardTracker, Date.now());
    logCardTracker('loaded ' + cards.length + ' card' + (cards.length === 1 ? '' : 's') +
      (quizId ? ' for quiz ' + quizId : ''));
    if (showCardsLeft) refreshLiveQuizList();
  }

  function onCardAnswered(id, body) {
    const rating = ratingFromBody(body);
    let interval = null;
    // Only a click from just now belongs to this answer; an older one means
    // this guess came without buttons (wrong answer on the map).
    if (pendingGradeIntervals && Date.now() - pendingGradeIntervalsAt < 5000 && rating !== null) {
      interval = pendingGradeIntervals[String(rating)];
    }
    pendingGradeIntervals = null;
    const now = Date.now();
    trackCardAnswer(cardTracker, id, rating, interval, now);
    if (cardsLeft !== null) cardsLeft = trackedCardsLeft(cardTracker, now);
    logCardTracker('answered ' + id + ' (' + (cardQuestionText[id] || '?') + ') with rating ' +
      rating + ', ' + (interval === null || interval === undefined
        ? 'no button interval (default)'
        : 'button said ' + formatDuration(interval)));
  }

  function formatDuration(ms) {
    if (ms === Infinity) return 'not this session';
    const units = [['d', 86400000], ['h', 3600000], ['min', 60000], ['s', 1000]];
    for (const [name, size] of units) {
      if (Math.abs(ms) >= size) return Math.round(ms / size) + ' ' + name;
    }
    return '0 s';
  }

  // One row per tracked card: in the current batch, or when it comes back.
  function cardTrackerRows() {
    const now = Date.now();
    const rows = [];
    for (const id in cardTracker.batch) {
      rows.push({ id: id, question: cardQuestionText[id] || '', next: 'in current batch', counted: true });
    }
    const scheduled = Object.keys(cardTracker.due).sort((x, y) => cardTracker.due[x] - cardTracker.due[y]);
    for (const id of scheduled) {
      const at = cardTracker.due[id];
      rows.push({
        id: id,
        question: cardQuestionText[id] || '',
        next: at === Infinity ? 'not this session'
          : new Date(at).toLocaleTimeString() + (at <= now ? ' (due ' + formatDuration(now - at) + ' ago)' : ' (in ' + formatDuration(at - now) + ')'),
        counted: at <= now,
      });
    }
    return rows;
  }

  // Only with DEBUG on (the rows aren't even built otherwise), and then on
  // the console's "Verbose" level. hqCardsDebug() prints the same table on
  // demand either way.
  function logCardTracker(event) {
    if (!DEBUG) return;
    try {
      console.debug('[helloquiz-cards] ' + event + ' -> ' + cardsLeft + ' left', cardTrackerRows());
    } catch (e) { /* never let logging break the hooks */ }
  }

  window.hqCardsDebug = function () {
    console.log('[helloquiz-cards] quiz ' + cardTrackerQuizId + ', ' + cardsLeft + ' left (as of the last answer / load), ' +
      trackedCardsLeft(cardTracker, Date.now()) + ' counted right now');
    console.table(cardTrackerRows());
  };


  const ANKI_QUESTIONS_RE = /\/api\/quiz\/[^/]+\/anki\/question(?:\?|$)/;
  const GUESS_RE = /\/api\/game\/[^/]+\/question\/([^/]+)\/guess(?:\?|$)/;
  const HINT_RE = /\/api\/question\/([^/]+)\/hint(?:\?|$)/;

  const questionInfoById = Object.create(null); // id -> { question, hint }
  let lastAnsweredQuestionId = null;
  // The site's current question, learned from guess responses (each one
  // carries the next question being preloaded). Complements the text/image
  // matching in displayedQuestionId for questions that can't be matched.
  let siteCurrentQuestionId = null;
  // The site collapses hints behind a "display" toggle in some quizzes, but
  // its collapsed/revealed state belongs to ITS current (preloaded)
  // question - so a hint revealed during the pause stays revealed when the
  // next question comes up. Track which displayed question the user
  // actually revealed, and whether this quiz uses the toggle at all.
  let hintRevealedFor = null;      // displayedHintKey() of the question whose hint the user revealed
  let quizUsesHintToggle = false;  // seen a site "display" toggle in this quiz

  function rememberQuestion(q) {
    if (!q || typeof q.id !== 'string') return;
    const prev = questionInfoById[q.id];
    // customHint is the user-set hint and wins over the default one - but
    // only when actually set (a cleared custom hint comes back as "" and
    // must not shadow the default hint).
    const hint = (typeof q.customHint === 'string' && q.customHint !== '')
      ? q.customHint
      : (q.hint || '');
    questionInfoById[q.id] = {
      question: typeof q.question === 'string' && q.question.trim() !== ''
        ? q.question.trim()
        : (prev ? prev.question : ''),
      // Sparser sources (the guess response) must never erase a hint we
      // already know - the map may hold one from the anki list or learned
      // from the DOM. (The full-list rebuild wipes the map first, so this
      // fallback never keeps stale data across quizzes.)
      hint: hint || (prev ? prev.hint : ''),
    };
  }

  function rememberQuestions(list) {
    if (!Array.isArray(list)) return;
    // Each response carries the current quiz's complete question list;
    // rebuild the map so stale entries from other quizzes can't shadow a
    // same-named question (displayedQuestionId matches by question text).
    for (const key in questionInfoById) delete questionInfoById[key];
    for (const q of list) rememberQuestion(q);
  }

  // The guess response carries the NEXT question the site just preloaded -
  // that is the site's current question from then on. The exact response
  // shape isn't pinned down, so only accept objects that look like one.
  let lastGuessResponse = null; // raw, for hqHintDebug()

  function rememberNextQuestion(data) {
    lastGuessResponse = data;
    let q = null;
    if (data && typeof data.message === 'object' && data.message !== null && !Array.isArray(data.message)) {
      q = data.message;
    } else if (data && typeof data.id === 'string') {
      q = data;
    }
    if (!q || typeof q.id !== 'string') return;
    siteCurrentQuestionId = q.id;
    if (typeof q.question === 'string') rememberQuestion(q); // merge, don't wipe
  }

  // Which question is the user actually looking at right now? The mirror is
  // the source of truth for that: during a review pause it shows the
  // answered question while the site has already moved on, and otherwise it
  // shows the live one. Resolve its text against the question map; image
  // questions have no text, so fall back to the answered id while a review
  // pause is showing it.
  function displayedQuestionId() {
    if (mirrorHTML === null && mirrorText) {
      const text = mirrorText.trim();
      for (const id in questionInfoById) {
        if (questionInfoById[id].question === text) return id;
      }
    } else if (mirrorHTML !== null) {
      // Image question: match the mirrored <img> src against the question
      // field (which holds the image URL for image quizzes). Substring
      // matching in both directions absorbs relative/absolute differences.
      const m = mirrorHTML.match(/\bsrc="([^"]+)"/);
      if (m) {
        const src = m[1].replace(/&amp;/g, '&');
        for (const id in questionInfoById) {
          const q = questionInfoById[id].question;
          if (q && (q === src || src.includes(q) || q.includes(src))) return id;
        }
      }
    }
    if (pendingReview && lastAnsweredQuestionId) return lastAnsweredQuestionId;
    // Outside a pause the mirror shows the site's current question - if we
    // learned its id from the last guess response, use that (covers image
    // questions whose src can't be matched against the question field).
    if (!pendingReview && siteCurrentQuestionId) return siteCurrentQuestionId;
    return null;
  }

  // Stable key for "the question the user sees" even when no id can be
  // resolved (image questions, map not loaded yet): fall back to the
  // mirror's content itself.
  function displayedHintKey() {
    const id = displayedQuestionId();
    if (id) return id;
    return 'sig:' + (mirrorHTML !== null ? mirrorHTML : mirrorText);
  }

  function rememberHintFromBody(id, body) {
    if (typeof body !== 'string') return;
    try {
      const data = JSON.parse(body);
      if (data && typeof data.hint === 'string') {
        const info = questionInfoById[id] || (questionInfoById[id] = { question: '', hint: '' });
        info.hint = data.hint;
      }
    } catch (e) { /* body not JSON - nothing to remember */ }
  }

  // A hint edit aimed at a question other than the displayed one must be
  // redirected to the displayed question. Returns the id to redirect to, or
  // null to leave the request as is (also at quiz start, when no question
  // is displayed and displayedQuestionId can't resolve one).
  function hintEditTargetId(siteTargetId) {
    if (!scriptActive || !isAnkiPage()) return null;
    const id = displayedQuestionId();
    return (id && id !== siteTargetId) ? id : null;
  }

  function installFetchHook() {
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      let url = '';
      let method = 'GET';
      try {
        url = typeof input === 'string' ? input : (input instanceof URL ? input.href : (input && input.url) || '');
        method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();

        if (method === 'POST') {
          const m = url.match(GUESS_RE);
          if (m) {
            lastAnsweredQuestionId = decodeURIComponent(m[1]);
            onCardAnswered(lastAnsweredQuestionId, init && init.body);
          }
        } else if (method === 'PUT') {
          const m = url.match(HINT_RE);
          if (m) {
            const siteId = decodeURIComponent(m[1]);
            const target = hintEditTargetId(siteId);
            if (target) {
              const newUrl = url.replace(HINT_RE, '/api/question/' + encodeURIComponent(target) + '/hint');
              if (DEBUG) console.log('[helloquiz-timer] redirecting hint edit', url, '->', newUrl);
              if (typeof input === 'string' || input instanceof URL) input = newUrl;
              else input = new Request(newUrl, input);
            }
            rememberHintFromBody(target || siteId, init && init.body);
          }
        }
      } catch (e) { /* never break the site's requests */ }

      const resPromise = origFetch(input, init);
      if (method === 'GET' && ANKI_QUESTIONS_RE.test(url)) {
        resPromise.then((res) => {
          try {
            res.clone().json().then((data) => {
              if (data && Array.isArray(data.message)) {
                rememberQuestions(data.message);
                onCardQueue(url, data.message);
              }
            }).catch(() => {});
          } catch (e) { /* response not clonable/JSON - ignore */ }
        }, () => {});
      } else if (method === 'GET' && ANKI_QUIZZES_RE.test(url)) {
        resPromise.then((res) => {
          try {
            res.clone().json().then((data) => {
              if (data && Array.isArray(data.message)) onAnkiQuizList(data.message);
            }).catch(() => {});
          } catch (e) { /* response not clonable/JSON - ignore */ }
        }, () => {});
      } else if (method === 'POST' && GUESS_RE.test(url)) {
        resPromise.then((res) => {
          try {
            res.clone().json().then(rememberNextQuestion).catch(() => {});
          } catch (e) { /* response not clonable/JSON - ignore */ }
        }, () => {});
      }
      return resPromise;
    };
  }

  // Same interception for XMLHttpRequest, in case the site (or a future
  // version of it) doesn't use fetch for these calls.
  function installXhrHook() {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      try {
        this._hqMethod = String(method || 'GET').toUpperCase();
        this._hqUrl = typeof url === 'string' ? url : String(url);
        if (this._hqMethod === 'PUT') {
          const m = this._hqUrl.match(HINT_RE);
          if (m) {
            const siteId = decodeURIComponent(m[1]);
            const target = hintEditTargetId(siteId);
            this._hqHintTarget = target || siteId;
            if (target) {
              url = this._hqUrl.replace(HINT_RE, '/api/question/' + encodeURIComponent(target) + '/hint');
              this._hqUrl = url;
              if (DEBUG) console.log('[helloquiz-timer] redirecting hint edit (XHR) ->', url);
            }
          }
        }
      } catch (e) { /* never break the site's requests */ }
      return origOpen.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.send = function (body) {
      try {
        if (this._hqMethod === 'POST') {
          const m = (this._hqUrl || '').match(GUESS_RE);
          if (m) {
            lastAnsweredQuestionId = decodeURIComponent(m[1]);
            onCardAnswered(lastAnsweredQuestionId, body);
            this.addEventListener('load', () => {
              try {
                rememberNextQuestion(JSON.parse(this.responseText));
              } catch (e) { /* not JSON - ignore */ }
            });
          }
        } else if (this._hqHintTarget) {
          rememberHintFromBody(this._hqHintTarget, body);
        } else if (this._hqMethod === 'GET' && ANKI_QUESTIONS_RE.test(this._hqUrl || '')) {
          this.addEventListener('load', () => {
            try {
              const data = JSON.parse(this.responseText);
              if (data && Array.isArray(data.message)) {
                rememberQuestions(data.message);
                onCardQueue(this._hqUrl, data.message);
              }
            } catch (e) { /* not JSON - ignore */ }
          });
        } else if (this._hqMethod === 'GET' && ANKI_QUIZZES_RE.test(this._hqUrl || '')) {
          this.addEventListener('load', () => {
            try {
              const data = JSON.parse(this.responseText);
              if (data && Array.isArray(data.message)) onAnkiQuizList(data.message);
            } catch (e) { /* not JSON - ignore */ }
          });
        }
      } catch (e) { /* never break the site's requests */ }
      return origSend.call(this, body);
    };
  }

  // The "edit" button asks for the new hint via a native
  // window.prompt('Enter the new hint', <current hint>) - prefilled from
  // the site's state, which can lag behind or run ahead of what the user
  // sees. Whenever the displayed question is known, prefill with ITS hint
  // so the prompt matches the question the edit actually targets (the
  // request rewrite above).
  function installPromptHook() {
    const origPrompt = window.prompt.bind(window);
    window.prompt = function (message, defaultValue) {
      try {
        if (typeof message === 'string' && message.toLowerCase().includes('hint') &&
            scriptActive && isAnkiPage()) {
          const id = displayedQuestionId();
          if (id) defaultValue = questionInfoById[id].hint || '';
        }
      } catch (e) { /* fall back to the site's own prefill */ }
      return origPrompt(message, defaultValue);
    };
  }

  // A hint reveal is scoped to ONE presentation of a question: whenever the
  // displayed question changes, the reveal memory clears - so the same card
  // returning later in the session (anki repeats lapsed cards) or in the
  // next round starts collapsed again.
  let lastDisplayedKey = null;
  function watchDisplayedQuestion() {
    const key = displayedHintKey();
    if (key === lastDisplayedKey) return;
    lastDisplayedKey = key;
    hintRevealedFor = null;
  }

  // Console helper for debugging hint resolution: run hqHintDebug() in the
  // browser console on a misbehaving screen and inspect/paste the output.
  window.hqHintDebug = function () {
    return {
      mirrorIsStatus: mirrorIsStatus,
      mirrorText: mirrorHTML === null ? mirrorText : null,
      mirrorImgSrc: mirrorHTML !== null ? (mirrorHTML.match(/\bsrc="([^"]+)"/) || [])[1] : null,
      pendingReview: pendingReview,
      lastAnsweredQuestionId: lastAnsweredQuestionId,
      siteCurrentQuestionId: siteCurrentQuestionId,
      displayedQuestionId: displayedQuestionId(),
      hintElPresent: !!findHintEl(),
      gradingButtons: !!findAgainButton(),
      questionCount: Object.keys(questionInfoById).length,
      questionSample: Object.entries(questionInfoById).slice(0, 3)
        .map(([id, q]) => ({ id: id, question: q.question, hint: q.hint })),
      lastGuessResponse: lastGuessResponse,
    };
  };

  // The hint line under the question. Its children are SEPARATE nodes
  // (React renders each expression as its own text node):
  //   collapsed: "hint: " | <span>display</span> | <span>edit</span>
  //   revealed:  "hint: " | "xyz "               | <span>edit</span>
  let observedHintClassNames = '';

  function findHintEl() {
    // :not() excludes our own fallback line, which borrows the site's hint
    // class for styling (and whose own class contains "hint" too).
    const hintEl = document.querySelector(
      '[class*="scoreAndHint"] p[class*="hint"]:not(.' + HINT_LINE_CLASS + ')'
    );
    if (hintEl) {
      // Remember the live generated class instead of pinning its build hash.
      observedHintClassNames = Array.from(hintEl.classList)
        .filter((name) => name.includes('-module__') && name.endsWith('__hint'))
        .join(' ');
    }
    return hintEl;
  }

  // Keep the hint line in sync with the question the user actually sees
  // (the site's own line can belong to the preloaded next question). Only
  // the VALUE text node is ever rewritten: the "hint: " prefix stays
  // pristine (writing the hint into it revealed hints the site had
  // collapsed behind "display" - and duplicated them once revealed), and
  // the display/edit spans stay untouched - the request rewrite above
  // makes "edit" target the right question.
  //
  // Collapse handling: the site's collapsed/revealed state follows ITS
  // current (preloaded) question, so a hint revealed during the pause would
  // stay revealed when the next question comes up. When this quiz uses the
  // display toggle and the user hasn't revealed the hint of the question
  // now displayed, blank the value and offer our own "display" span
  // (clicking it is handled in onHintDisplayClick).
  function ensureHintMirror() {
    if (!scriptActive) return;
    // No question displayed ("Click to start"): the site's hint line would
    // belong to the still-hidden question - hide it wholesale via CSS.
    document.documentElement.classList.toggle(HINT_HIDE_CLASS, mirrorIsStatus);
    if (mirrorIsStatus) return;
    const p = findHintEl();
    if (!p) return;
    const first = p.firstChild;
    if (!first || first.nodeType !== Node.TEXT_NODE) return;
    if (first.data !== 'hint: ') first.data = 'hint: '; // undo any old pollution

    const ourSpan = p.querySelector('span.' + HINT_DISPLAY_CLASS);
    let valueNode = null;
    for (let node = first.nextSibling; node; node = node.nextSibling) {
      if (node.nodeType === Node.ELEMENT_NODE && node !== ourSpan &&
          node.textContent.trim() === 'display') {
        // The site's own toggle is showing: it is collapsed correctly, and
        // this quiz evidently uses the toggle.
        quizUsesHintToggle = true;
        if (ourSpan) ourSpan.remove();
        return;
      }
      if (node.nodeType === Node.TEXT_NODE && (node.data.trim() !== '' || node._hqBlankedValue)) {
        valueNode = node;
        break;
      }
    }
    if (!valueNode) {
      if (ourSpan) ourSpan.remove(); // no value rendered - nothing to guard
      return;
    }

    if (quizUsesHintToggle && displayedHintKey() !== hintRevealedFor) {
      // Left revealed by the site for a question the user never revealed:
      // re-collapse it behind our own toggle.
      if (valueNode.data !== '') valueNode.data = '';
      valueNode._hqBlankedValue = true; // still recognizable as the value node
      if (!ourSpan) {
        const span = document.createElement('span');
        span.className = HINT_DISPLAY_CLASS;
        span.textContent = 'display';
        p.insertBefore(span, valueNode);
      }
      return;
    }
    if (ourSpan) ourSpan.remove();
    delete valueNode._hqBlankedValue;

    const id = displayedQuestionId();
    if (!pendingReview) {
      // Outside a pause the site's line already belongs to the displayed
      // question - it is authoritative. Overwriting it here erased default
      // hints the anki response doesn't carry (it only has custom ones);
      // instead LEARN such a hint from the DOM so later pauses can show it.
      const shown = valueNode.data.trim();
      if (id && shown && questionInfoById[id].hint === '') {
        questionInfoById[id].hint = shown;
      }
      return;
    }
    // During a pause the site's value belongs to the preloaded next
    // question - enforce the displayed question's hint instead.
    const desired = id ? questionInfoById[id].hint + ' ' : '';
    if (valueNode.data !== desired) valueNode.data = desired;
  }

  // The site's hint line can be missing entirely while a question is still
  // displayed: on the end-of-quiz screen (an upstream bug - the app is
  // already in its "quiz done" state), on the grading screen after a
  // correct answer (again/hard/good/easy), and mid-pause when the
  // preloaded NEXT question has no hint - even though the DISPLAYED
  // question may have one. Provide our own line then - same look and
  // behavior: a display toggle honoring the collapse rules, and an edit
  // action that PUTs through the same (hooked) endpoint the site uses.
  function ensureFallbackHintLine() {
    const existing = document.querySelector('p.' + HINT_LINE_CLASS);
    const relevantState = pendingReview || !!findAgainButton();
    const id = scriptActive && relevantState && !findHintEl() ? displayedQuestionId() : null;
    if (!id) {
      if (existing) existing.remove();
      return;
    }
    const contentEl = findContentElForMirror();
    if (!contentEl) return;
    // Live inside the site's scoreAndHint container when it exists (it is
    // often left empty on these screens) and wear the site's own hint
    // class, so the line is styled exactly like the regular one.
    const host = contentEl.querySelector('[class*="scoreAndHint"]') || contentEl;
    let p = existing;
    if (!p) {
      p = document.createElement('p');
      p.className = HINT_LINE_CLASS;
    }
    if (observedHintClassNames) {
      p.className = HINT_LINE_CLASS + ' ' + observedHintClassNames;
    }
    if (p.parentElement !== host) host.appendChild(p);
    const hint = questionInfoById[id].hint || '';
    // An empty hint has nothing to protect - no point in a display toggle.
    const revealed = !quizUsesHintToggle || !hint || displayedHintKey() === hintRevealedFor;
    const state = revealed ? 'r:' + hint : 'c';
    if (p.dataset.hqState === state) return;
    p.dataset.hqState = state;
    p.textContent = 'hint: ';
    if (revealed) {
      p.appendChild(document.createTextNode(hint + ' '));
    } else {
      const toggle = document.createElement('span');
      toggle.className = HINT_DISPLAY_CLASS;
      toggle.textContent = 'display';
      p.appendChild(toggle);
      p.appendChild(document.createTextNode(' '));
    }
    const edit = document.createElement('span');
    edit.className = HINT_EDIT_CLASS;
    edit.textContent = 'edit';
    p.appendChild(edit);
  }

  function removeFallbackHintLine() {
    document.querySelectorAll('p.' + HINT_LINE_CLASS).forEach((el) => el.remove());
  }

  // The anki page offers no way over to the same quiz in its normal mode.
  // Add one as the first entry of the site's own bracketed action list next
  // to the title: the current quiz URL without the ?learn flag.
  function ensureQuizLink() {
    if (!location.pathname.startsWith('/quiz/')) return; // no title actions on /learn
    const actions = findTitleActionsEl();
    if (!actions) return;
    const url = new URL(location.href);
    url.searchParams.delete('learn');
    const href = url.pathname + url.search + url.hash;
    let link = actions.querySelector('a.' + QUIZ_LINK_CLASS);
    if (!link) {
      // Insert before the site's first link ("remixes") so we land after the
      // opening bracket rather than in front of it.
      const first = actions.querySelector('a');
      if (!first) return; // unexpected markup - leave the line alone
      link = document.createElement('a');
      link.className = QUIZ_LINK_CLASS;
      link.textContent = 'normal quiz';
      actions.insertBefore(link, first);
      actions.insertBefore(document.createTextNode(' / '), first);
    }
    // The title survives SPA navigation between quizzes, so keep the target
    // pointing at whichever quiz is currently open.
    if (link.getAttribute('href') !== href) link.setAttribute('href', href);
    // ... and one to this quiz's card browser right after it.
    const quizId = currentQuizId();
    if (!quizId) return;
    let browse = actions.querySelector('a.' + BROWSE_LINK_CLASS);
    if (!browse) {
      browse = document.createElement('a');
      browse.className = BROWSE_LINK_CLASS;
      browse.textContent = 'browse cards';
      actions.insertBefore(browse, link.nextSibling);
      actions.insertBefore(document.createTextNode(' / '), browse);
    }
    const browseHref = '/quiz/' + encodeURIComponent(quizId) + '/browse';
    if (browse.getAttribute('href') !== browseHref) browse.setAttribute('href', browseHref);
  }

  function removeQuizLink() {
    document.querySelectorAll(TITLE_ACTIONS_SELECTOR + ' a.' + BROWSE_LINK_CLASS).forEach((el) => {
      const sep = el.previousSibling;
      if (sep && sep.nodeType === Node.TEXT_NODE && sep.textContent === ' / ') sep.remove();
      el.remove();
    });
    document.querySelectorAll('a.' + QUIZ_LINK_CLASS).forEach((el) => {
      // Drop the separator we added along with the link.
      const sep = el.nextSibling;
      if (sep && sep.nodeType === Node.TEXT_NODE && sep.textContent === ' / ') sep.remove();
      el.remove();
    });
  }

  // The edit action of our fallback line: same prompt + PUT as the site's
  // own edit. The request runs through our fetch hook, which also updates
  // the local hint map, so the line refreshes on the next pass.
  function editDisplayedHint() {
    const id = displayedQuestionId();
    if (!id) return;
    const entered = window.prompt('Enter the new hint', questionInfoById[id].hint || '');
    if (entered === null) return;
    hintRevealedFor = displayedHintKey(); // show the result of the edit
    fetch('/api/question/' + encodeURIComponent(id) + '/hint', {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: JSON.stringify({ hint: entered }),
    }).catch(() => { /* the site shows no error feedback either */ });
  }

  // Clicks on the hint lines' actions: our display toggles (site line and
  // fallback line) reveal the displayed question's hint, our fallback edit
  // opens the hint prompt; a click on the SITE's toggle is only observed
  // (never blocked) to remember that the reveal belongs to the displayed
  // question.
  function onHintDisplayClick(e) {
    if (!scriptActive) return;
    const span = e.target && e.target.closest ? e.target.closest('span') : null;
    if (!span) return;
    if (span.classList.contains(HINT_DISPLAY_CLASS)) {
      e.preventDefault();
      e.stopPropagation();
      hintRevealedFor = displayedHintKey();
      ensureHintMirror(); // reveal immediately
      ensureFallbackHintLine();
    } else if (span.classList.contains(HINT_EDIT_CLASS)) {
      e.preventDefault();
      e.stopPropagation();
      editDisplayedHint();
    } else if (span.textContent.trim() === 'display') {
      const siteLine = findHintEl();
      if (siteLine && siteLine.contains(span)) {
        hintRevealedFor = displayedHintKey();
      }
    }
  }

  // ---------- Watchers ----------

  // Invalidate the stored question signature so watchForNewQuestion treats
  // whatever is on screen as a brand-new question on its next run.
  function forceQuestionRedetect() {
    currentQuestionSig = '__forced_reset__' + Math.random();
  }

  function fullReset(reason) {
    if (DEBUG) console.log('[helloquiz-timer] full reset (' + reason + ')');
    clearTimer();
    hideReviewOverlay();
    endNavPause();
    navButtonsWerePresent = false;
    timedOut = false;
    buttonsWerePresent = false;
    pendingAutoGradeFraction = null; // belonged to the old quiz's last answer
    // Drop stale bar references so a fresh one gets created in the new DOM
    removeTimerBar();
    resetMirror('Click to start'); // previous quiz's question is irrelevant now
    // New quiz starts paused too: wait for a click before showing the
    // question and starting the timer.
    markPendingReview('quiz start');
    lastAnsweredQuestionId = null; // previous quiz's answer is irrelevant
    siteCurrentQuestionId = null;
    hintRevealedFor = null;
    quizUsesHintToggle = false;
    forceQuestionRedetect();
  }

  function watchForQuizChange() {
    const titleEl = findQuizTitleEl();
    const title = titleEl ? titleEl.textContent : '';
    if (title !== currentQuizTitle) {
      const isFirst = currentQuizTitle === '';
      currentQuizTitle = title;
      if (!isFirst) {
        fullReset('quiz changed to "' + title + '"');
      }
    }
  }

  // ---------- Instant SPA navigation detection ----------

  // The 200ms poll is too slow to hide the question when navigating
  // between pages (e.g. from the /learn list into a quiz): the new
  // question renders before the poll notices the change. pushState fires
  // synchronously at the moment of the click, BEFORE the new content
  // renders, so hooking it lets us hide/reset with zero visible flash.

  let lastUrl = location.href;
  let scriptActive = isAnkiPage(); // may load on any page (SPA); start inactive off-anki

  function setActive(active) {
    if (active === scriptActive) return;
    scriptActive = active;
    if (DEBUG) console.log('[helloquiz-timer] ' + (active ? 'activating' : 'deactivating') + ' on', location.pathname + location.search);

    if (active) {
      // Returning to an anki page: start in the waiting state.
      hideQuestion();
      resetMirror('Click to start');
      markPendingReview('entered anki page');
      forceQuestionRedetect();
    } else {
      // Leaving anki mode: undo everything so normal pages are untouched.
      clearTimer();
      hideReviewOverlay(); // also reveals the question
      endNavPause();
      navButtonsWerePresent = false;
      pendingReview = false;
      timedOut = false;
      lastAnsweredQuestionId = null;
      siteCurrentQuestionId = null;
      hintRevealedFor = null;
      quizUsesHintToggle = false;
      document.documentElement.classList.remove(HINT_HIDE_CLASS);
      removeFallbackHintLine();
      removeQuizLink();
      showQuestion();
      removeMirror();
      removeListKbdHints();
      removeOpenDueButton();
      removeToast();
      removeSettingsPanel();
      removeTimerBar();
    }
  }

  function onUrlChange() {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const anki = isAnkiPage();
    setActive(anki);
    if (anki) {
      fullReset('url changed to ' + location.pathname);
    }
  }

  function installHistoryHook() {
    ['pushState', 'replaceState'].forEach((fnName) => {
      const orig = history[fnName].bind(history);
      history[fnName] = function (...args) {
        const ret = orig(...args);
        try { onUrlChange(); } catch (e) { /* never break navigation */ }
        return ret;
      };
    });
    window.addEventListener('popstate', onUrlChange);
  }

  function watchForNewQuestion() {
    const qEl = findQuestionEl();
    const container = findMapContainer();
    if (!qEl || !container) return;
    // On the end-of-quiz screen the nav buttons are shown instead of a live
    // question; don't treat it as a new question, which would clear the
    // pending review and prevent the end-of-quiz pause from triggering (this
    // matters when the timer is off and the else-branch below runs).
    if (anyNavButtonPresent()) return;

    const sig = questionSignature(qEl);
    if (sig !== currentQuestionSig) {
      currentQuestionSig = sig;
      // Don't assume no buttons are present - the previous question's
      // grading buttons can still be mid-fade-out in the DOM right as the
      // next question renders.
      buttonsWerePresent = !!findAgainButton();

      if (reviewPause && pendingReview) {
        // Review pending: show the continue button and do NOT update the
        // mirror - it keeps showing the previous (answered) question.
        // Independent of the timer: the pause works even with the timer off.
        const quizContainer = findQuizContainer() || container;
        showReviewOverlay(quizContainer);
      } else {
        pendingReview = false;
        captureQuestionToMirror(qEl);
        ensureMirror();
        startTimer(container);
      }
    }
  }

  function watchForGradingButtons() {
    const again = findAgainButton();
    const buttonsPresent = !!again;

    if (buttonsPresent && !buttonsWerePresent) {
      // Buttons just appeared — the user answered correctly on the map.
      // The leftover fraction was captured back when the answer was detected
      // (see onAnswerDetected) — by now clearTimer() below has long since
      // thrown the actual countdown state away.
      const leftover = pendingAutoGradeFraction;
      pendingAutoGradeFraction = null;
      clearTimer();
      if (running && timedOut) {
        markPendingReview('timeout');
        again.click();
      } else if (autoGrade && leftover !== null) {
        autoGradeAnswer(leftover);
      }
    }

    buttonsWerePresent = buttonsPresent;
  }

  // ---------- Auto-grading (grade a correct answer from the leftover time) ----------

  // How much of the countdown is still left, as a 0-1 fraction, or null when
  // there is no countdown to judge by (timer off, or nothing running).
  function remainingFraction() {
    if (!running || timerFullSeconds <= 0) return null;
    // A countdown is active while it has its handles, or while it sits parked
    // in pausedRemaining after a tab switch.
    if (!timerInterval && !timeoutHandle && pausedRemaining === null) return null;
    if (timedOut) return 0;
    const remaining = pausedRemaining !== null ? pausedRemaining : (timerDeadline - Date.now()) / 1000;
    return Math.max(0, Math.min(1, remaining / timerFullSeconds));
  }

  // The grading button a given leftover time earns: the more of the countdown
  // was left, the easier the card evidently was. "again" is never awarded here
  // - failing is what the timeout path is for.
  function autoGradeButtonTitle(fraction) {
    if (fraction >= autoGradeEasy / 100) return '4'; // easy
    if (fraction >= autoGradeGood / 100) return '3'; // good
    return '2';                                      // hard
  }

  function autoGradeAnswer(fraction) {
    const container = findGradingContainer();
    if (!container) return;
    const title = autoGradeButtonTitle(fraction);
    const button = container.querySelector('button[title="' + title + '"]');
    if (!button) return;
    if (DEBUG) console.log('[helloquiz-timer] auto-grading with button', title, 'at', Math.round(fraction * 100) + '% left');
    button.click();
  }

  // ---------- Nav button detection (▶ ⇋ →) ----------

  function isNavButton(el) {
    if (!el || !el.textContent) return false;
    const text = el.textContent.trim();
    return NAV_BUTTONS.some((b) => text.includes(b.symbol));
  }

  function onPossibleNavClick(e) {
    if (!scriptActive) return;
    if (!isAnkiPage()) return;
    // Only match a click that actually landed inside a real <button>.
    // Walking up arbitrary ancestors and checking their aggregated
    // textContent (the old approach) is unreliable: textContent includes
    // ALL descendant text, so a shared container up the tree (e.g. the
    // map's parent) can "match" just because a nav button sits somewhere
    // else in its subtree - still in the DOM mid-fade-out, or hidden via
    // NAV_HIDE_CLASS - even though the click itself was nowhere near it.
    // That caused spurious timer resets while just panning/zooming the map.
    // closest('button') stops precisely at the nearest enclosing button, so
    // an unrelated button elsewhere in the DOM can never be picked up here.
    const matched = e.target.closest('button');
    if (!matched || !isNavButton(matched)) return;
    if (DEBUG) console.log('[helloquiz-timer] nav button matched:', matched.textContent.trim());

    // "▶ practice more" continues in the same quiz you're already engaged
    // with — no waiting screen needed, start the timer directly. The other
    // nav buttons (⇋ select / → next quiz) lead elsewhere and keep the
    // waiting screen.
    const isPracticeMore = matched.textContent.includes(PRACTICE_MORE_SYMBOL);

    setTimeout(() => {
      hideReviewOverlay();
      if (isPracticeMore) {
        pendingReview = false;
      } else {
        markPendingReview('nav');
      }
      forceQuestionRedetect();
      watchForNewQuestion();
    }, 250);
  }


  // ---------- Keyboard handlers ----------

  // Shortcuts must stay inert while the user is typing in a form field
  // (e.g. the timer-seconds inputs in the settings panel).
  function isTypingInField() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!el.isContentEditable;
  }

  function onOverlayKeydown(e) {
    if (!overlayEl) return;
    if (e.key === '1') {
      e.preventDefault();
      proceedFromOverlay();
    }
  }


  const QUIZ_LIST_KEY_INDEX = { '1': 0, '2': 1, '3': 2, '4': 3 };
  const KBD_COUNT = 4; // rows reachable via keys 1-4

  // Insert a key badge (e.g. "1", "Esc") as the first child of el.
  function prependKbd(el, label) {
    const kbd = document.createElement('kbd');
    kbd.className = KBD_CLASS;
    kbd.textContent = label;
    el.insertBefore(kbd, el.firstChild);
  }

  function ensureListKbdHints() {
    const table = findQuizListTable();
    if (!table) return;
    const rows = table.querySelectorAll('tbody tr');
    rows.forEach((row, i) => {
      const existing = row.querySelector('kbd.' + KBD_CLASS);
      if (i < KBD_COUNT) {
        const label = String(i + 1);
        if (existing) {
          // Rows can reorder (sortable table) - keep numbers positional
          if (existing.textContent !== label) existing.textContent = label;
        } else {
          const td = row.querySelector('td');
          if (!td) return;
          prependKbd(td, label);
        }
      } else if (existing) {
        existing.remove();
      }
    });
  }

  function removeListKbdHints() {
    document.querySelectorAll('kbd.' + KBD_CLASS).forEach((el) => el.remove());
  }

  function ensureNavKbdHints() {
    // Same key badges on the end-of-quiz buttons (▶ practice more,
    // ⇋ select quiz, → next quiz), matching their 1/2/3 shortcuts.
    // When the buttons aren't on the page, this is a cheap no-op; their
    // badges disappear together with the buttons themselves.
    ensureNextQuizButton();
    NAV_BUTTONS.forEach(({ key, symbol }) => {
      const btn = findNavButtonBySymbol(symbol);
      if (!btn) return;
      const kbd = btn.querySelector('kbd.' + KBD_CLASS);
      if (!kbd) {
        prependKbd(btn, key);
      } else if (kbd.textContent !== key) {
        kbd.textContent = key; // the site's → moved from 3 to 4
      }
      // Wrap the bare symbol glyph (e.g. "▶") in a span so CSS can hide it,
      // leaving only the text label visible. The glyph stays in the DOM
      // (just hidden), so textContent still contains the symbol and the
      // click/keyboard detection keeps matching on it.
      if (!btn.querySelector('span.' + NAVSYM_CLASS)) {
        for (const node of Array.from(btn.childNodes)) {
          if (node.nodeType === Node.TEXT_NODE && node.data.includes(symbol)) {
            const wrap = document.createElement('span');
            wrap.className = NAVSYM_CLASS;
            wrap.textContent = node.data;
            node.replaceWith(wrap);
            break;
          }
        }
      }
    });

    // And on the grading buttons (again/hard/good/easy), whose keyboard
    // shortcuts match their title attributes 1-4.
    const gradeContainer = findGradingContainer();
    if (gradeContainer) {
      ['1', '2', '3', '4'].forEach((key) => {
        const btn = gradeContainer.querySelector('button[title="' + key + '"]');
        if (!btn) return;
        if (btn.querySelector('kbd.' + KBD_CLASS)) return;
        prependKbd(btn, key);
      });
    }

    // And an Esc badge on the menu's "anki mode" link, since the Escape
    // key navigates there. Also shorten its text to just "anki" so the
    // badge + label stay centered on a single line in the menu.
    const onLearnPage = location.pathname === '/learn';
    document.querySelectorAll('a[href="/learn"]').forEach((link) => {
      link.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE && node.data.includes('anki mode')) {
          node.data = node.data.replace('anki mode', 'anki');
        }
      });
      const existingKbd = link.querySelector('kbd.' + KBD_CLASS);
      // On /learn the Esc shortcut has nowhere to go (you're already here),
      // so don't show its badge — and drop it if we're arriving from a quiz.
      if (onLearnPage) {
        if (existingKbd) existingKbd.remove();
        return;
      }
      if (existingKbd) return;
      prependKbd(link, 'Esc');
    });
  }

  function openQuizListRow(index) {
    // Select by row (each row contains multiple ?learn links: the title
    // and the "anki mode" link both point to the same quiz).
    const table = findQuizListTable();
    if (!table) return false;
    const rows = table.querySelectorAll('tbody tr');
    const row = rows[index];
    if (!row) return false;
    const link = row.querySelector('a[href*="?learn"]');
    if (!link) return false;
    if (DEBUG) console.log('[helloquiz-timer] opening quiz #' + (index + 1) + ' in list:', link.textContent);
    link.click();
    return true;
  }

  function onQuizListKeydown(e) {
    if (!scriptActive) return;
    if (!isAnkiPage()) return;
    // On the quiz list (/learn), keys 1-4 open the corresponding quiz row.
    const index = QUIZ_LIST_KEY_INDEX[e.key];
    if (index === undefined) return;
    if (overlayEl) return; // overlay handler takes priority
    if (isTypingInField()) return;
    if (findAgainButton()) return; // grading in progress takes priority
    invalidateNavScan(); // key events run outside a watcher pass - rescan
    if (findNavButtonBySymbol(NAV_SYMBOL_BY_KEY[e.key])) return; // end-of-quiz buttons take priority

    if (openQuizListRow(index)) {
      e.preventDefault();
    }
  }

  function findQuizListTable() {
    // The list's CSS module has been renamed before. Anchor discovery to the
    // actual learn-mode links instead: their closest table is the quiz list.
    const learnLink = document.querySelector('table a[href*="?learn"]');
    return learnLink ? learnLink.closest('table') : null;
  }

  // ---------- Open all due quizzes (/learn) ----------

  // Only some of the quizzes in the list have cards waiting. One button next
  // to the list's heading opens every quiz with a non-zero overdue count in
  // its own tab, so a study session starts with exactly the quizzes that need
  // work.

  // Shown by the button's "?" and worth stating up front: opening several
  // tabs at once is exactly what pop-up blockers exist for.
  const OPEN_DUE_TIP = 'Opens every quiz with overdue questions in its own tab. ' +
    'Browsers block that by default — allow pop-ups for helloquiz.app if not all of them show up.';

  // The list's "quizzes" heading. Matched on its own text nodes only: once
  // the button is inside it, textContent also contains the button's label,
  // which would stop the heading from matching on the next pass.
  function findQuizListHeading() {
    for (const heading of document.querySelectorAll('h1, h2')) {
      let text = '';
      heading.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) text += node.data;
      });
      if (text.trim().toLowerCase() === 'quizzes') return heading;
    }
    return null;
  }

  // Index of the "overdue" column, read from the header so that a column
  // added on the site's side doesn't silently make us open the wrong quizzes.
  function overdueColumnIndex(table) {
    const headers = table.querySelectorAll('thead th');
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].textContent.trim().toLowerCase().includes('overdue')) return i;
    }
    return 2; // quiz | next question due | overdue | remove
  }

  // The anki-mode (?learn) URLs of all quizzes with overdue questions.
  function findDueQuizUrls() {
    const table = findQuizListTable();
    if (!table) return [];
    const col = overdueColumnIndex(table);
    const urls = [];
    table.querySelectorAll('tbody tr').forEach((row) => {
      const cell = row.querySelectorAll('td')[col];
      if (!cell) return;
      const overdue = parseInt(cell.textContent.trim(), 10);
      if (!(overdue > 0)) return;
      // Every row has several ?learn links (the title and the "anki mode"
      // action); they all point at the same quiz, so the first one will do.
      const link = row.querySelector('a[href*="?learn"]');
      if (link && link.href) urls.push(link.href);
    });
    return urls;
  }

  function openDueQuizzes() {
    const urls = findDueQuizUrls();
    if (urls.length === 0) return false;
    // Open synchronously, directly inside the click/keydown handler. Popup
    // blockers key off whether window.open() is called within the direct call
    // stack of a user gesture; anything deferred via setTimeout/promises loses
    // that context and gets silently blocked after the first tab.
    let blocked = 0;
    urls.forEach((url) => {
      if (!window.open(url, '_blank')) blocked++;
    });
    if (DEBUG) console.log('[helloquiz-timer] opened ' + (urls.length - blocked) + '/' + urls.length + ' due quizzes');
    if (blocked > 0) {
      showToast(blocked + ' of ' + urls.length + ' tabs were blocked by the browser. ' +
        'Allow pop-ups for helloquiz.app, then try again.');
    }
    return true;
  }

  function ensureOpenDueButton() {
    const table = findQuizListTable();
    if (!table || !table.parentNode) {
      // Navigating from the list into a quiz keeps the script active, so the
      // button has to clean itself up once the list is gone.
      removeOpenDueButton();
      return;
    }
    let btn = document.querySelector('button.' + OPEN_DUE_CLASS);
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = OPEN_DUE_CLASS;
      btn.addEventListener('click', openDueQuizzes);
    }
    // Right of the "quizzes" heading, so it sits where the eye already is
    // instead of floating alone at the left edge above the table. Re-checked
    // every pass so a re-rendered heading or table gets the button back.
    const heading = findQuizListHeading();
    if (heading) {
      if (btn.parentNode !== heading) heading.appendChild(btn);
    } else if (btn.nextElementSibling !== table) {
      // Unexpected markup: fall back to the top of the table itself.
      table.parentNode.insertBefore(btn, table);
    }
    // The counts change while the list is open (finishing a quiz elsewhere,
    // a re-sort, a removed quiz), so refresh the label on every pass.
    const count = findDueQuizUrls().length;
    const label = count === 0
      ? 'no quizzes due'
      : 'open ' + count + ' due ' + (count === 1 ? 'quiz' : 'quizzes');
    if (btn.textContent !== label) btn.textContent = label;
    btn.disabled = count === 0;
    ensureOpenDueHelp(btn);
  }

  // The "?" next to the button, explaining what it opens and warning about the
  // pop-up blocker - the reason for a half-opened batch of tabs is worth
  // knowing before the click, not just after it.
  function ensureOpenDueHelp(btn) {
    let badge = document.querySelector('span.' + HELP_CLASS + '.' + OPEN_DUE_HELP_CLASS);
    let body = document.querySelector('span.' + HELP_TEXT_CLASS + '.' + OPEN_DUE_HELP_CLASS);
    if (!badge || !body) {
      // Never leave half a pair behind, or the next pass would keep finding
      // one of them and skip the rebuild.
      removeOpenDueHelp();
      const help = makeHelp(OPEN_DUE_TIP);
      badge = help.badge;
      body = help.body;
      badge.classList.add(OPEN_DUE_HELP_CLASS);
      body.classList.add(OPEN_DUE_HELP_CLASS);
    }
    // Follow the button around: it moves whenever the heading or the table is
    // re-rendered, and the badge belongs directly after it.
    if (badge.previousElementSibling !== btn) btn.after(badge);
    if (body.previousElementSibling !== badge) badge.after(body);
  }

  function removeOpenDueHelp() {
    document.querySelectorAll('.' + OPEN_DUE_HELP_CLASS).forEach((el) => el.remove());
  }

  function removeOpenDueButton() {
    document.querySelectorAll('button.' + OPEN_DUE_CLASS).forEach((el) => el.remove());
    removeOpenDueHelp();
  }

  // ---------- Next quiz in line (end-of-quiz screen) ----------

  // The site's → goes to the MOST overdue quiz, i.e. always back to the top
  // of its priority list (GET /api/quiz/anki). Our "next quiz" button walks
  // that list in order instead (#2, #3, #4, ...). Finishing a quiz moves it
  // far down the live list, so the order is remembered as it was when the
  // walk started: every list fetched on /learn, or the first one seen when
  // there is none yet. Kept in sessionStorage - it has to survive the page
  // loads between quizzes, and is per tab.
  const NEXT_QUIZ_ORDER_KEY = 'hq-next-quiz-order';
  const NEXT_QUIZ_CLASS = 'hq-next-quiz';
  let liveQuizList = null; // the latest /api/quiz/anki response, normalized

  function normalizeQuizList(list) {
    return (list || [])
      .filter((q) => q && typeof q.id === 'string' && !q.deletedAt)
      .map((q) => ({ id: q.id, title: q.title || '', overdueCount: Number(q.overdueCount) || 0 }));
  }

  // The quiz to go to after `currentId`: the next one in the remembered
  // `order` that (per the live list, else per its remembered count) still
  // has overdue cards. When there is none, start over from the live list:
  // it becomes the new order, and the pick is its first overdue quiz other
  // than the current one. Returns { id (or null), order (to remember) }.
  function chooseNextQuiz(order, live, currentId) {
    const liveCount = Object.create(null);
    for (const q of live || []) liveCount[q.id] = q.overdueCount;
    const isOverdue = (q) => (q.id in liveCount ? liveCount[q.id] : q.overdueCount) > 0;
    const index = (order || []).findIndex((q) => q.id === currentId);
    if (index !== -1) {
      const next = order.slice(index + 1).find((q) => q.id !== currentId && isOverdue(q));
      if (next) return { id: next.id, order: order };
    }
    if (!live || !live.length) return { id: null, order: order || [] };
    const first = live.find((q) => q.id !== currentId && isOverdue(q));
    return { id: first ? first.id : null, order: live };
  }

  function loadNextQuizOrder() {
    try {
      const data = JSON.parse(sessionStorage.getItem(NEXT_QUIZ_ORDER_KEY) || 'null');
      return Array.isArray(data) ? data : null;
    } catch (e) { return null; }
  }

  function saveNextQuizOrder(order) {
    try {
      sessionStorage.setItem(NEXT_QUIZ_ORDER_KEY, JSON.stringify(order));
    } catch (e) { /* storage unavailable - the walk just restarts each page */ }
  }

  function onAnkiQuizList(list) {
    liveQuizList = normalizeQuizList(list);
    if (location.pathname === '/learn' || !loadNextQuizOrder()) saveNextQuizOrder(liveQuizList);
  }

  function currentQuizId() {
    const m = /^\/quiz\/([^/]+)/.exec(location.pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Asks for a fresh quiz list first: the site doesn't fetch it on a quiz
  // page loaded directly (which is how this button navigates), so without
  // that there'd be no live list to start over from at the end of the order.
  // Falls back to the last list seen when the request fails.
  let goingToNextQuiz = false;

  function goToNextQuiz() {
    if (goingToNextQuiz) return;
    goingToNextQuiz = true;
    fetch('/api/quiz/anki', { credentials: 'same-origin' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (data && Array.isArray(data.message)) liveQuizList = normalizeQuizList(data.message);
      })
      .catch(() => { /* use the last list seen */ })
      .then(() => {
        goingToNextQuiz = false;
        const { id, order } = chooseNextQuiz(loadNextQuizOrder(), liveQuizList, currentQuizId());
        saveNextQuizOrder(order);
        if (DEBUG) console.log('[helloquiz-timer] next quiz ->', id);
        if (!id) {
          showToast('No other quiz has overdue cards right now.');
          return;
        }
        location.assign('/quiz/' + encodeURIComponent(id) + '?learn');
      });
  }

  // Our button is a copy of the site's → button (same look), put right
  // before it, with its own glyph (how the nav detection tells them apart)
  // and label. The site's → is relabelled "most overdue quiz". Both are
  // re-asserted on every pass in case the site re-renders.
  function ensureNextQuizButton() {
    const mostOverdue = findNavButtonBySymbol(MOST_OVERDUE_SYMBOL);
    if (!mostOverdue) return;
    const label = mostOverdue.querySelector('[class*="expanded"]');
    if (label && label.textContent !== 'most overdue quiz') label.textContent = 'most overdue quiz';

    const parent = mostOverdue.parentElement;
    if (!parent) return;
    let next = parent.querySelector(':scope > button.' + NEXT_QUIZ_CLASS);
    if (!next) {
      next = mostOverdue.cloneNode(true);
      next.classList.add(NEXT_QUIZ_CLASS);
      next.querySelectorAll('kbd.' + KBD_CLASS).forEach((el) => el.remove());
      const nextLabel = next.querySelector('[class*="expanded"]');
      if (nextLabel) nextLabel.textContent = 'next quiz';
      // Swap the → glyph, whether it's still a bare text node or already
      // wrapped for hiding (ensureNavKbdHints).
      const walker = document.createTreeWalker(next, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.data.includes(MOST_OVERDUE_SYMBOL)) node.data = node.data.replace(MOST_OVERDUE_SYMBOL, NEXT_QUIZ_SYMBOL);
      }
      next.addEventListener('click', (e) => {
        e.preventDefault();
        goToNextQuiz();
      });
      invalidateNavScan();
    }
    if (next.nextElementSibling !== mostOverdue) parent.insertBefore(next, mostOverdue);
    // A grid sized for the site's three buttons gets a fourth column.
    for (const cls of Array.from(parent.classList)) {
      const wider = cls.replace(/__buttons_3$/, '__buttons_4');
      if (wider !== cls && !parent.classList.contains(wider)) parent.classList.add(wider);
    }
  }

  // ---------- Nav-button keyboard shortcuts (end-of-quiz screen) ----------

  function findNavButtonBySymbol(symbol) {
    if (!symbol) return null;
    return scanNavButtons()[symbol] || null;
  }

  function onNavKeydown(e) {
    if (!scriptActive) return;
    if (!isAnkiPage()) return;
    if (isTypingInField()) return;

    const symbol = NAV_SYMBOL_BY_KEY[e.key];
    if (!symbol) return;
    if (overlayEl) return; // overlay's own "1" handling takes priority
    if ((e.key === '1' || e.key === '4') && findAgainButton()) return; // grading takes priority

    invalidateNavScan(); // key events run outside a watcher pass - rescan
    const button = findNavButtonBySymbol(symbol);
    if (!button) return;

    e.preventDefault();
    if (DEBUG) console.log('[helloquiz-timer] nav key', e.key, '->', symbol);
    button.click();
  }

  function onEscapeKeydown(e) {
    if (!scriptActive) return;
    if (e.key !== 'Escape') return;
    if (isTypingInField()) return;
    if (location.pathname === '/learn') return; // already there

    e.preventDefault();
    if (DEBUG) console.log('[helloquiz-timer] Escape -> /learn');
    // Prefer clicking an existing /learn link for a smooth SPA transition;
    // fall back to a full navigation if none is on the page.
    const learnLink = document.querySelector('a[href="/learn"]');
    if (learnLink) learnLink.click();
    else location.assign('https://helloquiz.app/learn');
  }

  // ---------- Compact settings tabs (ⓘ / ✖ / ⚙) ----------

  // The compact-mode popover's icon strip: ⓘ info, ✖ close, ⚙ settings.
  // Clicking ✖ closes the whole popover; clicking the already-selected ⓘ or
  // ⚙ tab is a no-op on the site's side instead of also closing it, which
  // reads as the button being stuck. Redirect that click onto the ✖ tab so
  // re-clicking the active tab closes the popover too, the way a toggle
  // button normally would.
  function findTabByGlyph(tabs, glyph) {
    return Array.from(tabs.children).find((el) => el.textContent.trim() === glyph) || null;
  }

  function onCompactSettingsTabClick(e) {
    if (!scriptActive) return;
    const tabs = e.target && e.target.closest && e.target.closest(COMPACT_SETTINGS_TABS_SELECTOR);
    if (!tabs) return;
    const close = findTabByGlyph(tabs, '✖');
    if (!close) return;
    // Only redirect a click that lands on a tab OTHER than close itself, and
    // only when that tab was ALREADY selected before this click - switching
    // between tabs must behave normally, and clicking close is already
    // exactly what we're redirecting to.
    const clickedTab = Array.from(tabs.children).find((el) => el.contains(e.target));
    if (!clickedTab || clickedTab === close || !clickedTab.classList.contains('selected')) return;
    e.stopPropagation();
    e.preventDefault();
    if (DEBUG) console.log('[helloquiz-timer] re-clicked selected settings tab -> closing');
    close.click();
  }

  // ---------- Cards-left box ----------

  // While the compact popover is closed (the site's ✖ tab selected - the
  // default on every page load), show how many cards are left in a box of
  // our own (own element, own class names) where the popover would be. The
  // site's tabs and popover are never touched; ⓘ / ⚙ simply replace the box.
  const CARDS_POPOVER_CLASS = 'hq-cards-popover';

  function cardsLeftText() {
    if (cardsLeft === null) return 'no card data yet';
    return cardsLeft + (cardsLeft === 1 ? ' card left' : ' cards left');
  }

  // The box's second line: how many OTHER quizzes still have overdue cards,
  // from the latest /api/quiz/anki list (null while there is none).
  function countOtherOverdueQuizzes(list, currentId) {
    if (!Array.isArray(list)) return null;
    return list.filter((q) => q && q.id !== currentId && Number(q.overdueCount) > 0).length;
  }

  function otherOverdueQuizzesText(count) {
    if (count === null || count === undefined) return '';
    if (count === 0) return 'no other overdue quizzes';
    return count + (count === 1 ? ' other overdue quiz' : ' other overdue quizzes');
  }

  // The site doesn't fetch the quiz list on a quiz page, so ask for it on
  // every batch of cards the quiz loads; the fetch hook (onAnkiQuizList)
  // picks the response up into liveQuizList.
  let quizListRefreshInFlight = false;

  function refreshLiveQuizList() {
    if (quizListRefreshInFlight) return;
    quizListRefreshInFlight = true;
    fetch('/api/quiz/anki', { credentials: 'same-origin' })
      .catch(() => { /* keep the last list */ })
      .then(() => { quizListRefreshInFlight = false; });
  }

  // The site's popover is a wrapper right next to the tab strip whose class
  // ends in "Selected" (infoSelected / settingsSelected / closedSelected).
  // Matched by that readable ending, not the generated hash.
  function findSitePopover(tabs) {
    const parent = tabs.parentElement;
    if (!parent) return null;
    return Array.from(parent.children).find((el) => el !== tabs &&
      Array.from(el.classList).some((c) => c.startsWith('quiz-module') && /Selected$/.test(c))) || null;
  }

  function removeCardsPopover() {
    document.querySelectorAll('.' + CARDS_POPOVER_CLASS).forEach((el) => el.remove());
  }

  // Styled like the site's own popover content (its info block, and the
  // description paragraph inside it) - at a fixed, narrower width, so the box
  // doesn't resize with the count - copied as inline styles so nothing
  // aimed at the site's classes affects ours.
  const CARDS_POPOVER_CSS = 'position: fixed; z-index: 3; right: 10px; ' +
    'top: calc(var(--top-height) + 30px); display: block; width: 210px; ' +
    'max-width: min(50%, 500px); max-height: calc(100% - 150px); margin: 0; ' +
    'background: var(--bg); color: var(--text); ' +
    'border: 1px solid var(--hl); border-radius: 10px; ' +
    'font-family: Twemoji Country Flags, Inter, Inter Fallback; transition: all .2s ease-in-out;';
  const CARDS_POPOVER_TEXT_CSS = 'margin: 5px auto; max-width: 100%; text-align: center; ' +
    'white-space: wrap; text-overflow: clip; overflow: auto;';
  const CARDS_POPOVER_QUIZZES_CSS = CARDS_POPOVER_TEXT_CSS + ' margin-top: -3px; font-size: 0.85em; opacity: 0.8;';

  function renderCardsPopover(tabs) {
    let popover = document.querySelector('.' + CARDS_POPOVER_CLASS);
    if (!popover) {
      popover = document.createElement('div');
      popover.className = CARDS_POPOVER_CLASS;
      popover.setAttribute('style', CARDS_POPOVER_CSS);
      const text = document.createElement('p');
      text.className = 'hq-cards-popover-text';
      text.setAttribute('style', CARDS_POPOVER_TEXT_CSS);
      popover.appendChild(text);
      const quizzes = document.createElement('p');
      quizzes.className = 'hq-cards-popover-quizzes';
      quizzes.setAttribute('style', CARDS_POPOVER_QUIZZES_CSS);
      popover.appendChild(quizzes);
      if (tabs.parentElement) tabs.parentElement.insertBefore(popover, tabs.nextSibling);
    }
    const text = popover.firstChild;
    if (text.textContent !== cardsLeftText()) text.textContent = cardsLeftText();
    const quizzes = popover.lastChild;
    const quizzesText = otherOverdueQuizzesText(countOtherOverdueQuizzes(liveQuizList, currentQuizId()));
    if (quizzes.textContent !== quizzesText) quizzes.textContent = quizzesText;
    const display = quizzesText ? '' : 'none';
    if (quizzes.style.display !== display) quizzes.style.display = display;
  }

  function ensureCardsPopover() {
    const tabs = document.querySelector(COMPACT_SETTINGS_TABS_SELECTOR);
    if (!tabs) {
      removeCardsPopover();
      return;
    }
    // Closed: the site's wrapper says so, or (should its class ever change)
    // the ✖ tab is the selected one.
    const wrapper = findSitePopover(tabs);
    const close = findTabByGlyph(tabs, '✖');
    const closed = (!!wrapper && /closedSelected$/.test(wrapper.className.trim())) ||
      (!!close && close.classList.contains('selected'));
    if (scriptActive && showCardsLeft && closed) {
      renderCardsPopover(tabs);
    } else {
      removeCardsPopover();
    }
  }

  // ---------- Config UI (injected into the site's settings panel) ----------

  const SETTINGS_BLOCK_CLASS = 'hq-timer-settings-block';
  const FORCECLICK_WARNING_CLASS = 'hq-timer-forceclick-warning';

  // What each row of the config panel actually does - the labels alone are
  // short enough to be guessed wrong. Shown by the row's "?" (see appendHelp).
  const TIMER_TIP = 'Counts down on every question. When it runs out, the card is ' +
    'graded as failed ("again") automatically, so scanning the map for too long ' +
    'costs you the card. Applies to every quiz that has no override of its own.';
  const QUIZ_TIMER_TIP = 'Gives the quiz you have open its own countdown, independent ' +
    'of the default above - handy for quizzes that need noticeably more (or less) ' +
    'time. Untick it to go back to the default.';
  // The auto-grade row's explanation, in the seconds the current thresholds
  // actually work out to - percentages of a countdown are hard to picture.
  function autoGradeTip() {
    const seconds = effectiveSeconds();
    const at = (percent) => (seconds * percent / 100).toFixed(1).replace(/\.0$/, '') + 's';
    return 'Grades a correct answer for you, from how much of the countdown was left: ' +
      'easy from ' + autoGradeEasy + '% up, good from ' + autoGradeGood + '% up, hard below that. ' +
      'With the current ' + seconds + 's countdown that means easy up to ' + at(100 - autoGradeEasy) +
      ', good up to ' + at(100 - autoGradeGood) + ', hard after that. Answering too slowly still ' +
      'counts as failed ("again"). Needs the countdown to be on.';
  }

  const PAUSE_TIP = 'After a wrong answer (or a timeout) the quiz stops on the question ' +
    'you just missed, so you can study the map before moving on. Click the map or ' +
    'press 1 to continue. Replaces the site\'s "force correct click", which is broken ' +
    'on city quizzes.';

  const CARDS_TIP = 'While the quiz info / settings popover is closed (the \u2716 tab), ' +
    'shows how many cards are still coming in this quiz, and how many other quizzes still ' +
    'have overdue cards. Each answered card is ' +
    'counted again once the interval its grading button showed has passed (5 minutes ' +
    'for a wrong answer on the map). Starts fresh when you reopen the quiz.';

  function findSiteSettingsContainer() {
    return document.querySelector('[class*="anki-settings-module"]');
  }

  // Show a warning while the site's "force correct click" and our pause mode
  // are both on — that combination is currently broken for city quizzes.
  function updateForceClickWarning() {
    const warning = document.querySelector('.' + FORCECLICK_WARNING_CLASS);
    if (!warning) return;
    const forceCb = document.getElementById('forceClick');
    const forceOn = !!(forceCb && forceCb.checked);
    warning.style.display = (forceOn && reviewPause) ? 'block' : 'none';
  }

  function removeSettingsPanel() {
    document.querySelectorAll('.' + SETTINGS_BLOCK_CLASS).forEach((el) => el.remove());
  }

  // Add our options to the bottom of the site's own anki settings panel, so
  // they inherit the site's styling. Rebuilt whenever the settings panel is
  // (re-)rendered; the module-level state variables are the source of truth
  // for the control values, so a rebuild always reflects the current config.
  function ensureSettingsPanel() {
    const container = findSiteSettingsContainer();
    if (!container) return;
    const existing = container.querySelector('.' + SETTINGS_BLOCK_CLASS);
    if (existing) {
      // Rebuild if the quiz changed since we built the panel, so the per-quiz
      // override row tracks the current quiz (and appears once its title is
      // known - the panel can be built a tick before the title is detected).
      if (existing.dataset.hqQuiz === currentQuizTitle) return;
      existing.remove();
    }

    const block = document.createElement('div');
    block.className = SETTINGS_BLOCK_CLASS;
    block.dataset.hqQuiz = currentQuizTitle;

    // Separator from the site's own settings above. Inline styles because
    // the site's CSS resets <hr> to no border (renders as an invisible
    // 0-height line otherwise).
    const separator = document.createElement('hr');
    separator.style.cssText = 'border: none; border-top: 1px solid currentColor; opacity: 0.3; margin: 10px 0;';

    // Heading with a link to the script's repo
    const heading = document.createElement('p');
    const strong = document.createElement('strong');
    strong.textContent = 'Anki Turbo Config';
    heading.appendChild(strong);
    heading.appendChild(document.createTextNode(' '));
    const repoLink = document.createElement('a');
    repoLink.href = 'https://github.com/jakobkogler/helloquiz-app';
    repoLink.target = '_blank';
    repoLink.rel = 'noopener';
    repoLink.textContent = '(GitHub)';
    heading.appendChild(repoLink);

    // Restart the running countdown so a duration change takes effect at once.
    const restartTimer = () => {
      const c = findMapContainer();
      if (running && c) startTimer(c);
    };

    // Set by the per-quiz and auto-grade rows below, so the global on/off
    // toggle can re-sync their enabled state (neither means anything without
    // a countdown to go by).
    let refreshQuizRow = null;
    let refreshAutoGradeRow = null;

    // Global timer on/off + default duration (the seconds input greys out
    // while off). This duration applies to every quiz that has no override.
    const timerP = document.createElement('p');

    const enabledLabel = document.createElement('label');
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = running;
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode(' enable timer countdown '));

    const secInput = document.createElement('input');
    secInput.type = 'number';
    secInput.className = NUM_CLASS;
    secInput.min = '1';
    secInput.step = '1';
    secInput.value = String(TIMER_SECONDS);
    secInput.disabled = !running;
    secInput.addEventListener('change', () => {
      const val = parseFloat(secInput.value);
      if (!isNaN(val) && val > 0) {
        TIMER_SECONDS = val;
        saveSettings();
        // The auto-grade explanation quotes the duration in seconds.
        if (refreshAutoGradeRow) refreshAutoGradeRow();
        // Only restart when this default is what the current quiz actually
        // uses; a quiz with its own override is unaffected by the default.
        if (!hasQuizOverride(currentQuizTitle)) restartTimer();
      } else {
        secInput.value = String(TIMER_SECONDS);
      }
    });

    enabledCheckbox.addEventListener('change', () => {
      running = enabledCheckbox.checked;
      saveSettings();
      secInput.disabled = !running;
      // Neither the quiz-specific override nor auto-grading makes sense while
      // the countdown is off.
      if (refreshQuizRow) refreshQuizRow();
      if (refreshAutoGradeRow) refreshAutoGradeRow();
      const c = findMapContainer();
      if (running) {
        if (c) startTimer(c);
      } else {
        clearTimer();
        timedOut = false;
        resetBarIdle();
      }
    });

    timerP.appendChild(enabledLabel);
    timerP.appendChild(secInput);
    timerP.appendChild(document.createTextNode(' s'));
    appendHelp(timerP, TIMER_TIP);

    // Per-quiz override: only shown while a quiz is open. Ticking it gives the
    // current quiz its own duration; unticking drops back to the global
    // default above.
    const quizP = document.createElement('p');
    if (currentQuizTitle) {
      const quizTitle = currentQuizTitle; // capture for the handlers below

      const overrideLabel = document.createElement('label');
      const overrideCheckbox = document.createElement('input');
      overrideCheckbox.type = 'checkbox';
      overrideCheckbox.checked = hasQuizOverride(quizTitle);
      overrideLabel.appendChild(overrideCheckbox);
      overrideLabel.appendChild(document.createTextNode(' quiz timer override '));

      const quizSecInput = document.createElement('input');
      quizSecInput.type = 'number';
      quizSecInput.className = NUM_CLASS;
      quizSecInput.min = '1';
      quizSecInput.step = '1';
      quizSecInput.value = String(hasQuizOverride(quizTitle) ? perQuizSeconds[quizTitle] : TIMER_SECONDS);
      quizSecInput.disabled = !overrideCheckbox.checked;

      const refreshRow = () => {
        const on = hasQuizOverride(quizTitle);
        overrideCheckbox.checked = on;
        // Greyed out entirely when the global countdown is off - there's no
        // timer to give a quiz-specific duration to.
        overrideCheckbox.disabled = !running;
        quizSecInput.disabled = !on || !running;
        quizSecInput.value = String(on ? perQuizSeconds[quizTitle] : TIMER_SECONDS);
      };
      refreshQuizRow = refreshRow;

      overrideCheckbox.addEventListener('change', () => {
        if (overrideCheckbox.checked) {
          // Seed the override from whatever the input currently shows (the
          // global default), so enabling it doesn't change the duration until
          // the user edits it.
          const val = parseFloat(quizSecInput.value);
          perQuizSeconds[quizTitle] = (!isNaN(val) && val > 0) ? val : TIMER_SECONDS;
        } else {
          delete perQuizSeconds[quizTitle];
        }
        saveSettings();
        refreshRow();
        if (refreshAutoGradeRow) refreshAutoGradeRow();
        restartTimer();
      });

      quizSecInput.addEventListener('change', () => {
        const val = parseFloat(quizSecInput.value);
        if (!isNaN(val) && val > 0) {
          perQuizSeconds[quizTitle] = val;
          saveSettings();
          if (refreshAutoGradeRow) refreshAutoGradeRow();
          restartTimer();
        } else {
          quizSecInput.value = String(hasQuizOverride(quizTitle) ? perQuizSeconds[quizTitle] : TIMER_SECONDS);
        }
      });

      quizP.appendChild(overrideLabel);
      quizP.appendChild(quizSecInput);
      quizP.appendChild(document.createTextNode(' s'));
      appendHelp(quizP, QUIZ_TIMER_TIP);
      refreshRow();
    }

    // Auto-grade: a correct answer grades itself from the leftover countdown,
    // with the two thresholds (in percent of the countdown) side by side.
    const autoP = document.createElement('p');

    const autoLabel = document.createElement('label');
    const autoCheckbox = document.createElement('input');
    autoCheckbox.type = 'checkbox';
    autoCheckbox.checked = autoGrade;
    autoLabel.appendChild(autoCheckbox);
    autoLabel.appendChild(document.createTextNode(' auto-grade by speed: easy '));

    const makePercentInput = (value) => {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = NUM_CLASS;
      input.min = '1';
      input.max = '99';
      input.step = '1';
      input.value = String(value);
      return input;
    };
    const easyInput = makePercentInput(autoGradeEasy);
    const goodInput = makePercentInput(autoGradeGood);

    // The explanation spells the thresholds out in seconds, so it has to be
    // rebuilt whenever they change.
    const autoHelp = makeHelp(autoGradeTip());

    const refreshAutoRow = () => {
      autoCheckbox.checked = autoGrade;
      // Without a countdown there's nothing to measure the answer against.
      autoCheckbox.disabled = !running;
      easyInput.disabled = !autoGrade || !running;
      goodInput.disabled = !autoGrade || !running;
      // Also rewrites an input whose edit was rejected below.
      easyInput.value = String(autoGradeEasy);
      goodInput.value = String(autoGradeGood);
      autoHelp.body.textContent = autoGradeTip();
    };
    refreshAutoGradeRow = refreshAutoRow;

    autoCheckbox.addEventListener('change', () => {
      autoGrade = autoCheckbox.checked;
      saveSettings();
      refreshAutoRow();
    });

    // The two thresholds have to stay ordered: with "easy" at or below "good"
    // one of the two grades could never be awarded.
    easyInput.addEventListener('change', () => {
      const val = parseFloat(easyInput.value);
      if (!isNaN(val) && val > autoGradeGood && val < 100) {
        autoGradeEasy = val;
        saveSettings();
      }
      refreshAutoRow();
    });

    goodInput.addEventListener('change', () => {
      const val = parseFloat(goodInput.value);
      if (!isNaN(val) && val > 0 && val < autoGradeEasy) {
        autoGradeGood = val;
        saveSettings();
      }
      refreshAutoRow();
    });

    autoP.appendChild(autoLabel);
    autoP.appendChild(easyInput);
    autoP.appendChild(document.createTextNode(' % / good '));
    autoP.appendChild(goodInput);
    autoP.appendChild(document.createTextNode(' %'));
    autoP.appendChild(autoHelp.badge);
    autoP.appendChild(autoHelp.body);
    refreshAutoRow();

    // Pause after a wrong answer (review) vs. jump straight to the next one
    const pauseP = document.createElement('p');
    const pauseLabel = document.createElement('label');
    const pauseCheckbox = document.createElement('input');
    pauseCheckbox.type = 'checkbox';
    pauseCheckbox.checked = reviewPause;
    pauseCheckbox.addEventListener('change', () => {
      reviewPause = pauseCheckbox.checked;
      saveSettings();
      // If the pause is switched off while a review overlay is up, continue
      // immediately instead of leaving the user stuck on it.
      if (!reviewPause && overlayEl && !proceedFromOverlay()) {
        // No question to continue to yet: drop the overlay anyway, or it would
        // keep swallowing map clicks. The question starts on its own once the
        // quiz renders it, since the pause is off now.
        hideReviewOverlay();
        pendingReview = false;
      }
      updateForceClickWarning();
    });
    pauseLabel.appendChild(pauseCheckbox);
    pauseLabel.appendChild(document.createTextNode(' pause after mistakes'));
    pauseP.appendChild(pauseLabel);
    appendHelp(pauseP, PAUSE_TIP);

    // Show the cards-left tab in the compact popover's strip
    const cardsP = document.createElement('p');
    const cardsLabel = document.createElement('label');
    const cardsCheckbox = document.createElement('input');
    cardsCheckbox.type = 'checkbox';
    cardsCheckbox.checked = showCardsLeft;
    cardsCheckbox.addEventListener('change', () => {
      showCardsLeft = cardsCheckbox.checked;
      saveSettings();
      ensureCardsPopover();
    });
    cardsLabel.appendChild(cardsCheckbox);
    cardsLabel.appendChild(document.createTextNode(' show cards left'));
    cardsP.appendChild(cardsLabel);
    appendHelp(cardsP, CARDS_TIP);

    // Warning shown only when "force correct click" and pause mode are both on.
    const warning = document.createElement('p');
    warning.className = FORCECLICK_WARNING_CLASS;
    warning.textContent = 'For city quizzes the "force correct click" mode is currently broken. Disable it if you want to use the "pause after mistakes" mode instead.';
    warning.style.cssText = 'display:none; margin-top:6px; padding:6px 8px; border:1px solid #e0a800; border-radius:4px; background:rgba(255,193,7,0.15); font-size:0.9em;';

    block.appendChild(separator);
    block.appendChild(heading);
    block.appendChild(timerP);
    if (currentQuizTitle) block.appendChild(quizP);
    block.appendChild(autoP);
    block.appendChild(pauseP);
    block.appendChild(cardsP);
    block.appendChild(warning);
    container.appendChild(block);
    updateForceClickWarning();
  }

  // ---------- Update notice (on /learn) ----------

  // The userscript manager updates from @updateURL on its own schedule, and
  // silently. Check the published script every 3 hours as well, and say so
  // on the quiz list when a newer version is out. Never inside a quiz.
  // The check time is shared by all tabs (localStorage); a version the user
  // dismissed stays quiet until an even newer one comes out.
  const UPDATE_STATE_KEY = 'hq-update-check';
  const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000;
  const UPDATE_BANNER_CLASS = 'hq-update-banner';
  let updateCheckInFlight = false;

  function parseScriptVersion(text) {
    const m = /^\/\/\s*@version\s+(\S+)/m.exec(String(text || ''));
    return m ? m[1] : null;
  }

  // Numeric, part by part: 1.10.0 > 1.9.0. Missing parts count as 0.
  function compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  function loadUpdateState() {
    try {
      const data = JSON.parse(localStorage.getItem(UPDATE_STATE_KEY) || 'null');
      if (data && typeof data === 'object') return data;
    } catch (e) { /* corrupted or unavailable */ }
    return {};
  }

  function saveUpdateState(state) {
    try {
      localStorage.setItem(UPDATE_STATE_KEY, JSON.stringify(state));
    } catch (e) { /* not critical */ }
  }

  function checkForUpdate() {
    updateCheckInFlight = true;
    // Record the attempt first, so a failing check doesn't retry every pass
    // (nor in every other tab).
    saveUpdateState(Object.assign(loadUpdateState(), { checkedAt: Date.now() }));
    fetch(UPDATE_URL + '?t=' + Date.now(), { cache: 'no-store' })
      .then((res) => (res.ok ? res.text() : null))
      .then((text) => {
        const latest = parseScriptVersion(text);
        if (latest) saveUpdateState(Object.assign(loadUpdateState(), { latest: latest }));
        if (DEBUG) console.log('[helloquiz-timer] update check: latest', latest, 'installed', SCRIPT_VERSION);
      })
      .catch(() => { /* offline etc. - try again next interval */ })
      .then(() => { updateCheckInFlight = false; });
  }

  function removeUpdateBanner() {
    document.querySelectorAll('.' + UPDATE_BANNER_CLASS).forEach((el) => el.remove());
  }

  function ensureUpdateNotice() {
    if (location.pathname !== '/learn') {
      removeUpdateBanner();
      return;
    }
    const state = loadUpdateState();
    if (!updateCheckInFlight && !(Date.now() - (state.checkedAt || 0) < UPDATE_CHECK_INTERVAL_MS)) {
      checkForUpdate();
    }
    const show = !!state.latest && compareVersions(state.latest, SCRIPT_VERSION) > 0 &&
      state.dismissed !== state.latest;
    if (!show) {
      removeUpdateBanner();
      return;
    }
    if (document.querySelector('.' + UPDATE_BANNER_CLASS)) return;

    const banner = document.createElement('div');
    banner.className = UPDATE_BANNER_CLASS;
    banner.style.cssText = BANNER_CSS + 'user-select: text;';
    const link = (text, href) => {
      const a = document.createElement('a');
      a.textContent = text;
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.style.cssText = 'color: #9cf; margin-left: 10px;';
      return a;
    };
    banner.appendChild(document.createTextNode(
      'Anki Turbo ' + state.latest + ' is available (you have ' + SCRIPT_VERSION + ').'));
    // Opening the raw script makes the userscript manager offer the update.
    banner.appendChild(link('update', UPDATE_URL));
    banner.appendChild(link('changelog', CHANGELOG_URL));
    const dismiss = link('dismiss', '#');
    dismiss.removeAttribute('target');
    dismiss.addEventListener('click', (e) => {
      e.preventDefault();
      saveUpdateState(Object.assign(loadUpdateState(), { dismissed: state.latest }));
      removeUpdateBanner();
    });
    banner.appendChild(dismiss);
    document.body.appendChild(banner);
  }

  // ---------- Card browser ----------

  // /quiz/<id>/browse: a page of our own (the site serves its 404 there)
  // that lists a quiz's cards, searches them and can "punish" any card -
  // rate it again (1) right away, so anki brings it back soon. Found you
  // forgot an area code while playing elsewhere? Look it up, punish it.

  function browseQuizIdFromPath(pathname) {
    const m = /^\/quiz\/([^/]+)\/browse\/?$/.exec(String(pathname || ''));
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Lower case, accents removed: "München" -> "munchen".
  function normalizeSearchText(text) {
    return String(text === null || text === undefined ? '' : text)
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  // Every word of the query has to appear in the question. Answers and
  // hints aren't searched (nor shown): they're mostly geojson references or
  // coordinates, so matching them would turn up cards for no visible reason.
  function cardMatchesQuery(card, query) {
    const words = normalizeSearchText(query).split(/\s+/).filter(Boolean);
    if (!words.length) return true;
    const question = normalizeSearchText(card.question);
    return words.every((word) => question.includes(word));
  }

  // Image quizzes keep the picture's URL in the question. Shown as a
  // thumbnail instead of the URL: anything the format marks as an image,
  // and any single-token absolute URL, data: image or image path.
  function isImageQuestion(card) {
    if (typeof card.questionFormat === 'string' && /image/i.test(card.questionFormat)) return true;
    const q = String(card.question === null || card.question === undefined ? '' : card.question).trim();
    if (!q || /\s/.test(q)) return false;
    if (/^data:image\//i.test(q) || /^(https?:)?\/\//i.test(q)) return true;
    return /^\/\S+\.(png|jpe?g|gif|webp|svg|avif)(\?\S*)?$/i.test(q);
  }

  // Natural order: "2" before "10".
  function compareCardsByQuestion(a, b) {
    const text = (card) => String(card.question === null || card.question === undefined ? '' : card.question).trim();
    return text(a).localeCompare(text(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  // A guess for any card of the quiz is accepted with the quiz's play id
  // and an empty loadId (verified 2026-10-04). The play id ends in spaces,
  // so it must be encoded, not trimmed.
  function buildPunishRequest(playId, card) {
    return {
      url: '/api/game/' + encodeURIComponent(playId) + '/question/' + encodeURIComponent(card.id) + '/guess',
      init: {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ guess: card.answer === null || card.answer === undefined ? '' : String(card.answer), loadId: '', rating: 1 }),
      },
    };
  }

  // Whether the quiz is in the user's anki deck (GET /api/quiz/anki); null
  // when the list is unusable. Only cards of a quiz in the deck have anki
  // state to punish.
  function isQuizInDeck(list, quizId) {
    if (!Array.isArray(list)) return null;
    return list.some((q) => q && q.id === quizId && !q.deletedAt);
  }

  // A card's punish state: undefined (never), 'pending', 'done' or
  // { error }. Only the first and the last may send (again).
  function shouldSendPunish(state) {
    return state !== 'pending' && state !== 'done';
  }

  // Same-origin JSON request to the site's API; resolves with `message`.
  // The browser sends the session cookies like for the site's own calls.
  function fetchApiMessage(url, init) {
    return fetch(url, Object.assign({ credentials: 'same-origin' }, init || {}))
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status))))
      .then((data) => {
        if (!data || data.error !== false || data.message === undefined) throw new Error('unexpected response');
        return data.message;
      });
  }

  const NO_PLAY_ERROR = "couldn't start a game for this quiz";

  // The quiz's play id, from its anki queue (or the ?more card when nothing
  // is due). Asked for once per page; a failure is retried on the next punish.
  function getBrowsePlayId(state) {
    if (!state.playIdPromise) {
      const base = '/api/quiz/' + encodeURIComponent(state.quizId) + '/anki/question';
      const firstPlay = (list) => (Array.isArray(list) && list[0] && typeof list[0].play === 'string' &&
        list[0].play.trim() !== '' ? list[0].play : null);
      state.playIdPromise = fetchApiMessage(base).then(firstPlay).catch(() => null)
        .then((play) => play || fetchApiMessage(base + '?more').then(firstPlay).catch(() => null))
        .then((play) => {
          if (!play) {
            state.playIdPromise = null;
            throw new Error(NO_PLAY_ERROR);
          }
          return play;
        });
    }
    return state.playIdPromise;
  }

  function punishBrowseCard(state, card) {
    if (!shouldSendPunish(state.punished[card.id])) return;
    state.punished[card.id] = 'pending';
    renderBrowseList(state);
    getBrowsePlayId(state)
      .then((play) => {
        const { url, init } = buildPunishRequest(play, card);
        return fetchApiMessage(url, init).catch((e) => {
          throw new Error('punishing failed (' + (e && e.message ? e.message : 'error') + ')');
        });
      })
      .then(() => { state.punished[card.id] = 'done'; },
        (e) => { state.punished[card.id] = { error: e && e.message ? e.message : NO_PLAY_ERROR }; })
      .then(() => renderBrowseList(state));
  }

  const BROWSE_ROOT_CLASS = 'hq-browse';
  let browseState = null; // the open browse page, see startBrowse()

  function makeEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function startBrowse(quizId) {
    const root = makeEl('div', BROWSE_ROOT_CLASS);
    const heading = makeEl('h1', 'hq-browse-title');
    const links = makeEl('p', 'hq-browse-links');
    const link = (text, href) => {
      const a = makeEl('a', '', text);
      a.href = href;
      return a;
    };
    const quizPath = '/quiz/' + encodeURIComponent(quizId);
    links.append(link('anki mode', quizPath + '?learn'), ' · ', link('normal', quizPath), ' · ', link('back to the list', '/learn'));
    const explain = makeEl('p', 'hq-browse-explain',
      'Forgot a card outside of your reviews - say an area code while playing GeoGuessr? Find it here and ' +
      'press punish: the card is graded "again", exactly as if you had failed it in the anki mode. It comes back ' +
      'in your next review (about 5 minutes from now) and its interval starts over. This can\'t be undone, ' +
      'but the only effect is that you see the card sooner and more often until you know it again.');
    const notInDeck = makeEl('p', 'hq-browse-explain');
    notInDeck.append('This quiz isn\'t in your anki deck, so there is nothing to punish here. Add it to your ' +
      'deck on the ', link('quiz page', quizPath), ' first.');
    const status = makeEl('p', 'hq-browse-status');
    const retry = makeEl('button', 'hq-browse-retry', 'retry');
    retry.type = 'button';
    const tools = makeEl('p', 'hq-browse-tools');
    const search = makeEl('input', 'hq-browse-search');
    search.type = 'search';
    search.placeholder = 'search the questions';
    const count = makeEl('span', 'hq-browse-count');
    tools.append(search, ' ', count);
    // One cell per card (question + punish), as many columns as fit.
    const grid = makeEl('div', 'hq-browse-grid');
    root.append(heading, links, explain, notInDeck, status, retry, tools, grid);

    const state = {
      quizId: quizId, root: root, heading: heading, explain: explain, notInDeck: notInDeck,
      // true / false once the deck list is in; 'unknown' when it couldn't be
      // loaded (buttons shown then); undefined while loading (buttons hidden).
      inDeck: undefined,
      status: status, retry: retry,
      tools: tools, search: search, count: count, grid: grid,
      title: quizId, cards: null, phase: 'loading', punished: {}, playIdPromise: null, focused: false,
    };
    search.addEventListener('input', () => renderBrowseList(state));
    retry.addEventListener('click', () => loadBrowseCards(state));
    browseState = state;
    loadBrowseCards(state);
    fetchApiMessage('/api/quiz/anki')
      .then((list) => {
        const inDeck = isQuizInDeck(list, quizId);
        state.inDeck = inDeck === null ? 'unknown' : inDeck;
      }, () => { state.inDeck = 'unknown'; })
      .then(() => renderBrowse(state));
    // The quiz's own details (any quiz, also one that was never played in
    // anki mode - so not from the deck list).
    fetchApiMessage('/api/quiz/' + encodeURIComponent(quizId))
      .then((quiz) => {
        if (quiz && typeof quiz.title === 'string' && quiz.title.trim() !== '') {
          state.title = quiz.title;
          renderBrowse(state);
        }
      })
      .catch(() => { /* keep the id as the title */ });
  }

  function loadBrowseCards(state) {
    state.phase = 'loading';
    renderBrowse(state);
    fetchApiMessage('/api/quiz/' + encodeURIComponent(state.quizId) + '/question')
      .then((cards) => {
        if (!Array.isArray(cards)) throw new Error('unexpected response');
        state.cards = cards.filter((c) => c && typeof c.id === 'string').sort(compareCardsByQuestion);
        state.phase = 'ready';
      })
      .catch(() => { state.phase = 'error'; })
      .then(() => renderBrowse(state));
  }

  function renderBrowse(state) {
    state.heading.textContent = 'Browse cards: ' + state.title;
    state.explain.style.display = state.inDeck === false ? 'none' : '';
    state.notInDeck.style.display = state.inDeck === false ? '' : 'none';
    const statusText = state.phase === 'loading' ? 'Loading cards…'
      : state.phase === 'error' ? "Couldn't load the cards for this quiz."
        : state.cards.length === 0 ? 'This quiz has no cards.' : '';
    state.status.textContent = statusText;
    state.status.style.display = statusText ? '' : 'none';
    state.retry.style.display = state.phase === 'error' ? '' : 'none';
    const ready = state.phase === 'ready' && state.cards.length > 0;
    state.tools.style.display = ready ? '' : 'none';
    state.grid.style.display = ready ? '' : 'none';
    if (ready) renderBrowseList(state);
  }

  function renderBrowseList(state) {
    if (!state.cards) return;
    const query = state.search.value;
    const shown = state.cards.filter((card) => cardMatchesQuery(card, query));
    state.count.textContent = query.trim()
      ? shown.length + ' of ' + state.cards.length + ' cards'
      : state.cards.length + ' cards';
    const canPunish = state.inDeck === true || state.inDeck === 'unknown';
    const cells = shown.map((card) => {
      const cell = makeEl('div', 'hq-browse-card');
      const questionCell = makeEl('div', 'hq-browse-question');
      if (isImageQuestion(card)) {
        const src = String(card.question).trim();
        const open = makeEl('a');
        open.href = src;
        open.target = '_blank';
        open.rel = 'noopener';
        const img = makeEl('img', 'hq-browse-image');
        img.src = src;
        img.alt = '';
        img.loading = 'lazy';
        open.appendChild(img);
        questionCell.appendChild(open);
      } else {
        questionCell.textContent = card.question === null || card.question === undefined ? '' : String(card.question);
      }
      cell.appendChild(questionCell);
      if (!canPunish) return cell;
      const action = makeEl('div', 'hq-browse-action');
      const punish = state.punished[card.id];
      const button = makeEl('button', 'hq-punish',
        punish === 'pending' ? 'punishing…' : punish === 'done' ? 'punished ✓' : 'punish');
      button.type = 'button';
      button.disabled = !shouldSendPunish(punish);
      button.addEventListener('click', () => punishBrowseCard(state, card));
      action.appendChild(button);
      if (punish && punish.error) action.appendChild(makeEl('span', 'hq-browse-error', ' ' + punish.error));
      cell.appendChild(action);
      return cell;
    });
    state.grid.replaceChildren(...cells);
  }

  // Called on every poll pass, on every page (not only anki pages): shows
  // our page on /quiz/<id>/browse - in place of the site's 404 block, under
  // its header - and puts it back if the site re-renders; tears it down
  // anywhere else.
  function ensureBrowsePage() {
    const quizId = browseQuizIdFromPath(location.pathname);
    if (!quizId) {
      if (browseState) {
        browseState.root.remove();
        browseState = null;
      }
      document.documentElement.classList.remove(BROWSE_HTML_CLASS);
      return;
    }
    document.documentElement.classList.add(BROWSE_HTML_CLASS);
    if (!browseState || browseState.quizId !== quizId) {
      if (browseState) browseState.root.remove();
      startBrowse(quizId);
    }
    const state = browseState;
    const notFound = document.querySelector('h1.next-error-h1');
    const notFoundBlock = notFound && notFound.closest('main > div');
    if (notFoundBlock && notFoundBlock.style.display !== 'none') notFoundBlock.style.display = 'none';
    if (!state.root.isConnected) {
      const main = document.querySelector('main') || document.body;
      main.insertBefore(state.root, main.firstChild);
      if (!state.focused) {
        state.search.focus();
        state.focused = true;
      }
    }
    const title = 'Browse cards: ' + state.title;
    if (document.title !== title) document.title = title;
  }

  const BROWSE_LINK_CLASS = 'hq-browse-link';

  // The quiz id on a normal (non-anki) quiz page, /quiz/<id> without
  // ?learn; null anywhere else (/quiz/new is the remix editor).
  function normalQuizIdFromLocation(pathname, search) {
    const m = /^\/quiz\/([^/]+)\/?$/.exec(String(pathname || ''));
    if (!m || m[1] === 'new') return null;
    if (new URLSearchParams(search || '').has('learn')) return null;
    return decodeURIComponent(m[1]);
  }

  const ANKI_LINK_CLASS = 'hq-anki-link';

  // The normal quiz page isn't an anki page, so the anki features (and with
  // them ensureQuizLink) are off there; this one runs on every page and
  // gives the title's action list the counterpart of the anki page's
  // [normal quiz / browse cards / ...]:
  // [anki mode / browse cards / remixes / new remix / ...]. On the anki page
  // ensureQuizLink owns the browse link instead, and the anki link goes away
  // (the title can survive in-app navigation between the two).
  function ensureNormalQuizBrowseLink() {
    const quizId = normalQuizIdFromLocation(location.pathname, location.search);
    if (!quizId) {
      document.querySelectorAll('a.' + ANKI_LINK_CLASS).forEach((el) => {
        const sep = el.nextSibling;
        if (sep && sep.nodeType === Node.TEXT_NODE && sep.textContent === ' / ') sep.remove();
        el.remove();
      });
      return;
    }
    const actions = findTitleActionsEl();
    if (!actions) return;
    const quizPath = '/quiz/' + encodeURIComponent(quizId);
    let link = actions.querySelector('a.' + BROWSE_LINK_CLASS);
    if (!link) {
      const first = actions.querySelector('a');
      if (!first) return; // unexpected markup - leave the line alone
      link = document.createElement('a');
      link.className = BROWSE_LINK_CLASS;
      link.textContent = 'browse cards';
      actions.insertBefore(link, first);
      actions.insertBefore(document.createTextNode(' / '), first);
    }
    if (link.getAttribute('href') !== quizPath + '/browse') link.setAttribute('href', quizPath + '/browse');
    let anki = actions.querySelector('a.' + ANKI_LINK_CLASS);
    if (!anki) {
      anki = document.createElement('a');
      anki.className = ANKI_LINK_CLASS;
      anki.textContent = 'anki mode';
      actions.insertBefore(anki, link);
      actions.insertBefore(document.createTextNode(' / '), link);
    }
    if (anki.getAttribute('href') !== quizPath + '?learn') anki.setAttribute('href', quizPath + '?learn');
  }

  // "(play in: anki mode | normal)" -> "(play in: anki mode | normal | browse)"
  function ensureBrowseListLinks() {
    const table = findQuizListTable();
    if (!table) return;
    table.querySelectorAll('tbody tr').forEach((row) => {
      const links = row.querySelector('[class*="quizLinks"]');
      if (!links || links.querySelector('a.' + BROWSE_LINK_CLASS)) return;
      const learn = row.querySelector('a[href*="?learn"]');
      const m = learn && /^\/quiz\/([^/?#]+)/.exec(learn.getAttribute('href') || '');
      if (!m) return;
      const close = links.lastChild;
      if (!close || close.nodeType !== Node.TEXT_NODE || !close.data.includes(')')) return; // unexpected markup
      const link = document.createElement('a');
      link.className = BROWSE_LINK_CLASS;
      link.href = '/quiz/' + m[1] + '/browse';
      link.textContent = 'browse';
      links.insertBefore(document.createTextNode(' | '), close);
      links.insertBefore(link, close);
    });
  }

  // ---------- Init ----------

  function init() {
    installConsoleHook();
    installMirrorObserver();
    installHistoryHook();
    document.addEventListener('click', onNavPauseClick, true);
    document.addEventListener('click', onHintDisplayClick, true);
    document.addEventListener('click', onPossibleNavClick, true);
    document.addEventListener('click', onReviewMapClickBlock, true);
    document.addEventListener('click', onCompactSettingsTabClick, true);
    document.addEventListener('click', onGradingButtonClick, true);
    document.addEventListener('pointerdown', onNavPausePointerDown, true);
    document.addEventListener('pointerdown', onReviewPointerDown, true);
    document.addEventListener('pointerup', onReviewPointerUp, true);
    document.addEventListener('keydown', onOverlayKeydown, true);
    document.addEventListener('keydown', onNavKeydown, true);
    document.addEventListener('keydown', onQuizListKeydown, true);
    document.addEventListener('keydown', onEscapeKeydown, true);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    window.addEventListener('storage', onStorageChange);
    setInterval(() => {
      // Hidden tab: nothing visible to maintain; the refocus pass in
      // onVisibilityChange catches up when the tab comes back.
      if (document.hidden) return;
      pollPass();
    }, 200);
    ensureBrowsePage();
  }

  // One full maintenance pass. Runs every 200ms while the tab is visible,
  // and once immediately when the tab becomes visible again.
  function pollPass() {
    // Not anki pages, so these have to run before the anki-page gate below.
    ensureBrowsePage();
    ensureNormalQuizBrowseLink();
    // Runtime page check: SPA navigation can move us to non-anki pages
    // where all features must stay off.
    setActive(isAnkiPage());
    if (!scriptActive) return;

    invalidateNavScan();
    ensureListKbdHints();
    ensureBrowseListLinks();
    ensureOpenDueButton();
    ensureUpdateNotice();
    ensureNavKbdHints();
    ensureQuizLink();
    ensureSettingsPanel();
    ensureCardsPopover();
    updateForceClickWarning();
    ensureHideStyle();
    hideQuestion(); // re-assert the <html> class in case it was stripped
    ensureMirror();
    watchForQuizChange();
    watchForNewQuestion();
    watchForGradingButtons();
    watchForNavButtons();
    // After the watchers: the hint sync learns from / enforces against the
    // mirror, which the watchers above may just have updated.
    watchDisplayedQuestion();
    ensureHintMirror();
    ensureFallbackHintLine();
  }

  // Install the network hooks immediately (document-start): the quiz data
  // is fetched before DOMContentLoaded, so hooking inside init() would miss
  // the question-list response that carries the hints.
  installFetchHook();
  installXhrHook();
  installPromptHook();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

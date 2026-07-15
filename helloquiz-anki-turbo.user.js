// ==UserScript==
// @name         HelloQuiz Anki Turbo
// @namespace    https://github.com/jakobkogler/helloquiz-app
// @version      1.3.4
// @description  Anki mode enhancements for helloquiz.app: a per-question countdown that auto-fails cards you find too slowly, a review pause after mistakes (study the map, continue on click), and keyboard shortcuts with visual key hints.
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
  // End-of-quiz navigation buttons: the symbol identifying each button in
  // the DOM and the keyboard shortcut bound to it. Single source of truth
  // for click detection, keyboard handling, and the kbd badges.
  const NAV_BUTTONS = [
    { key: '1', symbol: '▶' }, // practice more (continues in the same quiz)
    { key: '2', symbol: '⇋' }, // select quiz
    { key: '3', symbol: '→' }, // next quiz
  ];
  const NAV_SYMBOL_BY_KEY = Object.fromEntries(NAV_BUTTONS.map((b) => [b.key, b.symbol]));
  const PRACTICE_MORE_SYMBOL = NAV_BUTTONS[0].symbol;
  const STORAGE_KEY = 'helloquiz-anki-timer-settings';

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
    return document.querySelector('.quiz-module__HPadfW__mapQuiz');
  }

  function findMapContainer() {
    return document.querySelector('.map-quiz-module__gooF1W__map');
  }

  function findQuestionEl() {
    return document.querySelector('.quiz-module__HPadfW__content h2:not(.' + MIRROR_CLASS + ')');
  }

  function findQuizTitleEl() {
    return document.querySelector('.quiz-module__HPadfW__titleText');
  }

  // The container holding the anki grading buttons (again/hard/good/easy)
  function findGradingContainer() {
    return document.querySelector('.generic-quiz-module__m31QtG__controlButtonsAnki');
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
      if (remaining < timerFullSeconds * 0.3) {
        timerBar.style.background = 'crimson';
      }
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

  function startTimer(container) {
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
    timerBar.style.background = 'orange';
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
  const NAVSYM_CLASS = 'hq-timer-navsym'; // wraps the ▶/⇋/→ glyph so we can hide it via CSS
  const NAV_HIDE_CLASS = 'hq-nav-hide';   // hides end-of-quiz nav buttons during the pause
  const TIMER_BAR_CLASS = 'hq-timer-bar'; // marks the injected timer bar (for the mutation filter)
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
    return document.querySelector('.quiz-module__HPadfW__content');
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
  function captureQuestionToMirror(qEl) {
    if (questionHasImage(qEl)) {
      mirrorHTML = qEl.innerHTML;
    } else {
      mirrorHTML = null;
      mirrorText = qEl.textContent;
    }
  }

  // Show a plain-text status in the mirror (e.g. "Click to start"), clearing
  // any image markup left over from a previous image question.
  function setMirrorMessage(text) {
    mirrorText = text;
    mirrorHTML = null;
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
    } else if (mirror.textContent !== mirrorText) {
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
      ', .' + TIMER_BAR_CLASS +
      ', .' + SETTINGS_BLOCK_CLASS +
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
        ensureNavKbdHints();
        ensureSettingsPanel();
        updateForceClickWarning();
        // Also detect quiz/question changes right here (pre-paint) instead
        // of waiting for the 200ms poll: when a grading button swaps in
        // the next question, the mirror updates in the same frame.
        watchForQuizChange();
        watchForNewQuestion();
        watchForNavButtons();
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
      html.${HIDE_CLASS} .quiz-module__HPadfW__content h2:not(.${MIRROR_CLASS}) {
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
         ▶/⇋/→ symbol, so they read "practice more" / "select quiz" /
         "next quiz". */
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

  function proceedFromOverlay() {
    const wasNavPause = navPausePending;
    hideReviewOverlay();
    pendingReview = false;
    if (wasNavPause) {
      // End-of-quiz pause: reveal the nav buttons. The last question is no
      // longer relevant on this screen, so stop mirroring it.
      endNavPause();
      resetMirror('');
      return;
    }
    setMirrorToCurrentQuestion();
    const container = findMapContainer();
    if (container) startTimer(container);
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

  function showNavPauseMessage() {
    if (document.querySelector('.hq-nav-msg')) return;
    const msg = document.createElement('div');
    msg.className = 'hq-nav-msg';
    msg.textContent = 'Review the map, then click to continue';
    msg.style.cssText = `
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
      cursor: pointer;
      user-select: none;
    `;
    document.body.appendChild(msg);
  }

  function removeNavPauseMessage() {
    document.querySelectorAll('.hq-nav-msg').forEach((el) => el.remove());
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

  function onReviewPointerDown(e) {
    if (!overlayEl) return;
    const container = findMapContainer();
    if (container && container.contains(e.target)) {
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
    // Drop stale bar references so a fresh one gets created in the new DOM
    removeTimerBar();
    resetMirror('Click to start'); // previous quiz's question is irrelevant now
    // New quiz starts paused too: wait for a click before showing the
    // question and starting the timer.
    markPendingReview('quiz start');
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
      showQuestion();
      removeMirror();
      removeListKbdHints();
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
      clearTimer();
      if (running && timedOut) {
        markPendingReview('timeout');
        again.click();
      }
    }

    buttonsWerePresent = buttonsPresent;
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
    NAV_BUTTONS.forEach(({ key, symbol }) => {
      const btn = findNavButtonBySymbol(symbol);
      if (!btn) return;
      if (!btn.querySelector('kbd.' + KBD_CLASS)) {
        prependKbd(btn, key);
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
    const rows = document.querySelectorAll('.learn-module__VSVJQa__table tbody tr');
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
    return document.querySelector('.learn-module__VSVJQa__table');
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
    if (e.key === '1' && findAgainButton()) return; // grading takes priority

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

  // ---------- Config UI (injected into the site's settings panel) ----------

  const SETTINGS_BLOCK_CLASS = 'hq-timer-settings-block';
  const FORCECLICK_WARNING_CLASS = 'hq-timer-forceclick-warning';

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

    // Set by the per-quiz row below (when a quiz is open) so the global on/off
    // toggle can re-sync that row's enabled state.
    let refreshQuizRow = null;

    // Global timer on/off + default duration (the seconds input greys out
    // while off). This duration applies to every quiz that has no override.
    const timerP = document.createElement('p');

    const enabledLabel = document.createElement('label');
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = running;
    enabledLabel.appendChild(enabledCheckbox);
    enabledLabel.appendChild(document.createTextNode(' timer countdown '));

    const secInput = document.createElement('input');
    secInput.type = 'number';
    secInput.min = '1';
    secInput.step = '1';
    secInput.value = String(TIMER_SECONDS);
    secInput.disabled = !running;
    secInput.style.width = '4em';
    secInput.addEventListener('change', () => {
      const val = parseFloat(secInput.value);
      if (!isNaN(val) && val > 0) {
        TIMER_SECONDS = val;
        saveSettings();
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
      // The quiz-specific override only makes sense while the countdown is on.
      if (refreshQuizRow) refreshQuizRow();
      const c = findMapContainer();
      if (running) {
        if (c) startTimer(c);
      } else {
        clearTimer();
        timedOut = false;
        resetBarIdle();
      }
    });

    const defaultNote = document.createElement('span');
    defaultNote.textContent = ' (default for all quizzes)';
    defaultNote.style.opacity = '0.6';

    timerP.appendChild(enabledLabel);
    timerP.appendChild(secInput);
    timerP.appendChild(document.createTextNode(' s'));
    timerP.appendChild(defaultNote);

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
      overrideLabel.appendChild(document.createTextNode(' quiz specific timer countdown '));

      const quizSecInput = document.createElement('input');
      quizSecInput.type = 'number';
      quizSecInput.min = '1';
      quizSecInput.step = '1';
      quizSecInput.value = String(hasQuizOverride(quizTitle) ? perQuizSeconds[quizTitle] : TIMER_SECONDS);
      quizSecInput.disabled = !overrideCheckbox.checked;
      quizSecInput.style.width = '4em';

      const overrideNote = document.createElement('span');
      overrideNote.textContent = ' (override)';
      overrideNote.style.opacity = '0.6';

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
        restartTimer();
      });

      quizSecInput.addEventListener('change', () => {
        const val = parseFloat(quizSecInput.value);
        if (!isNaN(val) && val > 0) {
          perQuizSeconds[quizTitle] = val;
          saveSettings();
          restartTimer();
        } else {
          quizSecInput.value = String(hasQuizOverride(quizTitle) ? perQuizSeconds[quizTitle] : TIMER_SECONDS);
        }
      });

      quizP.appendChild(overrideLabel);
      quizP.appendChild(quizSecInput);
      quizP.appendChild(document.createTextNode(' s'));
      quizP.appendChild(overrideNote);
      refreshRow();
    }

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
      if (!reviewPause && overlayEl) proceedFromOverlay();
      updateForceClickWarning();
    });
    pauseLabel.appendChild(pauseCheckbox);
    pauseLabel.appendChild(document.createTextNode(' pause after mistakes'));
    pauseP.appendChild(pauseLabel);

    // Warning shown only when "force correct click" and pause mode are both on.
    const warning = document.createElement('p');
    warning.className = FORCECLICK_WARNING_CLASS;
    warning.textContent = 'For city quizzes the "force correct click" mode is currently broken. Disable it if you want to use the "pause after mistakes" mode instead.';
    warning.style.cssText = 'display:none; margin-top:6px; padding:6px 8px; border:1px solid #e0a800; border-radius:4px; background:rgba(255,193,7,0.15); font-size:0.9em;';

    block.appendChild(separator);
    block.appendChild(heading);
    block.appendChild(timerP);
    if (currentQuizTitle) block.appendChild(quizP);
    block.appendChild(pauseP);
    block.appendChild(warning);
    container.appendChild(block);
    updateForceClickWarning();
  }

  // ---------- Init ----------

  function init() {
    installConsoleHook();
    installMirrorObserver();
    installHistoryHook();
    document.addEventListener('click', onNavPauseClick, true);
    document.addEventListener('click', onPossibleNavClick, true);
    document.addEventListener('click', onReviewMapClickBlock, true);
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
    setInterval(() => {
      // Hidden tab: nothing visible to maintain; the refocus pass in
      // onVisibilityChange catches up when the tab comes back.
      if (document.hidden) return;
      pollPass();
    }, 200);
  }

  // One full maintenance pass. Runs every 200ms while the tab is visible,
  // and once immediately when the tab becomes visible again.
  function pollPass() {
    // Runtime page check: SPA navigation can move us to non-anki pages
    // where all features must stay off.
    setActive(isAnkiPage());
    if (!scriptActive) return;

    invalidateNavScan();
    ensureListKbdHints();
    ensureNavKbdHints();
    ensureSettingsPanel();
    updateForceClickWarning();
    ensureHideStyle();
    hideQuestion(); // re-assert the <html> class in case it was stripped
    ensureMirror();
    watchForQuizChange();
    watchForNewQuestion();
    watchForGradingButtons();
    watchForNavButtons();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

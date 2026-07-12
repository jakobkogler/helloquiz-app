// ==UserScript==
// @name         HelloQuiz Anki Turbo
// @namespace    https://github.com/jakobkogler/helloquiz-app
// @version      1.0.0
// @description  Anki mode enhancements for helloquiz.app: a per-question countdown that auto-fails cards you find too slowly, a review pause after mistakes (study the map, continue on click), and keyboard shortcuts with visual key hints.
// @author       Jakob Kogler
// @match        https://helloquiz.app/quiz/*?learn
// @match        https://helloquiz.app/learn
// @match        https://helloquiz.app/learn?*
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
      }));
    } catch (e) { /* storage unavailable - not critical */ }
  }

  const saved = loadSettings();
  let TIMER_SECONDS = typeof saved.seconds === 'number' && saved.seconds > 0 ? saved.seconds : 10;
  let running = typeof saved.running === 'boolean' ? saved.running : true;

  // ---------- State ----------

  let timerBar, timerBarWrap, timerInterval, timeoutHandle;
  let currentQuestionText = '';
  let currentQuizTitle = '';
  let timedOut = false;
  let buttonsWerePresent = false;
  let pendingReview = true; // start paused: first question waits for a click
  let overlayEl = null;
  let panelEl = null;

  // Timer bookkeeping for pause/resume on tab switch
  let timerDeadline = 0;      // Date.now() when timer would expire
  let pausedRemaining = null; // seconds left when paused, or null if not paused

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

  function findAgainButton() {
    const container = document.querySelector('.generic-quiz-module__m31QtG__controlButtonsAnki');
    if (!container) return null;
    return container.querySelector('button[title="1"]');
  }

  // ---------- Timer bar ----------

  function makeTimerBar(container) {
    // Remove any stale bar from a previous quiz's DOM first
    if (timerBarWrap && timerBarWrap.parentNode) {
      timerBarWrap.parentNode.removeChild(timerBarWrap);
    }

    const wrap = document.createElement('div');
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
      const pct = TIMER_SECONDS > 0 ? (remaining / TIMER_SECONDS) * 100 : 0;
      timerBar.style.width = pct + '%';
      if (remaining < TIMER_SECONDS * 0.3) {
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
    if (DEBUG) console.log('[helloquiz-timer] startTimer called, running =', running, 'seconds =', TIMER_SECONDS);
    clearTimer();
    timedOut = false;

    if (!timerBar || !document.body.contains(timerBar)) {
      timerBar = makeTimerBar(container);
    }

    if (!running) {
      resetBarIdle();
      return;
    }

    timerBar.style.width = '100%';
    timerBar.style.background = 'orange';
    runCountdown(container, TIMER_SECONDS);
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

  function findContentElForMirror() {
    return document.querySelector('.quiz-module__HPadfW__content');
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
    if (mirror.textContent !== mirrorText) mirror.textContent = mirrorText;
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

  function installMirrorObserver() {
    if (mirrorObserver) return;
    mirrorObserver = new MutationObserver(() => {
      if (!scriptActive || observerBusy) return;
      observerBusy = true; // our own DOM writes below also trigger mutations
      try {
        ensureMirror();
        ensureListKbdHints();
        ensureNavKbdHints();
        // Also detect quiz/question changes right here (pre-paint) instead
        // of waiting for the 200ms poll: when a grading button swaps in
        // the next question, the mirror updates in the same frame.
        watchForQuizChange();
        watchForNewQuestion();
      } finally {
        observerBusy = false;
      }
    });
    mirrorObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
  }

  function setMirrorToCurrentQuestion() {
    const qEl = findQuestionEl();
    if (qEl) mirrorText = qEl.textContent;
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

  // @match only controls where the script LOADS. With SPA navigation the
  // script keeps running when moving to non-anki pages (e.g. a normal
  // quiz at /quiz/<id> without ?learn), so every feature must also check
  // at runtime whether we're on an anki page.

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
    hideReviewOverlay();
    pendingReview = false;
    setMirrorToCurrentQuestion();
    const container = findMapContainer();
    if (container) startTimer(container);
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

  function fullReset(reason) {
    if (DEBUG) console.log('[helloquiz-timer] full reset (' + reason + ')');
    clearTimer();
    hideReviewOverlay();
    timedOut = false;
    buttonsWerePresent = false;
    // Drop stale bar references so a fresh one gets created in the new DOM
    if (timerBarWrap && timerBarWrap.parentNode) {
      timerBarWrap.parentNode.removeChild(timerBarWrap);
    }
    timerBar = null;
    timerBarWrap = null;
    mirrorText = 'Click to start'; // previous quiz's question is irrelevant now
    ensureMirror();
    // New quiz starts paused too: wait for a click before showing the
    // question and starting the timer.
    markPendingReview('quiz start');
    // Force question re-detection
    currentQuestionText = '__forced_reset__' + Math.random();
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
  let scriptActive = true;

  function setActive(active) {
    if (active === scriptActive) return;
    scriptActive = active;
    if (DEBUG) console.log('[helloquiz-timer] ' + (active ? 'activating' : 'deactivating') + ' on', location.pathname + location.search);

    if (active) {
      // Returning to an anki page: show panel, start in the waiting state.
      if (panelEl) panelEl.style.display = 'flex';
      hideQuestion();
      mirrorText = 'Click to start';
      markPendingReview('entered anki page');
      currentQuestionText = '__forced_reset__' + Math.random();
    } else {
      // Leaving anki mode: undo everything so normal pages are untouched.
      clearTimer();
      hideReviewOverlay(); // also reveals the question
      pendingReview = false;
      timedOut = false;
      showQuestion();
      removeMirror();
      removeListKbdHints();
      if (timerBarWrap && timerBarWrap.parentNode) {
        timerBarWrap.parentNode.removeChild(timerBarWrap);
      }
      timerBar = null;
      timerBarWrap = null;
      if (panelEl) panelEl.style.display = 'none';
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

    if (qEl.textContent !== currentQuestionText) {
      currentQuestionText = qEl.textContent;
      // Don't assume no buttons are present - the previous question's
      // grading buttons can still be mid-fade-out in the DOM right as the
      // next question renders.
      buttonsWerePresent = !!findAgainButton();

      if (running && pendingReview) {
        // Review pending: show the continue button and do NOT update the
        // mirror - it keeps showing the previous (answered) question.
        const quizContainer = findQuizContainer() || container;
        showReviewOverlay(quizContainer);
      } else {
        pendingReview = false;
        mirrorText = qEl.textContent;
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
    let el = e.target;
    let depth = 0;
    let matched = null;
    while (el && depth < 6) {
      if (isNavButton(el)) {
        matched = el;
        break;
      }
      el = el.parentElement;
      depth++;
    }

    if (!matched) return;
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
      currentQuestionText = '__forced_reset__' + Math.random();
      watchForNewQuestion();
    }, 250);
  }


  // ---------- Keyboard handlers ----------

  function onOverlayKeydown(e) {
    if (!overlayEl) return;
    if (e.key === '1') {
      e.preventDefault();
      proceedFromOverlay();
    }
  }


  const QUIZ_LIST_KEY_INDEX = { '1': 0, '2': 1, '3': 2, '4': 3 };
  const KBD_COUNT = 4; // rows reachable via keys 1-4

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
          const kbd = document.createElement('kbd');
          kbd.className = KBD_CLASS;
          kbd.textContent = label;
          td.insertBefore(kbd, td.firstChild);
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
        const kbd = document.createElement('kbd');
        kbd.className = KBD_CLASS;
        kbd.textContent = key;
        btn.insertBefore(kbd, btn.firstChild);
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
    const gradeContainer = document.querySelector('.generic-quiz-module__m31QtG__controlButtonsAnki');
    if (gradeContainer) {
      ['1', '2', '3', '4'].forEach((key) => {
        const btn = gradeContainer.querySelector('button[title="' + key + '"]');
        if (!btn) return;
        if (btn.querySelector('kbd.' + KBD_CLASS)) return;
        const kbd = document.createElement('kbd');
        kbd.className = KBD_CLASS;
        kbd.textContent = key;
        btn.insertBefore(kbd, btn.firstChild);
      });
    }

    // And an Esc badge on the menu's "anki mode" link, since the Escape
    // key navigates there. Also shorten its text to just "anki" so the
    // badge + label stay centered on a single line in the menu.
    document.querySelectorAll('a[href="/learn"]').forEach((link) => {
      link.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE && node.data.includes('anki mode')) {
          node.data = node.data.replace('anki mode', 'anki');
        }
      });
      if (link.querySelector('kbd.' + KBD_CLASS)) return;
      const kbd = document.createElement('kbd');
      kbd.className = KBD_CLASS;
      kbd.textContent = 'Esc';
      link.insertBefore(kbd, link.firstChild);
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
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (findAgainButton()) return; // grading in progress takes priority
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
    const spans = document.querySelectorAll('span[class*="generic-quiz-module"][class*="expanded"]');
    for (const span of spans) {
      const button = span.closest('button');
      if (button && button.textContent.includes(symbol)) return button;
    }
    return null;
  }

  function onNavKeydown(e) {
    if (!scriptActive) return;
    if (!isAnkiPage()) return;
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (e.target && e.target.isContentEditable) return;

    const symbol = NAV_SYMBOL_BY_KEY[e.key];
    if (!symbol) return;
    if (overlayEl) return; // overlay's own "1" handling takes priority
    if (e.key === '1' && findAgainButton()) return; // grading takes priority

    const button = findNavButtonBySymbol(symbol);
    if (!button) return;

    e.preventDefault();
    if (DEBUG) console.log('[helloquiz-timer] nav key', e.key, '->', symbol);
    button.click();
  }

  function onEscapeKeydown(e) {
    if (!scriptActive) return;
    if (e.key !== 'Escape') return;
    const tag = (document.activeElement || {}).tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (location.pathname === '/learn') return; // already there

    e.preventDefault();
    if (DEBUG) console.log('[helloquiz-timer] Escape -> /learn');
    // Prefer clicking an existing /learn link for a smooth SPA transition;
    // fall back to a full navigation if none is on the page.
    const learnLink = document.querySelector('a[href="/learn"]');
    if (learnLink) learnLink.click();
    else location.assign('https://helloquiz.app/learn');
  }

  // ---------- Control panel ----------

  function makeControlPanel() {
    const panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 100000;
      background: rgba(30, 30, 30, 0.85);
      color: #fff;
      font-family: system-ui, sans-serif;
      font-size: 13px;
      padding: 8px 10px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.3);
      user-select: none;
    `;

    const label = document.createElement('label');
    label.textContent = 'timer (s):';
    label.style.cssText = 'display:flex; align-items:center; gap:4px;';

    const input = document.createElement('input');
    input.type = 'number';
    input.min = '1';
    input.step = '1';
    input.value = String(TIMER_SECONDS);
    input.style.cssText = `
      width: 48px;
      padding: 2px 4px;
      border-radius: 4px;
      border: 1px solid #666;
      background: #222;
      color: #fff;
    `;
    input.addEventListener('change', () => {
      const val = parseFloat(input.value);
      if (!isNaN(val) && val > 0) {
        TIMER_SECONDS = val;
        saveSettings();
        const container = findMapContainer();
        if (container) startTimer(container);
      } else {
        input.value = String(TIMER_SECONDS);
      }
    });

    const toggleBtn = document.createElement('button');
    toggleBtn.textContent = running ? 'disable' : 'enable';
    toggleBtn.style.cssText = `
      padding: 3px 10px;
      border-radius: 4px;
      border: none;
      cursor: pointer;
      font-weight: 600;
      background: ${running ? '#c0392b' : '#27ae60'};
      color: #fff;
    `;
    toggleBtn.addEventListener('click', () => {
      running = !running;
      saveSettings();
      toggleBtn.textContent = running ? 'disable' : 'enable';
      toggleBtn.style.background = running ? '#c0392b' : '#27ae60';

      const container = findMapContainer();
      if (running) {
        if (container) startTimer(container);
      } else {
        clearTimer();
        timedOut = false;
        resetBarIdle();
      }
    });


    label.appendChild(input);
    panel.appendChild(label);
    panel.appendChild(toggleBtn);
    document.body.appendChild(panel);
    panelEl = panel;
  }

  // ---------- Init ----------

  function init() {
    makeControlPanel();
    installConsoleHook();
    installMirrorObserver();
    installHistoryHook();
    document.addEventListener('click', onPossibleNavClick, true);
    document.addEventListener('click', onReviewMapClickBlock, true);
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
      // Runtime page check: SPA navigation can move us to non-anki pages
      // where all features must stay off.
      setActive(isAnkiPage());
      if (!scriptActive) return;

      // Watchdog: Next.js hydration or navigation can remove nodes we
      // appended to <body>. Recreate the panel if it's gone.
      if (!panelEl || !document.body.contains(panelEl)) {
        makeControlPanel();
      }
      ensureListKbdHints();
      ensureNavKbdHints();
      ensureHideStyle();
      hideQuestion(); // re-assert the <html> class in case it was stripped
      ensureMirror();
      watchForQuizChange();
      watchForNewQuestion();
      watchForGradingButtons();
    }, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

// Loads more search results before collection, using a scroll program the model
// wrote itself.
//
// YouTube renders results lazily, so an unscrolled page can hold as few as four
// video cards - and the pipeline used to rank exactly those four. This stage
// scrolls until enough cards exist.
//
// The scroll loop is deliberately not hand-written: the model emits a JavaScript
// function body and we execute it. Where that body runs took some finding out.
// Compiling it with new Function is refused in both places you would expect:
//
//   - in an injected script, by our own extension CSP - isolated-world
//     injections inherit extension_pages, and MV3 forbids 'unsafe-eval' there;
//   - in the MAIN world, by youtube.com's Trusted Types policy.
//
// So it runs in a sandboxed extension page (sandbox/program-runner.*), which is
// the one context MV3 still allows 'unsafe-eval'. That page has no chrome.* APIs
// and a null origin, so it cannot reach the tab on its own. Every api call is a
// postMessage back to here, and this file decides whether to honour it. The
// program's capabilities are exactly the primitives implemented below - nothing
// else is reachable, whatever the model writes.
//
// Two further properties fall out of that:
//   - Nothing from the page ever enters the codegen prompt (only integers and
//     the api docs), so page text cannot steer code that later executes.
//   - Generation happens after the run has already produced its output, purely
//     to fill a cache. The critical path runs cached-or-fallback code and never
//     waits on the model.
//
// Memory matters here - the extension already holds ~1.5GB for the model - so
// growth detection polls page-side instead of installing MutationObservers, the
// iframe is torn down after every run, and a hard cap limits how much scrolling
// a program can do (each continuation appends renderers YouTube never prunes).

import { litertClient } from '../../llm/litert-client.js';
import { stripCodeFences } from './rank.js';

const RUNNER_PATH = 'sandbox/program-runner.html';
const CACHE_KEY = 'yt-scroll-program/v2';

// Wall-clock ceiling on a program. Enforced here, by tearing the iframe down.
const BUDGET_MS = 20000;

// Hard cap on scroll actions, independent of the time budget. Each continuation
// appends ~20 more renderers that YouTube never releases, so an unbounded loop
// is a memory problem long before it is a time problem.
const MAX_SCROLL_ACTIONS = 12;

const MAX_PROGRAM_CHARS = 1500;

// Anything that would hand the generated body a capability beyond `api`.
const BANNED = /\b(document|window|globalThis|self|top|parent|frames|fetch|XMLHttpRequest|WebSocket|chrome|browser|eval|Function|import|require|localStorage|sessionStorage|indexedDB|postMessage|constructor|prototype|__proto__|Reflect|Proxy|atob|btoa)\b/;

// Declared as parameters of the compiled function and passed nothing, so each
// name is undefined inside the body rather than resolving to the real global.
// Secondary defence only - the sandbox has nothing worth reaching anyway - but
// it turns a confused program into a clean, reportable TypeError.
//
// `eval` and `arguments` are absent deliberately (not legal parameter names in
// strict mode) and `import` is a keyword, so it cannot be a parameter at all.
// All three stay caught by BANNED.
const SHADOWED_GLOBALS = [
  'document', 'window', 'globalThis', 'self', 'top', 'parent', 'frames',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'chrome', 'browser',
  'localStorage', 'sessionStorage', 'indexedDB', 'postMessage',
  'Function', 'require', 'Reflect', 'Proxy', 'atob', 'btoa',
];

// The hand-written baseline. It is a program string rather than inline code so
// it runs through the exact same path as the generated one - one execution
// route, and a like-for-like comparison of what the model came up with.
const FALLBACK_PROGRAM = `
  while ((await api.count()) < api.target && api.elapsed() < 15000) {
    if (!(await api.scrollToBottom())) break;
    await api.waitForGrowth(2500);
  }
`;

// ---------------------------------------------------------------------------
// Page primitives.
//
// These are ordinary injected functions - no eval, nothing generated - so they
// are unaffected by the CSP and Trusted Types walls described above. Same
// contract as collectSearchResults in collect.js: self-contained, no imports, no
// closure variables, structured-cloneable in and out.
// ---------------------------------------------------------------------------

function pageCount() {
  return document.querySelectorAll('ytd-video-renderer').length;
}

function pageScrollToBottom() {
  window.scrollTo(0, document.documentElement.scrollHeight);
  return true;
}

function pageScrollBy(px) {
  window.scrollBy(0, Math.max(0, Math.min(20000, Number(px) || 0)));
  return true;
}

// One injection covers the whole wait. Polling rather than a MutationObserver:
// observing YouTube's results subtree means a callback per node on every
// continuation, and an observer left behind by an abandoned wait would outlive
// the injection. A 250ms poll costs a short static NodeList and cannot leak.
async function pageWaitForGrowth(ms) {
  const count = () => document.querySelectorAll('ytd-video-renderer').length;
  const baseline = count();
  const deadline = Date.now() + Math.max(0, Math.min(5000, Number(ms) || 0));

  while (Date.now() < deadline) {
    if (count() > baseline) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return count() > baseline;
}

function pageScrollTo(y) {
  window.scrollTo(0, Number(y) || 0);
  return true;
}

function pageScrollY() {
  return window.scrollY;
}

async function inject(tabId, fn, args = []) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    function: fn,
    args,
  });
  return injection && injection[0] ? injection[0].result : undefined;
}

// ---------------------------------------------------------------------------
// Validation - before anything is compiled.
// ---------------------------------------------------------------------------

// Returns the cleaned body, or null if it is not worth running. There is no
// syntax check: new Function is unavailable here, so a malformed body is only
// discovered when the sandbox reports it, which is an ordinary failure.
export function validateProgram(rawCode) {
  const code = stripCodeFences(rawCode).trim();

  if (!code) return null;
  if (code.length > MAX_PROGRAM_CHARS) return null;
  if (!code.includes('api.')) return null;
  if (BANNED.test(code)) return null;

  return code;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function readCachedProgram(target) {
  try {
    const stored = await chrome.storage.local.get(CACHE_KEY);
    const entry = stored && stored[CACHE_KEY];
    if (!entry || typeof entry.code !== 'string' || entry.target !== target) return null;
    return validateProgram(entry.code);
  } catch (e) {
    return null;
  }
}

async function writeCachedProgram(code, target) {
  try {
    await chrome.storage.local.set({
      [CACHE_KEY]: { code, target, createdAt: Date.now() },
    });
  } catch (e) {
    console.warn('scroll-agent: could not cache program', e);
  }
}

async function clearCachedProgram() {
  try {
    await chrome.storage.local.remove(CACHE_KEY);
  } catch (e) {
    // Nothing useful to do; the next run just re-reads a stale entry.
  }
}

export async function hasCachedProgram(target) {
  return (await readCachedProgram(target)) !== null;
}

// ---------------------------------------------------------------------------
// Prompt
//
// The api surface, the target, and one integer. No selectors, no titles, no
// HTML - nothing the page controls appears here, which is what makes executing
// the result defensible.
// ---------------------------------------------------------------------------

export function buildScrollProgramPrompt({ target }) {
  return `You are writing a small browser automation script.

A search results page starts with fewer video cards than the reader needs - sometimes only three or four. More cards load each time the page is scrolled to the bottom. Your script must get the page to at least ${target} cards, and it will be reused on many different pages, so it cannot assume any particular starting count.

You control the page through one object called \`api\`. It is the ONLY thing in scope. Every method except \`elapsed\` is async and MUST be awaited:

  api.target                    -> number, the card count you are aiming for (${target})
  api.elapsed()                 -> number, milliseconds since your script started (not async)
  await api.count()             -> number, how many cards are on the page right now
  await api.scrollToBottom()    -> scrolls to the bottom. Returns false when the
                                   scroll budget is spent - stop when it does.
  await api.scrollBy(px)        -> scrolls down by px. Same false-when-spent rule.
  await api.waitForGrowth(ms)   -> waits until the card count increases, or until
                                   ms have passed. Returns true if it grew.
  await api.sleep(ms)           -> waits ms milliseconds.

Rules:
- Write ONLY the body of an async function. No function declaration, no wrapper, no markdown fences, no explanation.
- Await every api call except api.elapsed(). Forgetting await breaks the script.
- New cards arrive over the network and typically take 1.5-3 seconds. Wait at least 2000ms for growth before treating the page as stalled, or you will waste your scroll budget re-scrolling a page that was still loading.
- Use only \`api\`. There is no document, no window, no fetch, no chrome. Referring to them throws.
- Stop as soon as the count reaches api.target. Loading more than needed wastes memory.
- Stop if api.elapsed() passes 15000, or if a scroll call returns false.
- Never write a loop that cannot terminate.

Write the function body now.`;
}

// ---------------------------------------------------------------------------
// Broker: runs a program in the sandbox and services its api calls against the
// tab. Resolves to { error, timedOut, scrollActions }.
// ---------------------------------------------------------------------------

function runInSandbox(tabId, code, target) {
  return new Promise((resolve) => {
    const iframe = document.createElement('iframe');
    iframe.src = chrome.runtime.getURL(RUNNER_PATH);
    iframe.style.display = 'none';

    let scrollActions = 0;
    let settled = false;
    let budgetTimer = null;

    // Every effect the program has on the page passes through handleCall, so
    // this is a complete record of what it actually did - the proof that the
    // program ran, as opposed to merely having been selected.
    const trace = [];

    // Removing the iframe genuinely terminates the program - including a loop
    // that never yields - which a Promise.race could not do.
    const finish = (error, timedOut) => {
      if (settled) return;
      settled = true;
      clearTimeout(budgetTimer);
      window.removeEventListener('message', onMessage);
      iframe.remove();

      console.groupCollapsed(`scroll-agent: program made ${trace.length} api calls`);
      trace.forEach((line, i) => console.log(`${i + 1}. ${line}`));
      console.groupEnd();

      resolve({ error, timedOut, scrollActions });
    };

    // The single place a program's requests turn into real effects. Anything not
    // named here is unreachable, whatever the model wrote.
    const handleCall = async (method, args) => {
      switch (method) {
        case 'count':
          return inject(tabId, pageCount);
        case 'scrollToBottom':
          if (scrollActions >= MAX_SCROLL_ACTIONS) return false;
          scrollActions += 1;
          return inject(tabId, pageScrollToBottom);
        case 'scrollBy':
          if (scrollActions >= MAX_SCROLL_ACTIONS) return false;
          scrollActions += 1;
          return inject(tabId, pageScrollBy, [args[0]]);
        case 'waitForGrowth':
          return inject(tabId, pageWaitForGrowth, [args[0]]);
        case 'sleep': {
          const ms = Math.max(0, Math.min(3000, Number(args[0]) || 0));
          await new Promise((r) => setTimeout(r, ms));
          return true;
        }
        default:
          throw new Error(`unknown api method: ${method}`);
      }
    };

    const onMessage = async (event) => {
      if (settled || event.source !== iframe.contentWindow) return;
      const msg = event.data;
      if (!msg || typeof msg !== 'object') return;

      if (msg.type === 'ready') {
        iframe.contentWindow.postMessage(
          { type: 'run', code, target, shadowed: SHADOWED_GLOBALS },
          '*'
        );
        return;
      }

      if (msg.type === 'done') {
        finish(msg.error || '', false);
        return;
      }

      if (msg.type === 'call') {
        let reply;
        try {
          const value = await handleCall(msg.method, msg.args || []);
          const args = (msg.args || []).filter((a) => a !== undefined).join(',');
          trace.push(`${msg.method}(${args}) -> ${value}`);
          reply = { type: 'return', id: msg.id, ok: true, value };
        } catch (e) {
          trace.push(`${msg.method}() threw ${e.message || e}`);
          reply = { type: 'return', id: msg.id, ok: false, error: String(e.message || e) };
        }
        if (!settled) iframe.contentWindow.postMessage(reply, '*');
        return;
      }
    };

    window.addEventListener('message', onMessage);
    budgetTimer = setTimeout(() => finish('budget exceeded', true), BUDGET_MS);
    document.body.appendChild(iframe);
  });
}

// ---------------------------------------------------------------------------
// Public entry points
// ---------------------------------------------------------------------------

// Scrolls the tab until it holds `target` video cards. Never throws - on any
// failure the caller simply re-collects whatever ended up on the page.
export async function ensureVideoCount(tabId, { target, setStatus } = {}) {
  const cached = await readCachedProgram(target);
  const source = cached ? 'generated' : 'fallback';
  const code = cached || FALLBACK_PROGRAM;

  // Log the exact program about to execute, and where it came from. Without
  // this there is no way to tell from the console whether the model's code or
  // the hand-written fallback did the scrolling. Collapsed, like logPrompt in
  // litert-client.js, so it stays out of the way during normal use.
  console.groupCollapsed(
    `scroll-agent: running ${source.toUpperCase()} program (${code.trim().split('\n').length} lines)`
  );
  console.log(
    source === 'generated'
      ? 'Written by the model on an earlier run, cached in chrome.storage.local. This text exists nowhere in the source tree.'
      : 'Hand-written FALLBACK_PROGRAM from scroll-agent.js.'
  );
  console.log(code.trim());
  console.groupEnd();

  if (setStatus) setStatus('extracting', `Loading more results (0/${target})...`);

  let before = 0;
  let startScrollY = 0;
  let outcome = { error: '', timedOut: false, scrollActions: 0 };

  try {
    before = await inject(tabId, pageCount);
    startScrollY = await inject(tabId, pageScrollY);
    outcome = await runInSandbox(tabId, code, target);
  } catch (e) {
    outcome = { error: String(e.message || e), timedOut: false, scrollActions: 0 };
  }

  let count = before;
  try {
    count = await inject(tabId, pageCount);
    // Leave the page where the user left it, including on the error path.
    await inject(tabId, pageScrollTo, [startScrollY]);
  } catch (e) {
    // The tab went away mid-run; the caller's re-collect will report it.
  }

  const failed = Boolean(outcome.error) || count < target;

  // A generated program that errored, timed out, or under-delivered does not get
  // to fail twice. Dropping it means the next run uses the fallback and then
  // regenerates.
  if (cached && failed) {
    console.warn('scroll-agent: dropping cached program', { code, outcome, count });
    await clearCachedProgram();
  }

  return { ...outcome, count, before, source };
}

// Asks the model for a scroll program and caches it if it validates. Never
// throws. Intended to run after the pipeline has already delivered its output:
// a failed generation calls litertClient.discard(), which drops the WebGPU
// device and forces a full model reload, and that cost must never land on a run
// that was otherwise about to succeed.
export async function refreshScrollProgram({ target }) {
  try {
    const prompt = buildScrollProgramPrompt({ target });
    const raw = await litertClient.summarise(prompt);
    const code = validateProgram(raw);

    if (!code) {
      console.warn('scroll-agent: generated program rejected\n', raw);
      return null;
    }

    await writeCachedProgram(code, target);
    console.log('scroll-agent: cached a generated program\n', code);
    return code;
  } catch (e) {
    console.warn('scroll-agent: generation failed', e);
    return null;
  }
}

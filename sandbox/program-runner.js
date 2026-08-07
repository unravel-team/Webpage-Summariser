// Compiles and runs the model's scroll program inside a sandboxed extension
// page, where 'unsafe-eval' is permitted.
//
// This page has no chrome.* APIs and a null origin, so it cannot touch the tab
// itself. Every capability the program has is a postMessage round trip to the
// side panel, which decides whether to honour it - see scroll-agent.js. The
// program therefore cannot do anything the panel has not explicitly implemented,
// which is a stronger guarantee than the parameter shadowing alone gave us.
//
// Shadowing is still applied on top: it turns a program that reaches for
// `document` into a clean TypeError rather than letting it poke this page's own
// (empty, sandboxed) DOM.

let callSeq = 0;
const pending = new Map();

function callHost(method, args) {
  const id = ++callSeq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    parent.postMessage({ type: 'call', id, method, args }, '*');
  });
}

// Every api method that needs the page is a round trip, so the whole surface is
// async and the prompt tells the model to await it. `target` and `elapsed` stay
// local because they need nothing from the tab.
function buildApi(target, started) {
  return Object.freeze({
    target,
    elapsed: () => Date.now() - started,
    count: () => callHost('count', []),
    scrollToBottom: () => callHost('scrollToBottom', []),
    scrollBy: (px) => callHost('scrollBy', [px]),
    waitForGrowth: (ms) => callHost('waitForGrowth', [ms]),
    sleep: (ms) => callHost('sleep', [ms]),
  });
}

async function run({ code, target, shadowed }) {
  const api = buildApi(target, Date.now());
  let error = '';

  try {
    const program = new Function('api', ...shadowed, `return (async () => {\n${code}\n})();`);
    await program(api);
  } catch (e) {
    error = String((e && e.message) || e);
  }

  parent.postMessage({ type: 'done', error }, '*');
}

window.addEventListener('message', (event) => {
  // The panel is this frame's only possible parent, and the sandbox has no
  // openers, so source identity is the check that matters here.
  if (event.source !== parent) return;

  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'run') {
    run(msg);
    return;
  }

  if (msg.type === 'return') {
    const slot = pending.get(msg.id);
    if (!slot) return;
    pending.delete(msg.id);
    if (msg.ok) slot.resolve(msg.value);
    else slot.reject(new Error(msg.error || 'host call failed'));
  }
});

parent.postMessage({ type: 'ready' }, '*');

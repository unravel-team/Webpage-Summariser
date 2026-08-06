// The original behaviour: pull the readable text off the page and summarise it
// for the reader's profile. Everything here moved out of sidepanel.js unchanged;
// it is the fallback pipeline for any URL no other pipeline claims.

import { buildPrompt } from '../llm/prompt-template.js';
import { litertClient } from '../llm/litert-client.js';

// Injected into the page, so it must be self-contained - no imports, no closure
// over anything in this module.
function extractPageContent() {
  const title = document.title || '';
  const url = window.location.href;

  const bodyClone = document.body.cloneNode(true);

  const elementsToRemove = bodyClone.querySelectorAll(
    'script, style, nav, footer, [style*="display:none"], [hidden], iframe, noscript'
  );
  elementsToRemove.forEach((el) => el.remove());

  let text = bodyClone.innerText || bodyClone.textContent || '';
  text = text.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const MAX_LENGTH = 8000;
  if (text.length > MAX_LENGTH) {
    text = text.substring(0, MAX_LENGTH) + '...';
  }

  return { title, url, text };
}

export const summaryPipeline = {
  id: 'summary',
  idleLabel: 'Summarise This Page',
  doneLabel: 'Summary complete — tap to summarise again',

  // A summary is useful without one; the intent only sharpens it.
  requiresIntent: false,
  intentPlaceholder: 'e.g., focus on pricing, security risks...',

  // The fallback pipeline claims everything the registry did not match earlier.
  matches() {
    return true;
  },

  async run({ tab, profileLabel, intent, setStatus, output, ensureModel }) {
    setStatus('extracting', 'Extracting page content...');

    const injectionResult = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      function: extractPageContent,
    });

    if (!injectionResult || !injectionResult[0] || !injectionResult[0].result) {
      throw new Error('Failed to extract page content');
    }

    const { title, url, text } = injectionResult[0].result;

    await ensureModel();

    setStatus('generating', 'Generating summary...');
    const prompt = buildPrompt(profileLabel, title, url, text, intent);

    output.clear();
    let fullResponse = '';
    await litertClient.summarise(prompt, (token) => {
      fullResponse += token;
      output.stream(fullResponse);
    });
  },
};

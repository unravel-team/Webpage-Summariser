function extractPageContent() {
  const title = document.title || '';
  const url = window.location.href;

  // Clone body to avoid modifying the DOM
  const bodyClone = document.body.cloneNode(true);

  // Remove script, style, nav, footer, and other noise elements
  const elementsToRemove = bodyClone.querySelectorAll(
    'script, style, nav, footer, [style*="display:none"], [hidden], iframe, noscript'
  );
  elementsToRemove.forEach((el) => el.remove());

  // Get text content
  let text = bodyClone.innerText || bodyClone.textContent || '';

  // Basic cleanup: collapse multiple spaces and newlines
  text = text
    .replace(/\s+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // Truncate to ~8000 characters (rough estimate for Qwen3 0.6B's context window)
  const MAX_LENGTH = 8000;
  if (text.length > MAX_LENGTH) {
    text = text.substring(0, MAX_LENGTH) + '...';
  }

  return {
    title,
    url,
    text,
  };
}

// Return the extracted content for the side panel
const content = extractPageContent();
content;

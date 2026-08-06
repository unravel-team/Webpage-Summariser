// Fetches a video's real description from its watch page.
//
// The search page only ever exposes a short snippet (and the homepage feed not
// even that), so the description that the ranker actually needs has to be
// fetched. host_permissions covers youtube.com, so a plain fetch from the side
// panel works without a content script.

const FETCH_TIMEOUT_MS = 8000;
const MAX_DESCRIPTION_CHARS = 1500;

// Matches the JSON string value of "shortDescription" in ytInitialPlayerResponse,
// honouring backslash escapes so an escaped quote inside the text does not end
// the match early.
const SHORT_DESCRIPTION_RE = /"shortDescription"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const META_DESCRIPTION_RE =
  /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i;

function decodeHtmlEntities(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractDescription(html) {
  const shortDescription = SHORT_DESCRIPTION_RE.exec(html);
  if (shortDescription) {
    try {
      // The capture is a raw JSON string body; re-quoting it lets JSON.parse do
      // the unescaping (\n, \uXXXX, \" and friends) correctly.
      return JSON.parse(`"${shortDescription[1]}"`);
    } catch (e) {
      // Fall through to the meta tag rather than losing the video entirely.
    }
  }

  const meta = META_DESCRIPTION_RE.exec(html);
  if (meta) return decodeHtmlEntities(meta[1]);

  return '';
}

export const descriptionEnricher = {
  name: 'description',

  appliesTo(video) {
    return Boolean(video.videoId) && !video.description;
  },

  async enrich(video) {
    const response = await fetch(video.url, {
      credentials: 'omit',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    // Read as text and discard immediately - this HTML is never parsed into DOM
    // and never inserted anywhere.
    const html = await response.text();
    const description = extractDescription(html);
    if (!description) return {};

    return { description: description.slice(0, MAX_DESCRIPTION_CHARS) };
  },
};

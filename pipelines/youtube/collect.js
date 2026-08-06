// Scrapes the video cards off a YouTube search results page.
//
// collectSearchResults() runs inside the page via chrome.scripting, so it has to
// be entirely self-contained: no imports, no closure variables, and only values
// that survive structured cloning may be returned.

export const MAX_VIDEOS = 20;

function collectSearchResults(maxVideos) {
  const params = new URLSearchParams(window.location.search);
  const query = params.get('search_query') || '';

  const videos = [];
  const seen = new Set();

  const text = (root, selector) => {
    const el = root.querySelector(selector);
    return el ? (el.textContent || '').trim().replace(/\s+/g, ' ') : '';
  };

  const renderers = document.querySelectorAll('ytd-video-renderer');

  for (const renderer of renderers) {
    if (videos.length >= maxVideos) break;

    // Promoted results sit inside their own wrapper; they are ads, not results.
    if (renderer.closest('ytd-promoted-video-renderer, ytd-ad-slot-renderer')) continue;

    const link = renderer.querySelector('a#video-title, a#video-title-link');
    if (!link || !link.href) continue;

    let videoId = '';
    try {
      videoId = new URL(link.href, window.location.origin).searchParams.get('v') || '';
    } catch (e) {
      continue;
    }
    if (!videoId || seen.has(videoId)) continue;
    seen.add(videoId);

    // The visible title is often truncated with an ellipsis; the title attribute
    // (or aria-label) carries the full one.
    const title =
      (link.getAttribute('title') || '').trim() ||
      (link.textContent || '').trim().replace(/\s+/g, ' ');
    if (!title) continue;

    const metaSpans = [...renderer.querySelectorAll('#metadata-line span')].map((span) =>
      (span.textContent || '').trim()
    );

    videos.push({
      videoId,
      url: `https://www.youtube.com/watch?v=${videoId}`,
      title,
      channel: text(renderer, 'ytd-channel-name #text, ytd-channel-name a'),
      duration: text(
        renderer,
        'ytd-thumbnail-overlay-time-status-renderer #text, ytd-thumbnail-overlay-time-status-renderer'
      ),
      views: metaSpans[0] || '',
      age: metaSpans[1] || '',
      snippet: text(renderer, '.metadata-snippet-text, #description-text'),
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
    });
  }

  return { query, videos };
}

// Runs the scraper in the given tab and returns { query, videos }.
export async function collectFromTab(tabId, maxVideos = MAX_VIDEOS) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    function: collectSearchResults,
    args: [maxVideos],
  });

  const result = injection && injection[0] && injection[0].result;
  if (!result) return { query: '', videos: [] };
  return result;
}

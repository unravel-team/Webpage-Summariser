// Rendering for the YouTube pipeline.
//
// Every link and timestamp on screen is built here from data collected off the
// page, never from model output - a small model asked to write URLs gets them
// wrong, and a wrong link is worse than no link. The model's text only carries
// bracketed indices, which linkifyCitations turns into real anchors.

const MAX_CHAPTERS = 10;

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Replaces [1] / [2] markers in already-rendered HTML with citation links.
// Indices are 1-based positions in `videos`; anything out of range is left as
// literal text so a hallucinated [9] never becomes a link to the wrong video.
export function linkifyCitations(html, videos) {
  return html.replace(/\[(\d{1,2})\]/g, (match, digits) => {
    const video = videos[Number(digits) - 1];
    if (!video) return match;
    return (
      `<a class="cite" href="${escapeHtml(video.url)}" target="_blank" rel="noopener" ` +
      `title="${escapeHtml(video.title)}">${digits}</a>`
    );
  });
}

// Pulls "12:34 Section name" chapter lines out of a description. YouTube's own
// chapter parsing is stricter than this; being loose is fine here because the
// worst case is an extra jump link.
export function parseChapters(description) {
  if (!description) return [];

  const chapters = [];
  const seen = new Set();

  for (const line of description.split('\n')) {
    const match = /^\s*[([]?(\d{1,2}):([0-5]\d)(?::([0-5]\d))?[)\]]?\s*[-–—:|)]?\s*(.+?)\s*$/.exec(line);
    if (!match) continue;

    const [, first, second, third, label] = match;
    const seconds = third
      ? Number(first) * 3600 + Number(second) * 60 + Number(third)
      : Number(first) * 60 + Number(second);

    if (seen.has(seconds)) continue;
    seen.add(seconds);

    const stamp = third ? `${first}:${second}:${third}` : `${first}:${second}`;
    chapters.push({ seconds, stamp, label: label.replace(/\s+/g, ' ').trim() });

    if (chapters.length >= MAX_CHAPTERS) break;
  }

  return chapters;
}

function chapterUrl(video, seconds) {
  return `https://www.youtube.com/watch?v=${encodeURIComponent(video.videoId)}&t=${seconds}s`;
}

// The headline result: thumbnail, linked title, metadata, and jump links for any
// chapters the description declared.
export function topPickCard(video) {
  const card = document.createElement('div');
  card.className = 'video-card';

  const meta = [video.channel, video.duration, video.views, video.age]
    .filter(Boolean)
    .map(escapeHtml)
    .join(' · ');

  const scoreBadge =
    video.score === null || video.score === undefined
      ? ''
      : `<span class="video-score">${escapeHtml(video.score)}/10</span>`;

  card.innerHTML = `
    <a class="video-thumb" href="${escapeHtml(video.url)}" target="_blank" rel="noopener">
      <img src="${escapeHtml(video.thumbnail)}" alt="" loading="lazy">
    </a>
    <div class="video-body">
      <a class="video-title" href="${escapeHtml(video.url)}" target="_blank" rel="noopener">${escapeHtml(video.title)}</a>
      <div class="video-meta">${meta}${scoreBadge}</div>
    </div>
  `;

  const chapters = parseChapters(video.description);
  if (chapters.length) {
    const list = document.createElement('div');
    list.className = 'chapters';
    list.innerHTML =
      '<div class="chapters-title">Jump to</div>' +
      chapters
        .map(
          (chapter) =>
            `<a class="chapter" href="${escapeHtml(chapterUrl(video, chapter.seconds))}" target="_blank" rel="noopener">` +
            `<span class="chapter-time">${escapeHtml(chapter.stamp)}</span>` +
            `<span class="chapter-label">${escapeHtml(chapter.label)}</span></a>`
        )
        .join('');
    card.appendChild(list);
  }

  return card;
}

// The remaining ranked videos, compact: score, title, and the ranker's reason.
export function runnersUpList(videos) {
  const wrapper = document.createElement('div');
  wrapper.className = 'runners-up';
  wrapper.innerHTML =
    '<div class="runners-up-title">Also ranked</div>' +
    videos
      .map(
        (video) =>
          `<a class="runner" href="${escapeHtml(video.url)}" target="_blank" rel="noopener">` +
          `<span class="runner-score">${video.score === null || video.score === undefined ? '–' : escapeHtml(video.score)}</span>` +
          `<span class="runner-text"><span class="runner-title">${escapeHtml(video.title)}</span>` +
          (video.reason ? `<span class="runner-reason">${escapeHtml(video.reason)}</span>` : '') +
          '</span></a>'
      )
      .join('');
  return wrapper;
}

export function noticeBanner(message) {
  const notice = document.createElement('div');
  notice.className = 'yt-notice';
  notice.textContent = message;
  return notice;
}

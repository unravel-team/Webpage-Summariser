// Write-up stage: turns the top-ranked videos into an answer.
//
// The model writes prose only. It never emits URLs or timestamps - those are
// rendered from collected data in render.js - and it refers to videos by the
// bracketed index it is given, which the panel turns into citation links.

const DESCRIPTION_CHARS_FOR_SYNTHESIS = 1200;

function truncate(text, limit) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

function describeVideo(video, id) {
  const meta = [video.channel, video.duration, video.views, video.age]
    .filter(Boolean)
    .join(' · ');

  const lines = [`[${id}] ${video.title}`];
  if (meta) lines.push(`    ${meta}`);
  if (video.score !== null && video.score !== undefined) {
    lines.push(`    Relevance score: ${video.score}/10${video.reason ? ` (${video.reason})` : ''}`);
  }

  const body = video.description || video.snippet;
  if (body) lines.push(`    ${truncate(body, DESCRIPTION_CHARS_FOR_SYNTHESIS)}`);
  if (video.transcript) {
    lines.push(`    Transcript excerpt: ${truncate(video.transcript, DESCRIPTION_CHARS_FOR_SYNTHESIS)}`);
  }

  return lines.join('\n');
}

export function buildOverviewPrompt(topVideos, { profileLabel, intent, query }) {
  const list = topVideos.map((video, index) => describeVideo(video, index + 1)).join('\n\n');

  // Intent leads. The profession only sets the pitch - what to explain and at
  // what level - because a reader who has said what they want has overridden
  // whatever their job would have implied.
  const goal = intent && intent.trim()
    ? `What the reader wants, which governs everything below: ${intent.trim()}
Their background is ${profileLabel}. Use that only to pitch the explanation at the right level, never to change the subject away from what they asked for.`
    : `The reader has not said what they want, so write for a ${profileLabel}.`;

  return `You are writing a short briefing about the best videos found for a search.
${goal}
${query ? `Their search: ${query}\n` : ''}
The candidates, already ranked, best first:
${list}

Write in this shape, 70-100 words total:
- A title/Heading of 4-8 words naming the specific thing these videos teach. Not "Video Recommendations" or a restatement of the search.
- One or two lines of real substance about the topic itself - the key idea or the thing a newcomer gets wrong - not a description of what was found.
- Three bullets, one line each, one per video: what [1] gives the reader and why to start there; what [2] adds that [1] does not; what [3] adds beyond both.

Rules:
- Every bullet must recommend something. Do not write a bullet about what is missing, absent, or not covered - the reader can only watch what is here.
- Put the bracketed number immediately after the claim it supports, like [1] or [2]. Use [1][2] when two videos support the same claim.
- Write only the topic and the videos. No URLs, links, channel handles, or timestamps.
- Address the reader directly about the subject. Never refer to the search, the results, the list, the page, or "these videos".
- If the candidates are weak or off-topic, say so plainly in the lead lines and keep the bullets short rather than overselling a poor match.`;
}

// Scoring stage: one model call that rates every collected video against the
// reader's intent, plus a deliberately forgiving parser for its output.
//
// buildRankPrompt/parseRanking are pure and take the videos as an argument, so
// the stage can be run a second time over a smaller, more enriched set (the
// planned transcript re-rank) without any change here.

const DESCRIPTION_CHARS_FOR_RANKING = 500;

// Small models wrap their output in markdown fences however often you tell them
// not to. Shared with the scroll agent, which has the same problem with code.
export function stripCodeFences(text) {
  return (text || '').replace(/```(?:json|js|javascript)?/gi, '');
}

function truncate(text, limit) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit)}…` : clean;
}

// One block per video. Empty fields are omitted rather than printed blank, so a
// video enriched with a transcript later simply grows an extra line.
function describeVideo(video, id) {
  const meta = [video.channel, video.duration, video.views, video.age]
    .filter(Boolean)
    .join(' · ');

  const lines = [`[${id}] ${video.title}`];
  if (meta) lines.push(`    ${meta}`);

  const body = video.description || video.snippet;
  if (body) lines.push(`    ${truncate(body, DESCRIPTION_CHARS_FOR_RANKING)}`);
  if (video.transcript) {
    lines.push(`    Transcript: ${truncate(video.transcript, DESCRIPTION_CHARS_FOR_RANKING)}`);
  }

  return lines.join('\n');
}

export function buildRankPrompt(videos, { profileLabel, intent, query }) {
  const list = videos.map((video, index) => describeVideo(video, index + 1)).join('\n\n');

  // The stated intent is the rubric; the profession is a tie-breaker on top of
  // it. A reader who says what they want has overridden what their job implies,
  // so a video that serves the intent must outscore one that merely suits the
  // profession.
  const goal = intent && intent.trim()
    ? `The reader's stated intent, which is the primary thing you are scoring against:
${intent.trim()}

Their background is ${profileLabel}. Use it only to break ties between videos that serve the intent equally well - never to favour a video that fits the background but not the intent.`
    : `The reader has not stated an intent, so judge by what a ${profileLabel} would find most useful.`;

  return `You are ranking YouTube videos.

${goal}
${query ? `They searched for: ${query}` : ''}

Videos:
${list}

Score every video from 0 to 10 for how well it serves the reader's stated intent. A video that directly answers the intent scores high even if it is basic; a polished video that does not address the intent scores low however good it is. Judge actual substance: depth, specificity, and whether it covers what the reader asked for. Penalise clickbait, shallow overviews and off-topic videos.

Respond with ONLY a JSON array, one object per video, no other text:
[{"id": 1, "score": 7, "reason": "short justification"}]

Every reason must be under 15 words. Include every video id from 1 to ${videos.length}.`;
}

function coerceEntry(raw) {
  const id = Number(raw.id);
  const score = Number(raw.score);
  if (!Number.isFinite(id)) return null;
  return {
    id,
    score: Number.isFinite(score) ? Math.max(0, Math.min(10, score)) : null,
    reason: typeof raw.reason === 'string' ? raw.reason.trim() : '',
  };
}

// Small models drift from strict JSON, and losing the whole ranking to one
// stray token is not acceptable - so try progressively looser reads before
// giving up.
export function parseRanking(rawOutput) {
  const text = stripCodeFences(rawOutput);

  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        const entries = parsed.map(coerceEntry).filter(Boolean);
        if (entries.length) return { entries, degraded: false };
      }
    } catch (e) {
      // Fall through to the per-object salvage below.
    }
  }

  // Salvage pass: pick out whatever individual objects did come out well-formed.
  const entries = [];
  for (const match of text.matchAll(/\{[^{}]*\}/g)) {
    try {
      const entry = coerceEntry(JSON.parse(match[0]));
      if (entry) entries.push(entry);
    } catch (e) {
      // Skip this object.
    }
  }

  if (entries.length) return { entries, degraded: true };
  return { entries: [], degraded: true };
}

// Applies parsed scores to the videos and sorts. Unscored videos keep their page
// order and sort last, so a partial ranking still produces a usable list.
export function applyRanking(videos, entries) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));

  const scored = videos.map((video, index) => {
    const entry = byId.get(index + 1);
    return {
      ...video,
      pageRank: index,
      score: entry ? entry.score : null,
      reason: entry ? entry.reason : '',
    };
  });

  return scored.sort((a, b) => {
    const aScore = a.score === null ? -1 : a.score;
    const bScore = b.score === null ? -1 : b.score;
    if (aScore !== bScore) return bScore - aScore;
    return a.pageRank - b.pageRank;
  });
}

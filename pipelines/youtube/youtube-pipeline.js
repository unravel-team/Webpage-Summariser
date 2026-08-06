// YouTube search results: rank the results by intent instead of summarising the
// page.
//
// Stages are deliberately separate calls over the same `videos` array:
//
//   collect -> enrich (descriptions) -> rank -> synthesize (top N)
//
// so the planned second round - fetch transcripts for the top 5, run rank()
// again over just those - is an insertion between rank and synthesize, not a
// rewrite. Each stage takes videos and returns videos.

import { litertClient } from '../../llm/litert-client.js';
import { collectFromTab, MAX_VIDEOS } from './collect.js';
import { runEnrichers } from './enrich.js';
import { buildRankPrompt, parseRanking, applyRanking } from './rank.js';
import { buildOverviewPrompt } from './synthesize.js';
import { linkifyCitations, topPickCard, runnersUpList, noticeBanner } from './render.js';

const SEARCH_URL_RE = /^https?:\/\/(www\.)?youtube\.com\/results\b/i;

// How many of the ranked videos get written up and cited in the prose.
const TOP_N = 5;

export const youtubeSearchPipeline = {
  id: 'youtube-search',
  idleLabel: 'Rank These Results',
  doneLabel: 'Ranked — tap to run again',

  // Scoring is meaningless without something to score against - the search
  // query alone does not say what the reader actually wants out of it.
  requiresIntent: true,
  intentPlaceholder: 'What do you want out of these videos?',
  missingIntentMessage: 'Tell me what you are looking for first',

  matches(url) {
    return SEARCH_URL_RE.test(url);
  },

  async run({ tab, profileLabel, intent, setStatus, setProgress, output, ensureModel }) {
    // 1. Collect
    setStatus('extracting', 'Reading search results...');
    const { query, videos } = await collectFromTab(tab.id, MAX_VIDEOS);

    if (!videos.length) {
      output.clear();
      output.append(
        noticeBanner('No video results found on this page. Try scrolling the results, then run again.')
      );
      return;
    }

    // 2. Enrich - descriptions today, transcripts later. Best effort: a video
    // whose fetch fails is still ranked on its title and on-page snippet.
    setStatus('extracting', `Fetching descriptions (0/${videos.length})...`);
    await runEnrichers(videos, {
      onProgress: ({ done, total }) => {
        setStatus('extracting', `Fetching descriptions (${done}/${total})...`);
        setProgress(Math.round((done / total) * 100));
      },
    });
    setProgress(null);

    const enrichedCount = videos.filter((video) => video.description).length;
    console.log(`Collected ${videos.length} videos, ${enrichedCount} with descriptions`);

    await ensureModel();

    // 3. Rank
    setStatus('generating', `Scoring ${videos.length} videos...`);
    const rankPrompt = buildRankPrompt(videos, { profileLabel, intent, query });
    const rankOutput = await litertClient.summarise(rankPrompt);
    const { entries, degraded } = parseRanking(rankOutput);
    if (degraded) {
      console.warn('Ranking output was not clean JSON; salvaged entries:', entries.length, rankOutput);
    }
    const ranked = applyRanking(videos, entries);
    const topVideos = ranked.slice(0, TOP_N);

    // 4. Synthesize - streamed prose citing the top videos by index.
    setStatus('generating', 'Writing the briefing...');
    output.clear();

    if (!entries.length) {
      output.append(
        noticeBanner("Couldn't score these reliably — showing them in page order.")
      );
    }

    const overviewPrompt = buildOverviewPrompt(topVideos, { profileLabel, intent, query });
    let prose = '';
    await litertClient.summarise(overviewPrompt, (token) => {
      prose += token;
      output.stream(prose, (html) => linkifyCitations(html, topVideos));
    });

    // 5. The links themselves, built from collected data rather than model text.
    if (topVideos[0]) output.append(topPickCard(topVideos[0]));
    const rest = ranked.slice(1, TOP_N);
    if (rest.length) output.append(runnersUpList(rest));
  },
};

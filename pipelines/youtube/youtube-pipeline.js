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

// Videos scored per model call. Scoring all 20 at once is a ~2.7k-token prefill
// in a single submit, which is enough GPU work to lose the WebGPU device - and
// the device is memoized on the WASM module, so losing it breaks every later
// run too. Batching caps the largest prefill at ~2.2k tokens. Scores stay
// comparable because every batch is judged against the same rubric and the same
// stated intent.
const RANK_BATCH_SIZE = 16;

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

    // 3. Rank, a batch at a time.
    const entries = [];
    for (let start = 0; start < videos.length; start += RANK_BATCH_SIZE) {
      const batch = videos.slice(start, start + RANK_BATCH_SIZE);
      const done = start + batch.length;
      setStatus('generating', `Scoring videos (${done}/${videos.length})...`);
      setProgress(Math.round((done / videos.length) * 100));

      const rankPrompt = buildRankPrompt(batch, { profileLabel, intent, query });
      const rankOutput = await litertClient.summarise(rankPrompt);
      const { entries: batchEntries, degraded } = parseRanking(rankOutput);
      if (degraded) {
        console.warn(
          `Ranking output for videos ${start + 1}-${done} was not clean JSON; salvaged entries:`,
          batchEntries.length,
          rankOutput
        );
      }

      // The model scores each batch as 1..n, so shift the ids back onto the
      // full list and drop anything it invented outside the batch.
      for (const entry of batchEntries) {
        if (entry.id >= 1 && entry.id <= batch.length) {
          entries.push({ ...entry, id: entry.id + start });
        }
      }
    }
    setProgress(null);

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

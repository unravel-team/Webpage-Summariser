// Enrichment layer: adds fields to collected videos that the page itself does
// not carry.
//
// Each enricher is independent and best-effort - a failure only means that one
// video is ranked on less information, never that the run fails. Adding a new
// signal (a transcript, comment sentiment, a channel reputation lookup) means
// writing one module with the same shape and passing it in; the ranking prompt
// renders whichever fields are present, so nothing downstream changes.

import { descriptionEnricher } from './enrichers/description.js';

// enricher = { name, appliesTo(video) -> boolean, async enrich(video) -> fields }
export const ENRICHERS = [descriptionEnricher];

export const DEFAULT_CONCURRENCY = 6;

// Merges the output of every applicable enricher into each video, in place.
// Runs at most `concurrency` videos at a time so a 20-result page does not open
// 20 parallel page fetches.
export async function runEnrichers(videos, options = {}) {
  const {
    enrichers = ENRICHERS,
    concurrency = DEFAULT_CONCURRENCY,
    onProgress,
  } = options;

  let done = 0;
  let next = 0;

  const enrichOne = async (video) => {
    for (const enricher of enrichers) {
      if (!enricher.appliesTo(video)) continue;
      try {
        Object.assign(video, await enricher.enrich(video));
      } catch (error) {
        console.warn(`Enricher "${enricher.name}" failed for ${video.videoId}:`, error);
      }
    }
  };

  const worker = async () => {
    while (next < videos.length) {
      const video = videos[next++];
      await enrichOne(video);
      done += 1;
      if (onProgress) onProgress({ done, total: videos.length });
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, videos.length) }, worker)
  );

  return videos;
}

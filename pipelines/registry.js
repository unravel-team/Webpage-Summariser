// Chooses which extraction/prompting pipeline handles the active tab.
//
// Pipelines are tried in order and the first match wins, so the generic summary
// pipeline (which matches everything) must stay last. Adding a surface - the
// YouTube homepage feed, a watch page, a docs site - means writing a module and
// inserting it above summaryPipeline; nothing else in the panel changes.

import { summaryPipeline } from './summary-pipeline.js';
import { youtubeSearchPipeline } from './youtube/youtube-pipeline.js';

const PIPELINES = [youtubeSearchPipeline, summaryPipeline];

export function selectPipeline(url) {
  return PIPELINES.find((pipeline) => pipeline.matches(url || '')) || summaryPipeline;
}

# TLDR

A Chrome side-panel extension that reads the page you are on and tells you what
matters **to you**, entirely on your machine. Nothing is sent to a server: the
model (Gemma 4 E4B-it) runs in the browser on WebGPU via
[LiteRT-LM](https://github.com/google-ai-edge/litert-lm).

Two things shape every answer:

- **Profile** — your profession, set once in Settings.
- **Intent** — what you want out of *this* page, typed in the side panel.

## What it does

| Where you are | What happens |
| --- | --- |
| Any page | Extracts the readable text and summarises it for your profile and intent. |
| `youtube.com/results?search_query=…` | Ignores the page text. Collects the result cards, fetches each video's real description, scores every video against your intent, and writes a short briefing with citation links, plus a card for the top pick with chapter jump links. |

On YouTube search the intent field is **required** — there is nothing to score
against without it. The field re-labels itself as you navigate, including
YouTube's client-side routing.

## Install

Requires Chrome with WebGPU (check `chrome://gpu`).

```bash
git clone git@github.com:unravel-team/Webpage-Summariser.git
cd Webpage-Summariser
npm install          # only needed to refresh vendor/, which is committed
```

1. Open `chrome://extensions`, enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Click the extension icon to open the side panel.
4. Set your profession in Settings (gear icon).

The first run downloads ~3 GB of model weights. They are cached in IndexedDB in
64 MiB chunks and resumed via HTTP Range if the download is interrupted, so it
only happens once — but the download only progresses while the side panel is
open.

## Architecture

```
manifest.json          MV3 side panel, <all_urls> host permissions
background.js          opens the panel on action click
sidepanel/             UI, state machine, markdown renderer
profile/               profile + intent, persisted in chrome.storage.sync
llm/
  litert-client.js     WASM/WebGPU engine, streaming generation
  model-cache.js       chunked IndexedDB cache, resumable download
  prompt-template.js   the generic summary prompt
pipelines/
  registry.js          selectPipeline(url) — first match wins
  summary-pipeline.js  the generic path; matches everything, so it stays last
  youtube/             the search-results path
```

### Pipelines

The panel does not branch on the URL. It asks the registry which pipeline owns
the active tab and hands it a context object:

```js
{
  id, matches(url), idleLabel, doneLabel,
  requiresIntent, intentPlaceholder,
  async run({ tab, profileLabel, intent, setStatus, setProgress, output, ensureModel })
}
```

`output` exposes `clear()`, `stream(markdown, transform?)` and `append(node)` —
streamed prose and appended DOM live in separate containers, so re-rendering the
stream never wipes out cards that were already appended. Adding a surface (the
YouTube homepage feed, a watch page, a docs site) means writing one module and
inserting it above `summaryPipeline` in `pipelines/registry.js`.

### The YouTube pipeline

```
collect → enrich → rank → synthesize
```

- **collect** (`collect.js`) — injected into the page, scrapes up to 20
  `ytd-video-renderer` cards, skipping ads.
- **enrich** (`enrich.js`) — runs an array of independent enrichers over the
  videos, 6 at a time. Today that is `enrichers/description.js`, which fetches
  each watch page and pulls `shortDescription` out of it. Enrichers are
  best-effort: a failure means that video is ranked on less information, never
  that the run fails.
- **rank** (`rank.js`) — one model call that returns JSON scores. The parser is
  deliberately forgiving (fenced JSON → per-object salvage → page order) because
  a small on-device model drifts from strict JSON, and losing the whole ranking
  to one stray token is not acceptable. Sorting happens in JS.
- **synthesize** (`synthesize.js`) — a second, streamed call that writes the
  briefing. It cites videos as `[1]`, `[2]` and is forbidden from writing URLs
  or timestamps.

Every link on screen is built in `render.js` from collected data — a small model
asked to write URLs gets them wrong, and a wrong link is worse than no link.

Each stage takes and returns the same `videos` array, so the next iteration —
fetch transcripts for the top 5 and run `rank()` again over just those — is an
insertion between `rank` and `synthesize`, not a rewrite.

## Development

There is no build step; Chrome loads the source directly. After editing, hit
reload on `chrome://extensions` and reopen the side panel.

The prompt actually sent to the model is logged (collapsed) to the side panel's
console on every generation, along with the pipeline chosen for the tab.

The pure functions — `parseRanking`, `applyRanking`, `parseChapters`,
`linkifyCitations`, and the description extractor — have no DOM or `chrome`
dependencies and can be imported straight into Node for a quick check.

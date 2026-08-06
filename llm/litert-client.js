import { Engine, loadLiteRtLm } from '../vendor/litert-lm-core/dist/index.js';
import { MODEL_URL } from './model-config.js';
import { modelCache } from './model-cache.js';

const WASM_PATH = chrome.runtime.getURL('vendor/litert-lm-core/wasm/');

const MAX_NUM_TOKENS = 8192;

// Logs the exact text handed to the model. Collapsed so it stays out of the way
// during normal use - click it in the console to expand the full prompt.
function logPrompt(prompt) {
  const estimatedTokens = Math.ceil(prompt.length / 4);
  console.groupCollapsed(
    `Prompt sent to model - ${prompt.length} chars, ~${estimatedTokens} tokens`
  );
  console.log(prompt);
  console.groupEnd();
  if (estimatedTokens > MAX_NUM_TOKENS) {
    console.warn(
      `Prompt may exceed maxNumTokens (${MAX_NUM_TOKENS}); the model will truncate it.`
    );
  }
}

class LiteRTClient {
  constructor() {
    this.engine = null;
    this.modelLoaded = false;
    this.modelLoading = false;
    this.loadPromise = null;
    this.wasmInitialized = false;
  }

  // Initialize WASM runtime from LOCAL files (not CDN)
  async initWasm() {
    if (this.wasmInitialized) return;
    console.log('Initializing LiteRT-LM WASM with local files at:', WASM_PATH);
    try {
      await loadLiteRtLm(WASM_PATH);
      this.wasmInitialized = true;
      console.log('WASM runtime initialized successfully from local files');
    } catch (error) {
      console.error('Failed to initialize WASM:', error);
      throw error;
    }
  }

  // Check if WebGPU is available
  async isWebGPUAvailable() {
    try {
      const adapter = await navigator.gpu?.requestAdapter();
      return !!adapter;
    } catch (e) {
      return false;
    }
  }

  // Load the model (Gemma 4 E4B). Concurrent callers share one in-flight load
  // rather than returning early and racing ahead of it.
  async loadModel(onProgress) {
    if (this.modelLoaded) return;
    if (this.loadPromise) return this.loadPromise;

    this.modelLoading = true;
    this.loadPromise = this.doLoadModel(onProgress);

    try {
      await this.loadPromise;
    } finally {
      this.modelLoading = false;
      this.loadPromise = null;
    }
  }

  async doLoadModel(onProgress) {
    try {
      const hasWebGPU = await this.isWebGPUAvailable();
      if (!hasWebGPU) {
        throw new Error('WebGPU is not available in this browser. LiteRT-LM requires WebGPU.');
      }

      // Initialize WASM with LOCAL files first (before Engine.create)
      if (!this.wasmInitialized) {
        await this.initWasm();
      }

      console.log('Loading LiteRT-LM model (Gemma 4 E4B-it)...');

      // Prefer the IndexedDB copy so the model survives closing the side panel
      // or the browser. Any cache failure falls back to streaming from the
      // network, which is exactly what this client did before caching existed.
      let modelSource = MODEL_URL;
      try {
        const status = await modelCache.getStatus(MODEL_URL);
        if (status?.complete) {
          console.log('Using cached model from IndexedDB');
          if (onProgress) {
            onProgress({ status: 'cached', progress: 100, totalBytes: status.totalBytes });
          }
        } else {
          // A network interruption here leaves whole chunks already saved, so
          // the next loadModel() call resumes instead of restarting - this is
          // an expected pause, not a fatal error. Surface it as such rather
          // than falling through to a raw network fetch that's likely also down.
          try {
            await modelCache.download(MODEL_URL, onProgress);
          } catch (downloadError) {
            console.warn('Model download interrupted, can resume on next attempt:', downloadError);
            if (onProgress) onProgress({ status: 'paused' });
            const pausedError = new Error('Model download was interrupted.');
            pausedError.isDownloadPaused = true;
            throw pausedError;
          }
        }
        modelSource = modelCache.createStream();
      } catch (error) {
        if (error.isDownloadPaused) throw error;
        console.warn('Model cache unavailable, streaming from network:', error);
        if (onProgress) onProgress({ status: 'downloading', progress: 0 });
      }

      // WASM is now set up to use local files, not CDN
      console.log('Creating LiteRT-LM Engine...');
      try {
        this.engine = await Engine.create({
          model: modelSource,
          mainExecutorSettings: { maxNumTokens: MAX_NUM_TOKENS },
        });
      } catch (error) {
        if (modelSource === MODEL_URL) throw error;
        // The cached bytes did not load. Drop them and fall back to the network
        // so a bad cache can never permanently break the extension.
        console.warn('Cached model failed to load, discarding it and refetching:', error);
        await modelCache.clear().catch(() => {});
        if (onProgress) onProgress({ status: 'downloading', progress: 0 });
        this.engine = await Engine.create({
          model: MODEL_URL,
          mainExecutorSettings: { maxNumTokens: MAX_NUM_TOKENS },
        });
      }

      this.modelLoaded = true;
      if (onProgress) onProgress({ status: 'ready', progress: 100 });
      console.log('Model and Engine loaded successfully');
    } catch (error) {
      console.error('Error loading model:', error);
      throw error;
    }
  }

  // Summarise the page content with streaming
  async summarise(prompt, onTokenStream) {
    if (!this.modelLoaded || !this.engine) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    console.log('Creating conversation for summarisation...');
    const conversation = await this.engine.createConversation();

    try {
      logPrompt(prompt);
      const stream = conversation.sendMessageStreaming(prompt);

      let fullResponse = '';

      for await (const chunk of stream) {
        for (const item of chunk.content) {
          if (item.type === 'text') {
            const text = item.text;
            fullResponse += text;
            if (onTokenStream) {
              onTokenStream(text);
            }
          }
        }
      }

      console.log('Summarisation complete');
      return fullResponse;
    } catch (error) {
      console.error('Error during summarisation:', error);
      throw error;
    } finally {
      // Each conversation holds its own KV cache sized by maxNumTokens, so it
      // has to be released even when generation throws or is cancelled.
      await conversation.delete();
    }
  }
}

export const litertClient = new LiteRTClient();

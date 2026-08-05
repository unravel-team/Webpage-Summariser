import { Engine, loadLiteRtLm } from '../vendor/litert-lm-core/dist/index.js';

const MODEL_URL = 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm';
const WASM_PATH = chrome.runtime.getURL('vendor/litert-lm-core/wasm/');

class LiteRTClient {
  constructor() {
    this.engine = null;
    this.modelLoaded = false;
    this.modelLoading = false;
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

  // Load the model (Gemma 4 E4B)
  async loadModel(onProgress) {
    if (this.modelLoaded) return;
    if (this.modelLoading) return;

    this.modelLoading = true;

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
      if (onProgress) onProgress({ status: 'downloading', progress: 0 });

      // Create the Engine with the HuggingFace URL
      // WASM is now set up to use local files, not CDN
      console.log('Creating LiteRT-LM Engine with model from:', MODEL_URL);
      this.engine = await Engine.create({
        model: MODEL_URL,
        mainExecutorSettings: { maxNumTokens: 8192 },
      });

      this.modelLoaded = true;
      this.modelLoading = false;
      if (onProgress) onProgress({ status: 'downloading', progress: 100 });
      console.log('Model and Engine loaded successfully');
    } catch (error) {
      this.modelLoading = false;
      console.error('Error loading model:', error);
      throw error;
    }
  }

  // Summarise the page content with streaming
  async summarise(prompt, onTokenStream) {
    if (!this.modelLoaded || !this.engine) {
      throw new Error('Model not loaded. Call loadModel() first.');
    }

    try {
      console.log('Creating conversation for summarisation...');
      const conversation = await this.engine.createConversation();

      console.log('Sending prompt to model...');
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
    }
  }
}

export const litertClient = new LiteRTClient();

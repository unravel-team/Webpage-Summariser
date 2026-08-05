import { MODEL_KEY } from './model-config.js';

const DB_NAME = 'litert-model-cache';
const DB_VERSION = 1;
const CHUNK_STORE = 'chunks';
const META_STORE = 'meta';

// Chunks are stored as Blobs so Chrome keeps them file-backed rather than
// inline in leveldb. 64 MiB gives ~45 records for the 2.97 GB model.
const CHUNK_SIZE = 64 * 1024 * 1024;

// Progress fires on every network read (~64 KB), which is far more often than
// the UI needs. Throttle so we repaint at most every 200ms.
const PROGRESS_INTERVAL_MS = 200;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionToPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

// Pulls exactly `n` bytes off the front of `buffered`, splitting the head
// array if it straddles the boundary.
function takeExact(buffered, n) {
  const parts = [];
  let need = n;
  while (need > 0) {
    const head = buffered[0];
    if (head.length <= need) {
      parts.push(head);
      buffered.shift();
      need -= head.length;
    } else {
      parts.push(head.subarray(0, need));
      buffered[0] = head.subarray(need);
      need = 0;
    }
  }
  return parts;
}

// Content-Range on a 206 already carries the absolute file size ("bytes X-Y/TOTAL").
// Content-Length only describes this response, so on a partial response it has to
// be added to the offset we resumed from.
function readTotalBytes(response, startByte) {
  const contentRange = response.headers.get('content-range');
  if (contentRange) {
    const total = Number(contentRange.split('/')[1]);
    if (Number.isFinite(total) && total > 0) return total;
  }
  const contentLength = Number(response.headers.get('content-length'));
  if (!Number.isFinite(contentLength) || contentLength <= 0) return 0;
  return response.status === 206 ? startByte + contentLength : contentLength;
}

class ModelCache {
  constructor() {
    this.dbPromise = null;
    this.persistRequested = false;
  }

  async open() {
    if (this.dbPromise) return this.dbPromise;

    this.dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(CHUNK_STORE)) db.createObjectStore(CHUNK_STORE);
        if (!db.objectStoreNames.contains(META_STORE)) db.createObjectStore(META_STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB open was blocked'));
    }).catch((error) => {
      this.dbPromise = null;
      throw error;
    });

    this.requestPersistence();
    return this.dbPromise;
  }

  // Belt and braces on top of the unlimitedStorage permission. Never fatal.
  async requestPersistence() {
    if (this.persistRequested) return;
    this.persistRequested = true;
    try {
      if (navigator.storage?.persist && !(await navigator.storage.persisted())) {
        await navigator.storage.persist();
      }
    } catch (error) {
      console.warn('Could not request persistent storage:', error);
    }
  }

  async getMeta() {
    const db = await this.open();
    const tx = db.transaction(META_STORE, 'readonly');
    return requestToPromise(tx.objectStore(META_STORE).get(MODEL_KEY));
  }

  async getChunk(index) {
    const db = await this.open();
    const tx = db.transaction(CHUNK_STORE, 'readonly');
    return requestToPromise(tx.objectStore(CHUNK_STORE).get(index));
  }

  // Writes the chunk and the updated meta in one transaction so chunksDone can
  // never run ahead of the chunks actually on disk.
  async putChunk(index, blob, meta) {
    const db = await this.open();
    const tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
    tx.objectStore(CHUNK_STORE).put(blob, index);
    tx.objectStore(META_STORE).put(meta, MODEL_KEY);
    return transactionToPromise(tx);
  }

  async putMeta(meta) {
    const db = await this.open();
    const tx = db.transaction(META_STORE, 'readwrite');
    tx.objectStore(META_STORE).put(meta, MODEL_KEY);
    return transactionToPromise(tx);
  }

  async clear() {
    const db = await this.open();
    const tx = db.transaction([CHUNK_STORE, META_STORE], 'readwrite');
    tx.objectStore(CHUNK_STORE).clear();
    tx.objectStore(META_STORE).delete(MODEL_KEY);
    return transactionToPromise(tx);
  }

  async getStatus(url) {
    const meta = await this.getMeta();
    if (!meta || meta.url !== url || meta.chunkSize !== CHUNK_SIZE) return null;
    return {
      complete: !!meta.complete,
      chunksDone: meta.chunksDone,
      totalBytes: meta.totalBytes,
      receivedBytes: Math.min(meta.chunksDone * CHUNK_SIZE, meta.totalBytes),
    };
  }

  // Downloads the model into IndexedDB, resuming from the last whole chunk if a
  // previous attempt was interrupted. Safe to call when already complete.
  async download(url, onProgress) {
    let meta = await this.getMeta();

    // A different model URL or a changed chunk size invalidates everything.
    if (meta && (meta.url !== url || meta.chunkSize !== CHUNK_SIZE)) {
      await this.clear();
      meta = null;
    }
    if (meta?.complete) return meta;

    let chunksDone = meta ? meta.chunksDone : 0;
    let startByte = chunksDone * CHUNK_SIZE;

    const headers = {};
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Model download failed: HTTP ${response.status} ${response.statusText}`);
    }

    const etag = response.headers.get('etag');

    // The file changed underneath a partial download: throw the old bytes away
    // and start over. meta is null on the retry, so this cannot recurse twice.
    if (meta && etag && meta.etag && etag !== meta.etag) {
      console.warn('Cached model is stale (etag changed), re-downloading.');
      await response.body.cancel();
      await this.clear();
      return this.download(url, onProgress);
    }

    // We asked to resume but the server sent the whole file anyway. Discard
    // what we had and consume this response from byte 0.
    let resumed = startByte > 0;
    if (resumed && response.status !== 206) {
      console.warn('Server ignored the Range request, restarting download.');
      await this.clear();
      chunksDone = 0;
      startByte = 0;
      resumed = false;
    }

    const totalBytes = readTotalBytes(response, startByte);
    if (!totalBytes) throw new Error('Could not determine the model size from the response.');

    let receivedBytes = startByte;
    let lastEmit = 0;
    const emit = (force) => {
      const now = Date.now();
      if (!force && now - lastEmit < PROGRESS_INTERVAL_MS) return;
      lastEmit = now;
      if (onProgress) {
        onProgress({
          status: 'downloading',
          progress: (receivedBytes / totalBytes) * 100,
          receivedBytes,
          totalBytes,
          resumed,
        });
      }
    };
    emit(true);

    const reader = response.body.getReader();
    const buffered = [];
    let bufferedLength = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffered.push(value);
        bufferedLength += value.length;
        receivedBytes += value.length;

        // Write out whole chunks only. The network read above happens outside
        // any transaction, which is what keeps IDB from auto-closing it.
        while (bufferedLength >= CHUNK_SIZE) {
          const parts = takeExact(buffered, CHUNK_SIZE);
          bufferedLength -= CHUNK_SIZE;
          chunksDone += 1;
          await this.putChunk(chunksDone - 1, new Blob(parts), {
            url,
            etag,
            totalBytes,
            chunkSize: CHUNK_SIZE,
            chunksDone,
            complete: false,
          });
        }

        emit(false);
      }
    } finally {
      reader.releaseLock();
    }

    // Trailing partial chunk.
    if (bufferedLength > 0) {
      chunksDone += 1;
      await this.putChunk(chunksDone - 1, new Blob(buffered), {
        url,
        etag,
        totalBytes,
        chunkSize: CHUNK_SIZE,
        chunksDone,
        complete: false,
      });
    }

    if (receivedBytes !== totalBytes) {
      throw new Error(`Model download is incomplete: got ${receivedBytes} of ${totalBytes} bytes.`);
    }

    const finalMeta = {
      url,
      etag,
      totalBytes,
      chunkSize: CHUNK_SIZE,
      chunksDone,
      complete: true,
    };
    await this.putMeta(finalMeta);
    emit(true);
    return finalMeta;
  }

  // Reads the cached model back one chunk at a time. Engine.create() accepts a
  // ReadableStream directly, so the model is never fully held in memory.
  createStream() {
    let index = 0;
    let chunkCount = 0;

    return new ReadableStream({
      start: async () => {
        const meta = await this.getMeta();
        if (!meta?.complete) throw new Error('Model is not fully cached.');
        chunkCount = meta.chunksDone;
      },
      pull: async (controller) => {
        if (index >= chunkCount) {
          controller.close();
          return;
        }
        const blob = await this.getChunk(index);
        if (!blob) throw new Error(`Cached model is missing chunk ${index}.`);
        index += 1;
        controller.enqueue(new Uint8Array(await blob.arrayBuffer()));
      },
    });
  }
}

export const modelCache = new ModelCache();

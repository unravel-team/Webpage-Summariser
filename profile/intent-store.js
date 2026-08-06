const DEFAULT_INTENT = '';

class IntentStore {
  async getIntent() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ intent: DEFAULT_INTENT }, (result) => {
        resolve(result.intent);
      });
    });
  }

  async saveIntent(intent) {
    return new Promise((resolve) => {
      chrome.storage.sync.set({ intent }, () => {
        resolve();
      });
    });
  }
}

export const intentStore = new IntentStore();

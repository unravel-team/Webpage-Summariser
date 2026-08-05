const DEFAULT_PROFILE = {
  preset: 'engineer',
  customLabel: '',
};

const PRESETS = {
  engineer: 'Software Engineer',
  lawyer: 'Lawyer',
  doctor: 'Doctor',
  student: 'Student',
};

class ProfileStore {
  async getProfile() {
    return new Promise((resolve) => {
      chrome.storage.sync.get({ profile: DEFAULT_PROFILE }, (result) => {
        resolve(result.profile);
      });
    });
  }

  async saveProfile(profile) {
    return new Promise((resolve) => {
      chrome.storage.sync.set({ profile }, () => {
        resolve();
      });
    });
  }

  getProfileLabel(profile) {
    if (profile.preset === 'other') {
      return profile.customLabel || 'Custom';
    }
    return PRESETS[profile.preset] || 'Unknown';
  }

  getPresets() {
    return PRESETS;
  }
}

export const profileStore = new ProfileStore();

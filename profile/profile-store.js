const DEFAULT_PROFILE = {
  preset: 'engineer',
  customLabel: '',
};

// Keep in sync with the <select> options in sidepanel/sidepanel.html.
const PRESETS = {
  engineer: 'Software Engineer',
  lawyer: 'Lawyer',
  doctor: 'Doctor',
  student: 'Student',
  'product-manager': 'Product Manager',
  designer: 'Designer',
  'data-scientist': 'Data Scientist',
  marketer: 'Marketer',
  'financial-analyst': 'Financial Analyst',
  teacher: 'Teacher',
  journalist: 'Journalist',
  entrepreneur: 'Entrepreneur',
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

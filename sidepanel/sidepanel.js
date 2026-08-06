// Import dependencies
import { profileStore } from '../profile/profile-store.js';
import { intentStore } from '../profile/intent-store.js';
import { litertClient } from '../llm/litert-client.js';
import { renderMarkdown } from './markdown.js';
import { selectPipeline } from '../pipelines/registry.js';

// State management
let currentState = 'idle'; // idle, extracting, downloading, generating, done, error
let selectedPreset = 'engineer';

// The pipeline for the active tab, resolved on load and whenever the tab
// changes, so the button can say what it will actually do.
let activePipeline = selectPipeline('');

// Icons (inline SVG inner markup) for the profile chip grid, one per preset key.
const PROFILE_ICONS = {
  engineer: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  lawyer: '<line x1="12" y1="3" x2="12" y2="21"/><path d="M5 7h14"/><path d="M5 7l-3 7a3 3 0 0 0 6 0z"/><path d="M19 7l-3 7a3 3 0 0 0 6 0z"/>',
  doctor: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  student: '<path d="M22 10L12 4 2 10l10 6 10-6z"/><path d="M6 12v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  'product-manager': '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>',
  designer: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/>',
  'data-scientist': '<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>',
  marketer: '<path d="M3 10v4a1 1 0 0 0 1 1h3l5 4V5L7 9H4a1 1 0 0 0-1 1z"/><path d="M16 8a4 4 0 0 1 0 8"/>',
  'financial-analyst': '<polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/>',
  teacher: '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>',
  journalist: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>',
  entrepreneur: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  other: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
};

// DOM elements (wait for DOM to be ready)
let actionBtn, actionLabel, actionProgress, resultsDiv, profileGrid, customProfileDiv, customProfileInput,
  settingsFeedback, themeToggleBtn, copyBtn, settingsToggleBtn, settingsCloseBtn, settingsDrawer, settingsBackdrop,
  intentInput, intentRequired;

function initDOMElements() {
  actionBtn = document.getElementById('actionBtn');
  intentInput = document.getElementById('intentInput');
  intentRequired = document.getElementById('intentRequired');
  actionLabel = actionBtn.querySelector('.action-label');
  actionProgress = actionBtn.querySelector('.action-progress');
  resultsDiv = document.getElementById('results');
  profileGrid = document.getElementById('profileGrid');
  customProfileDiv = document.getElementById('customProfileDiv');
  customProfileInput = document.getElementById('customProfile');
  settingsFeedback = document.getElementById('settingsFeedback');
  themeToggleBtn = document.getElementById('themeToggle');
  copyBtn = document.getElementById('copyBtn');
  settingsToggleBtn = document.getElementById('settingsToggle');
  settingsCloseBtn = document.getElementById('settingsClose');
  settingsDrawer = document.getElementById('settingsDrawer');
  settingsBackdrop = document.getElementById('settingsBackdrop');
}

// Theme: 'system' (default, follows OS) or an explicit 'light'/'dark' override
async function loadTheme() {
  const { theme } = await new Promise((resolve) => {
    chrome.storage.sync.get({ theme: 'system' }, resolve);
  });
  applyTheme(theme);
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.dataset.theme = theme;
  } else {
    delete document.documentElement.dataset.theme;
  }
}

// Cycles system -> (opposite of current appearance) -> the other -> system,
// so there's always a way back to following the OS setting, and the very
// first click from "system" always visibly flips the theme (rather than
// silently locking in an override that happens to match the OS already).
function toggleTheme() {
  const current = document.documentElement.dataset.theme; // 'light' | 'dark' | undefined (system)
  let next;
  if (current === undefined) {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    next = prefersDark ? 'light' : 'dark';
  } else if (current === 'light') {
    next = 'dark';
  } else {
    next = 'system';
  }
  applyTheme(next);
  chrome.storage.sync.set({ theme: next });
}

async function copyResults() {
  const text = resultsDiv.innerText.trim();
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    copyBtn.classList.add('copied');
    setTimeout(() => copyBtn.classList.remove('copied'), 1500);
  } catch (error) {
    console.error('Copy failed:', error);
  }
}

function openSettingsDrawer() {
  settingsDrawer.classList.add('open');
  settingsBackdrop.classList.add('open');
}

function closeSettingsDrawer() {
  settingsDrawer.classList.remove('open');
  settingsBackdrop.classList.remove('open');
}

// Build the profile chip grid from the presets defined in profile-store.js
function renderProfileGrid() {
  const presets = profileStore.getPresets();
  const entries = [...Object.entries(presets), ['other', 'Other (custom)']];

  profileGrid.innerHTML = '';
  entries.forEach(([key, label]) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'profile-chip';
    chip.dataset.preset = key;
    chip.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        ${PROFILE_ICONS[key] || PROFILE_ICONS.other}
      </svg>
      <span>${label}</span>
    `;
    chip.addEventListener('click', () => selectPreset(key));
    profileGrid.appendChild(chip);
  });
}

function selectPreset(key) {
  selectedPreset = key;
  [...profileGrid.children].forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.preset === key);
  });
  updateCustomProfileUI();
  saveProfile();
}

function updateCustomProfileUI() {
  customProfileDiv.classList.toggle('show', selectedPreset === 'other');
}

// Load profile on startup
async function loadProfile() {
  const profile = await profileStore.getProfile();
  selectedPreset = profile.preset;
  customProfileInput.value = profile.customLabel;
  [...profileGrid.children].forEach((chip) => {
    chip.classList.toggle('selected', chip.dataset.preset === selectedPreset);
  });
  updateCustomProfileUI();
}

async function saveProfile() {
  const customLabel = customProfileInput.value;

  if (selectedPreset === 'other' && !customLabel.trim()) {
    customProfileInput.classList.add('invalid');
    settingsFeedback.textContent = 'Please describe your background before saving.';
    settingsFeedback.classList.remove('success');
    settingsFeedback.classList.add('error');
    return;
  }

  customProfileInput.classList.remove('invalid');
  const profile = { preset: selectedPreset, customLabel };
  await profileStore.saveProfile(profile);
  settingsFeedback.textContent = 'Saved successfully!';
  settingsFeedback.classList.remove('error');
  settingsFeedback.classList.add('success');
  setTimeout(() => {
    settingsFeedback.textContent = '';
    settingsFeedback.classList.remove('success');
  }, 2000);
}

// Load/save the optional per-summary intent (persisted like the profile)
async function loadIntent() {
  intentInput.value = await intentStore.getIntent();
}

function saveIntent() {
  intentStore.saveIntent(intentInput.value.trim());
}

// Update UI state
function setState(state, message = '') {
  currentState = state;
  actionBtn.dataset.state = state;
  actionBtn.disabled = state !== 'idle' && state !== 'done' && state !== 'error' && state !== 'paused';
  actionProgress.style.width = '';

  const stateMessages = {
    idle: activePipeline.idleLabel,
    extracting: 'Extracting page content...',
    downloading: 'Downloading model (first time only)...',
    generating: 'Generating summary...',
    done: activePipeline.doneLabel,
    error: 'An error occurred. Please try again.',
    paused: 'Download paused — tap to resume',
  };

  actionLabel.textContent = message || stateMessages[state];
}

// Loads the model on first use. Pipelines call this once they have their input
// ready, so the download only starts for a run that can actually use it.
async function ensureModel() {
  if (litertClient.modelLoaded) return;

  setState('downloading');
  await litertClient.loadModel((progress) => {
    if (progress.status === 'cached') {
      actionLabel.textContent = 'Loading model from cache...';
    } else if (progress.status === 'downloading') {
      const pct = Math.round(progress.progress);
      const suffix = progress.resumed ? ' (resumed)' : '';
      actionLabel.textContent = `Downloading model… ${pct}%${suffix}`;
      actionProgress.style.width = `${pct}%`;
    } else if (progress.status === 'ready') {
      actionLabel.textContent = 'Model ready';
    } else if (progress.status === 'paused') {
      actionLabel.textContent = 'Download paused...';
    }
  });
}

// The results area a pipeline writes to. Streamed prose and appended DOM live in
// separate containers so re-rendering the stream never wipes out cards that were
// already appended.
function createOutput() {
  let prose = null;
  let extras = null;

  const ensureContainers = () => {
    if (prose && prose.isConnected) return;
    resultsDiv.textContent = '';
    resultsDiv.classList.remove('empty');
    prose = document.createElement('div');
    prose.className = 'result-prose';
    extras = document.createElement('div');
    extras.className = 'result-extras';
    resultsDiv.append(prose, extras);
  };

  return {
    clear() {
      prose = null;
      ensureContainers();
    },
    // `transform` gets the rendered HTML and may post-process it - the YouTube
    // pipeline uses it to turn [1] markers into citation links.
    stream(markdown, transform) {
      ensureContainers();
      const html = renderMarkdown(markdown);
      prose.innerHTML = transform ? transform(html) : html;
    },
    append(node) {
      ensureContainers();
      extras.appendChild(node);
    },
  };
}

async function summarise() {
  try {
    // Get user's profile — fail fast rather than guessing a label
    const profile = await profileStore.getProfile();
    const profileLabel = profileStore.getProfileLabel(profile);
    if (!profileLabel) {
      setState('error', 'Please set your profession in Settings — tap the gear icon');
      openSettingsDrawer();
      return;
    }

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) {
      setState('error', 'Unable to access the current tab — tap to retry');
      return;
    }

    // The tab may have navigated since the last refresh, so this - not the
    // cached value - decides both the pipeline and whether intent is mandatory.
    activePipeline = selectPipeline(tab.url);
    applyIntentRequirement();

    const intent = intentInput.value.trim();
    if (activePipeline.requiresIntent && !intent) {
      intentInput.classList.add('invalid');
      intentInput.focus();
      setState(
        'error',
        activePipeline.missingIntentMessage || 'Add an intent above, then tap to run'
      );
      return;
    }

    console.log(`Running "${activePipeline.id}" pipeline for ${tab.url}`);

    resultsDiv.textContent = '';
    resultsDiv.classList.remove('empty');

    await activePipeline.run({
      tab,
      profileLabel,
      intent,
      setStatus: (state, message) => setState(state, message),
      setProgress: (pct) => {
        actionProgress.style.width = pct === null || pct === undefined ? '' : `${pct}%`;
      },
      output: createOutput(),
      ensureModel,
    });

    setState('done');
  } catch (error) {
    if (error.isDownloadPaused) {
      console.warn('Model download paused:', error);
      setState('paused', 'Download paused — tap to resume');
      return;
    }
    console.error('Pipeline error:', error);
    setState('error', `Error: ${error.message} — tap to retry`);
  }
}

// Whether the intent is optional or mandatory depends on which pipeline owns
// the current tab, so the field re-labels itself as the user navigates.
function applyIntentRequirement() {
  const required = Boolean(activePipeline.requiresIntent);
  intentRequired.hidden = !required;
  intentInput.setAttribute('aria-required', String(required));
  intentInput.placeholder =
    activePipeline.intentPlaceholder || 'e.g., focus on pricing, security risks...';
  if (!required || intentInput.value.trim()) {
    intentInput.classList.remove('invalid');
  }
}

// Keep the idle button label and the intent field honest about what the active
// tab will do. Called on load, on tab switch, and on in-tab navigation - YouTube
// routes client-side, so leaving the search page has to relax the requirement
// just as arriving on it imposes it.
async function refreshActivePipeline() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activePipeline = selectPipeline(tab && tab.url);
  } catch (error) {
    activePipeline = selectPipeline('');
  }
  applyIntentRequirement();
  if (currentState === 'idle' || currentState === 'done') {
    setState(currentState);
  }
}

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  initDOMElements();
  renderProfileGrid();
  setupEventListeners();
  await loadTheme();
  await loadProfile();
  await loadIntent();
  await refreshActivePipeline();
  setState('idle');
});

function setupEventListeners() {
  intentInput.addEventListener('change', saveIntent);
  intentInput.addEventListener('input', () => {
    if (intentInput.value.trim()) intentInput.classList.remove('invalid');
  });
  customProfileInput.addEventListener('change', saveProfile);
  customProfileInput.addEventListener('input', () => {
    customProfileInput.classList.remove('invalid');
  });
  actionBtn.addEventListener('click', () => {
    if (currentState === 'idle' || currentState === 'done' || currentState === 'error' || currentState === 'paused') {
      summarise();
    }
  });
  themeToggleBtn.addEventListener('click', toggleTheme);
  copyBtn.addEventListener('click', copyResults);
  chrome.tabs.onActivated.addListener(refreshActivePipeline);
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && tab.active) refreshActivePipeline();
  });
  settingsToggleBtn.addEventListener('click', openSettingsDrawer);
  settingsCloseBtn.addEventListener('click', closeSettingsDrawer);
  settingsBackdrop.addEventListener('click', closeSettingsDrawer);
}

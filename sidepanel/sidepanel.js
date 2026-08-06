// Import dependencies
import { profileStore } from '../profile/profile-store.js';
import { intentStore } from '../profile/intent-store.js';
import { buildPrompt } from '../llm/prompt-template.js';
import { litertClient } from '../llm/litert-client.js';
import { renderMarkdown } from './markdown.js';

// State management
let currentState = 'idle'; // idle, extracting, downloading, generating, done, error
let selectedPreset = 'engineer';

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
  intentInput;

function initDOMElements() {
  actionBtn = document.getElementById('actionBtn');
  intentInput = document.getElementById('intentInput');
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
    idle: 'Summarise This Page',
    extracting: 'Extracting page content...',
    downloading: 'Downloading model (first time only)...',
    generating: 'Generating summary...',
    done: 'Summary complete — tap to summarise again',
    error: 'An error occurred. Please try again.',
    paused: 'Download paused — tap to resume',
  };

  actionLabel.textContent = message || stateMessages[state];
}

async function summarise() {
  try {
    // Step 1: Get user's profile — fail fast rather than guessing a label
    const profile = await profileStore.getProfile();
    const profileLabel = profileStore.getProfileLabel(profile);
    if (!profileLabel) {
      setState('error', 'Please set your profession in Settings — tap the gear icon');
      openSettingsDrawer();
      return;
    }

    setState('extracting');
    resultsDiv.textContent = '';
    resultsDiv.classList.remove('empty');

    // Step 2: Extract page content
    const [result] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!result) {
      setState('error', 'Unable to access the current tab — tap to retry');
      return;
    }

    const injectionResult = await chrome.scripting.executeScript({
      target: { tabId: result.id },
      function: extractPageContent,
    });

    if (!injectionResult || !injectionResult[0]) {
      setState('error', 'Failed to extract page content — tap to retry');
      return;
    }

    const { title, url, text } = injectionResult[0].result;

    // Step 3: Load model (first time) and generate summary
    if (!litertClient.modelLoaded) {
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

    setState('generating');

    // Step 4: Build prompt and stream response
    const intent = intentInput.value.trim();
    const prompt = buildPrompt(profileLabel, title, url, text, intent);

    resultsDiv.textContent = '';
    let fullResponse = '';

    await litertClient.summarise(prompt, (token) => {
      fullResponse += token;
      resultsDiv.innerHTML = renderMarkdown(fullResponse);
    });

    setState('done');
  } catch (error) {
    if (error.isDownloadPaused) {
      console.warn('Model download paused:', error);
      setState('paused', 'Download paused — tap to resume');
      return;
    }
    console.error('Summarise error:', error);
    setState('error', `Error: ${error.message} — tap to retry`);
  }
}

// Helper: extract page content (injected into the page)
function extractPageContent() {
  const title = document.title || '';
  const url = window.location.href;

  const bodyClone = document.body.cloneNode(true);

  const elementsToRemove = bodyClone.querySelectorAll(
    'script, style, nav, footer, [style*="display:none"], [hidden], iframe, noscript'
  );
  elementsToRemove.forEach((el) => el.remove());

  let text = bodyClone.innerText || bodyClone.textContent || '';
  text = text.replace(/\s+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  const MAX_LENGTH = 8000;
  if (text.length > MAX_LENGTH) {
    text = text.substring(0, MAX_LENGTH) + '...';
  }

  return { title, url, text };
}

// Initialize on load
document.addEventListener('DOMContentLoaded', async () => {
  initDOMElements();
  renderProfileGrid();
  setupEventListeners();
  await loadTheme();
  await loadProfile();
  await loadIntent();
  setState('idle');
});

function setupEventListeners() {
  intentInput.addEventListener('change', saveIntent);
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
  settingsToggleBtn.addEventListener('click', openSettingsDrawer);
  settingsCloseBtn.addEventListener('click', closeSettingsDrawer);
  settingsBackdrop.addEventListener('click', closeSettingsDrawer);
}

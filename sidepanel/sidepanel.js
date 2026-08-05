// Import dependencies
import { profileStore } from '../profile/profile-store.js';
import { buildPrompt } from '../llm/prompt-template.js';
import { litertClient } from '../llm/litert-client.js';

// State management
let currentState = 'idle'; // idle, extracting, downloading, generating, done, error

// DOM elements (wait for DOM to be ready)
let summariseBtn, resultsDiv, statusDiv, profileSelect, customProfileDiv, customProfileInput, settingsFeedback, tabButtons, tabContents;

function initDOMElements() {
  summariseBtn = document.getElementById('summariseBtn');
  resultsDiv = document.getElementById('results');
  statusDiv = document.getElementById('status');
  profileSelect = document.getElementById('profileSelect');
  customProfileDiv = document.getElementById('customProfileDiv');
  customProfileInput = document.getElementById('customProfile');
  settingsFeedback = document.getElementById('settingsFeedback');
  tabButtons = document.querySelectorAll('.tab-btn');
  tabContents = document.querySelectorAll('.tab-content');
}

// Load profile on startup
async function loadProfile() {
  const profile = await profileStore.getProfile();
  profileSelect.value = profile.preset;
  customProfileInput.value = profile.customLabel;
  updateCustomProfileUI();
}

function updateCustomProfileUI() {
  const isOther = profileSelect.value === 'other';
  customProfileDiv.style.display = isOther ? 'block' : 'none';
}

async function saveProfile() {
  const profile = {
    preset: profileSelect.value,
    customLabel: customProfileInput.value,
  };
  await profileStore.saveProfile(profile);
  settingsFeedback.textContent = 'Saved successfully!';
  settingsFeedback.classList.add('success');
  setTimeout(() => {
    settingsFeedback.textContent = '';
    settingsFeedback.classList.remove('success');
  }, 2000);
}

// Update UI state
function setState(state, message = '') {
  currentState = state;
  statusDiv.className = `status ${state}`;
  summariseBtn.disabled = state !== 'idle' && state !== 'done' && state !== 'error';

  const statusMessages = {
    idle: 'Ready to summarise',
    extracting: 'Extracting page content...',
    downloading: 'Downloading model (first time only)...',
    generating: 'Generating summary...',
    done: 'Summary complete!',
    error: 'An error occurred. Please try again.',
  };

  statusDiv.textContent = message || statusMessages[state];
}

async function summarise() {
  try {
    setState('extracting');
    resultsDiv.textContent = '';

    // Step 1: Extract page content
    const [result] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!result) {
      setState('error', 'Unable to access the current tab.');
      return;
    }

    const injectionResult = await chrome.scripting.executeScript({
      target: { tabId: result.id },
      function: extractPageContent,
    });

    if (!injectionResult || !injectionResult[0]) {
      setState('error', 'Failed to extract page content.');
      return;
    }

    const { title, url, text } = injectionResult[0].result;

    // Step 2: Get user's profile
    const profile = await profileStore.getProfile();
    const profileLabel = profileStore.getProfileLabel(profile);

    // Step 3: Load model (first time) and generate summary
    if (!litertClient.modelLoaded) {
      setState('downloading');
      await litertClient.loadModel((progress) => {
        if (progress.status === 'downloading') {
          const pct = Math.round(progress.progress);
          statusDiv.textContent = `Downloading model... ${pct}%`;
        }
      });
    }

    setState('generating');

    // Step 4: Build prompt and stream response
    const prompt = buildPrompt(profileLabel, title, url, text);

    resultsDiv.textContent = '';
    let fullResponse = '';

    await litertClient.summarise(prompt, (token) => {
      fullResponse += token;
      resultsDiv.textContent = fullResponse;
    });

    setState('done', 'Summary complete!');
  } catch (error) {
    console.error('Summarise error:', error);
    setState('error', `Error: ${error.message}`);
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
  setupEventListeners();
  await loadProfile();
  setState('idle');
});

function setupEventListeners() {
  if (!summariseBtn) return;
  tabButtons.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const tabName = e.target.dataset.tab;
      tabButtons.forEach((b) => b.classList.remove('active'));
      tabContents.forEach((c) => c.classList.remove('active'));
      e.target.classList.add('active');
      document.getElementById(tabName).classList.add('active');
    });
  });

  profileSelect.addEventListener('change', updateCustomProfileUI);
  profileSelect.addEventListener('change', saveProfile);
  customProfileInput.addEventListener('change', saveProfile);
  summariseBtn.addEventListener('click', summarise);
}

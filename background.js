// Clicking the toolbar icon opens the side panel. This is set at service worker
// startup rather than handled via action.onClicked, because sidePanel.open()
// must run inside the user gesture and that window can lapse while a cold
// service worker starts up.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Could not set side panel behavior:', error));

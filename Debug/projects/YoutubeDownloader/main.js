// Tizen TV entry point
// The app logic lives in js/app.js, loaded from index.html.
// This file exists because config.xml may reference main.js for Tizen packaging.
window.onload = function () {
  // Register Tizen hardware back-key handler
  if (window.tizen) {
    try {
      tizen.tvinputdevice.registerKey('Back');
      document.addEventListener('keydown', function (e) {
        if (e.keyCode === 10009) { // Tizen back key
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'BrowserBack' }));
        }
      });
    } catch (err) {
      console.warn('Tizen key registration failed:', err);
    }
  }
};

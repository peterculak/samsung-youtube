/**
 * YoutubeDownloader — Server Configuration
 *
 * When testing in a browser on your Mac:       leave SERVER_URL as localhost.
 * When deploying to Samsung TV:                set SERVER_URL to your Mac's local IP,
 *                                              e.g. 'http://192.168.1.42:3000'
 * Find your Mac's IP:  System Settings → Network → Wi-Fi → Details
 */
const CONFIG = {
  SERVER_URL:    'http://192.168.1.149:3000',
  POLL_INTERVAL: 2000,   // ms between auth / job status polls
};

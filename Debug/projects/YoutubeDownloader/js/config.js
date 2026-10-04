/**
 * YoutubeDownloader — Server Configuration
 *
 * The SERVER_URL is automatically updated by server.js when the server starts.
 * You no longer need to edit this manually!
 */
const CONFIG = {
  SERVER_URL: (typeof window !== 'undefined' && window.location.protocol.startsWith('http')) ? '' : 'http://192.168.1.149:3000',
  POLL_INTERVAL: 2000,   // ms between auth / job status polls
};

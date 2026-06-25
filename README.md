# YouTube TV Downloader for Samsung Tizen

A fully-featured, ad-free YouTube streaming and downloading app for Samsung Tizen TVs (including 2024 models).

## Architecture

This application consists of two parts:
1. **The TV App (Frontend)**: A rich, D-pad navigable HTML/JS/CSS application that runs directly on your Samsung TV.
2. **The Mac Server (Backend)**: A lightweight Node.js server that runs on your Mac. It handles YouTube extraction (via `yt-dlp`), authentication, downloading, and streaming video files to the TV.

Because YouTube intentionally obfuscates their video URLs and frequently breaks client-side extraction, the TV relies on the Mac server to do the heavy lifting.

---

## 🚀 Installation Guide

### Part 1: Start the Mac Server

1. Open a terminal on your Mac and navigate to the server folder:
   ```bash
   cd samsung-tv/YoutubeDownloader/server
   ```
2. Install the required Node.js packages (if you haven't already):
   ```bash
   npm install
   ```
3. Start the server:
   ```bash
   node server.js
   ```
   *Note: Leave this terminal window open, or set it up to run automatically on boot. The server must be running for the TV app to function.*

4. **Authentication**: The server uses your Chrome browser's cookies to authenticate with YouTube. You must be logged into youtube.com in Chrome on your Mac for the app to access your subscriptions.

### Part 2: Configure the TV App

1. Find your Mac's local IP address (e.g., `192.168.1.149`).
   * *Hold `Option` and click the Wi-Fi icon in your Mac's menu bar to see it.*
2. Open `samsung-tv/YoutubeDownloader/js/config.js` in a text editor.
3. Update `SERVER_URL` to point to your Mac's IP address:
   ```javascript
   const CONFIG = {
     SERVER_URL: 'http://192.168.1.149:3000',
     POLL_INTERVAL: 2000,
   };
   ```

### Part 3: Enable Developer Mode on your Samsung TV

To install custom apps, your TV must be in Developer Mode. Both your TV and Mac must be connected to the exact same Wi-Fi network.

**For 2024 Models (Tizen 8.0):**
1. Press the **Home** button on your remote.
2. Navigate to the **Apps** panel.
3. Scroll all the way down to the bottom and select **App Settings**.
4. With "App Settings" open, press the **`123`** button on your remote (or use physical numbers) and enter the code: **`12345`**.
5. A "Developer Mode Configuration" popup will appear. Switch it to **ON**.
6. When prompted for a Host PC IP, enter your **Mac's IP address**.
7. **CRITICAL**: Hold down the Power button on your TV remote for ~3 seconds until the TV turns completely off and reboots.

### Part 4: Push the App to the TV

1. Open **VS Code** on your Mac.
2. Install the **Tizen TV** extension if you haven't already.
3. Click the Tizen TV icon in the left sidebar.
4. Under "Device Manager", click `+` to add your TV. Enter your TV's IP address (found in TV Settings -> Network -> Network Status -> IP Settings) and connect.
   * *If the TV prompts you to "Allow" the connection, select Allow.*
5. **Create a Certificate** (One-time setup):
   * Press `Cmd + Shift + P` and search for **Tizen TV: Create Certificate Profile**.
   * Select **Samsung**.
   * Enter an Author name and password.
   * A browser window will open asking you to log into your Samsung account to verify.
6. Open your standard VS Code file explorer.
7. Right-click the `YoutubeDownloader` folder and select **Run On TV**.
8. The app will be permanently installed on your TV and will launch automatically!

---

## 🛠 Troubleshooting

* **App says "Cannot reach server"**: Make sure `node server.js` is running on your Mac. Check that your Mac's firewall isn't blocking port `3000`. Double-check that your Mac's IP hasn't changed.
* **Not logged in / "Verify Connection" fails**: Make sure you are actively logged into YouTube on Chrome on your Mac. Restart the Node server after logging in.
* **Some videos fail to download**: YouTube frequently updates its DRM and age-restriction mechanisms. Make sure you keep `yt-dlp` updated on your Mac by running `pip3 install -U yt-dlp` or `brew upgrade yt-dlp`.

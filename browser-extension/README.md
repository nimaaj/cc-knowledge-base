# Browser bridge

This unpacked Chrome extension executes browser jobs against already signed-in Google Calendar and Slack tabs. It never receives account passwords or API tokens.

1. Open `chrome://extensions`, enable Developer mode, and choose **Load unpacked**.
2. Select this `browser-extension` directory.
3. In the extension options, paste the token from `.data/access-token` and test the connection.
4. Keep signed-in Calendar and Slack tabs open.

Calendar and Slack change their DOM periodically. Adapters are intentionally isolated in `content-calendar.js` and `content-slack.js`; update selectors there without changing the daemon protocol. Write actions require an assistant approval before a job is queued.

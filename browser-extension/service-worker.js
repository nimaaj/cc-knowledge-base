const DEFAULT_URL = "http://127.0.0.1:4317";

async function settings() {
  const value = await chrome.storage.local.get(["daemonUrl", "token"]);
  return { daemonUrl: value.daemonUrl || DEFAULT_URL, token: value.token || "" };
}

async function api(path, init = {}) {
  const { daemonUrl, token } = await settings();
  if (!token) throw new Error("Configure the cc-assistant token in extension options");
  const response = await fetch(new URL(path, daemonUrl), {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
  return body;
}

async function adapterTab(adapter) {
  const pattern = adapter === "google_calendar" ? "https://calendar.google.com/*" : "https://app.slack.com/*";
  const tabs = await chrome.tabs.query({ url: pattern });
  if (!tabs[0]?.id) throw new Error(`Open and sign in to ${adapter.replace("_", " ")} first`);
  return tabs[0];
}

async function execute(job) {
  const tab = await adapterTab(job.adapter);
  await chrome.tabs.update(tab.id, { active: false });
  return chrome.tabs.sendMessage(tab.id, { type: "cc-assistant-job", job });
}

let pollInFlight = false;
async function poll(scheduleNext = true) {
  if (pollInFlight) return;
  pollInFlight = true;
  try {
    const payload = await api("/api/browser/jobs/claim");
    if (payload?.job) {
      try {
        const result = await execute(payload.job);
        if (result?.__error) throw new Error(result.__error);
        await api(`/api/browser/jobs/${payload.job.id}/complete`, {
          method: "POST",
          body: JSON.stringify({ result }),
        });
      } catch (error) {
        await api(`/api/browser/jobs/${payload.job.id}/complete`, {
          method: "POST",
          body: JSON.stringify({ error: error instanceof Error ? error.message : String(error) }),
        });
      }
    }
  } catch (error) {
    console.debug("cc-assistant poll paused", error);
  } finally {
    pollInFlight = false;
    if (scheduleNext) setTimeout(() => void poll(true), 1500);
  }
}

chrome.runtime.onInstalled.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("cc-assistant-poll", { periodInMinutes: 0.5 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("cc-assistant-poll", { periodInMinutes: 0.5 }));
chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === "cc-assistant-poll") void poll(false); });
void poll(true);

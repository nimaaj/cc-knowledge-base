function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function listUnreads() {
  return [...document.querySelectorAll('[aria-label*="unread" i], [data-qa*="unread"]')]
    .map((element) => ({ label: element.getAttribute("aria-label") || element.textContent?.trim() }))
    .filter((item) => item.label)
    .slice(0, 200);
}

async function openChannel(channelName) {
  const candidates = [...document.querySelectorAll('[data-qa*="channel_sidebar"], [role="treeitem"]')];
  const channel = candidates.find((element) => (element.textContent || "").trim().includes(channelName));
  if (!(channel instanceof HTMLElement)) throw new Error(`Slack channel was not found: ${channelName}`);
  channel.click();
  await wait(500);
}

async function readChannel(input) {
  if (input.channelName) await openChannel(String(input.channelName));
  const messages = [...document.querySelectorAll('[data-qa="message_container"], [role="listitem"]')]
    .slice(-100)
    .map((element) => element.textContent?.trim())
    .filter(Boolean);
  return { messages };
}

async function sendMessage(input) {
  await openChannel(String(input.channelName || ""));
  const editor = document.querySelector('[data-qa="message_input"][contenteditable=true], [role="textbox"][contenteditable=true]');
  if (!(editor instanceof HTMLElement)) throw new Error("Slack message editor was not found");
  editor.focus();
  document.execCommand("insertText", false, String(input.text || ""));
  await wait(100);
  const send = document.querySelector('[data-qa="texty_send_button"]');
  if (send instanceof HTMLElement) send.click();
  else editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  return { sent: true, channelName: input.channelName };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "cc-assistant-job") return;
  const { action, input } = message.job;
  const work = action === "list_unreads" ? Promise.resolve({ unreads: listUnreads() }) :
    action === "read_channel" ? readChannel(input) :
    action === "send_message" ? sendMessage(input) : Promise.reject(new Error(`Unsupported Slack action: ${action}`));
  work.then(sendResponse, (error) => sendResponse({ __error: error.message }));
  return true;
});

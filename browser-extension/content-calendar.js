function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function setInput(input, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function listVisibleEvents() {
  const seen = new Set();
  return [...document.querySelectorAll("[data-eventid], [role=button][aria-label]")]
    .map((element) => ({
      id: element.getAttribute("data-eventid"),
      label: element.getAttribute("aria-label") || element.textContent?.trim(),
    }))
    .filter((event) => event.label && !seen.has(event.label) && seen.add(event.label))
    .slice(0, 200);
}

async function createEvent(input) {
  const create = [...document.querySelectorAll("button, [role=button]")].find((element) =>
    /create/i.test(element.getAttribute("aria-label") || element.textContent || ""));
  if (create instanceof HTMLElement) create.click();
  else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", code: "KeyC", bubbles: true }));
  await wait(800);
  const title = document.querySelector('input[aria-label*="title" i], input[placeholder*="title" i]');
  if (!(title instanceof HTMLInputElement)) throw new Error("Calendar event title field was not found");
  setInput(title, String(input.title || ""));
  if (input.start || input.end) {
    if (!input.start || !input.end) throw new Error("Calendar event creation requires both start and end");
    const start = new Date(input.start);
    const end = new Date(input.end);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) throw new Error("Calendar start/end must be ISO timestamps");
    const dateValue = (date) => `${date.getMonth() + 1}/${date.getDate()}/${date.getFullYear()}`;
    const timeValue = (date) => date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(" ", "");
    const fields = {
      startDate: document.querySelector('input[aria-label*="Start date" i]'),
      startTime: document.querySelector('input[aria-label*="Start time" i]'),
      endDate: document.querySelector('input[aria-label*="End date" i]'),
      endTime: document.querySelector('input[aria-label*="End time" i]'),
    };
    if (!Object.values(fields).every((field) => field instanceof HTMLInputElement)) throw new Error("Calendar date/time fields were not found; the browser adapter may need updated selectors");
    setInput(fields.startDate, dateValue(start)); setInput(fields.startTime, timeValue(start));
    setInput(fields.endDate, dateValue(end)); setInput(fields.endTime, timeValue(end));
  }
  if (input.description) {
    const description = document.querySelector('[aria-label*="description" i][contenteditable=true], textarea[aria-label*="description" i]');
    if (description instanceof HTMLTextAreaElement) setInput(description, String(input.description));
    else if (description instanceof HTMLElement) {
      description.focus();
      document.execCommand("insertText", false, String(input.description));
    }
  }
  const save = [...document.querySelectorAll("button")].find((button) =>
    /^(save)$/i.test(button.textContent?.trim() || "") || /save/i.test(button.getAttribute("aria-label") || ""));
  if (!(save instanceof HTMLButtonElement)) throw new Error("Calendar Save button was not found");
  save.click();
  return { created: true, title: input.title };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "cc-assistant-job") return;
  const { action, input } = message.job;
  Promise.resolve(action === "list_visible_events" ? { events: listVisibleEvents() } :
    action === "create_event" ? createEvent(input) : Promise.reject(new Error(`Unsupported Calendar action: ${action}`)))
    .then(sendResponse, (error) => sendResponse({ __error: error.message }));
  return true;
});

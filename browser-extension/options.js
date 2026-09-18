const url = document.querySelector("#url");
const token = document.querySelector("#token");
const status = document.querySelector("#status");

chrome.storage.local.get(["daemonUrl", "token"]).then((value) => {
  url.value = value.daemonUrl || "http://127.0.0.1:4317";
  token.value = value.token || "";
});

document.querySelector("#save").addEventListener("click", async () => {
  status.textContent = "Testing…";
  try {
    const daemonUrl = url.value.replace(/\/$/, "");
    await chrome.storage.local.set({ daemonUrl, token: token.value });
    const response = await fetch(`${daemonUrl}/api/tasks`, { headers: { Authorization: `Bearer ${token.value}` } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    status.textContent = "Connected";
  } catch (error) { status.textContent = `Failed: ${error.message}`; }
});

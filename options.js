// Gloss options page: the on-device AI control panel.
const api = globalThis.browser ?? globalThis.chrome;
const SETTINGS_KEY = "gloss:settings";

const box = document.getElementById("aiEnabled");
const statusEl = document.getElementById("aiStatus");
const actionBtn = document.getElementById("aiAction");
const logEl = document.getElementById("aiLog");

let availability = "unknown";

function render() {
  const messages = {
    unsupported: "On-device AI isn't available in this browser. Everything else still works.",
    unavailable: "On-device AI isn't supported on this device (hardware requirements).",
    downloadable: "On-device AI is available — the model downloads once (a few GB).",
    downloading: "Downloading the on-device model…",
    available: "On-device AI is ready.",
    unknown: "Checking on-device AI…",
  };
  statusEl.textContent = messages[availability] ?? messages.unknown;

  // The toggle only makes sense once the model is actually downloaded.
  box.disabled = availability !== "available";

  if (availability === "downloadable") {
    actionBtn.hidden = false;
    actionBtn.textContent = "Download model";
    actionBtn.disabled = false;
  } else if (availability === "available") {
    actionBtn.hidden = false;
    actionBtn.textContent = "Test model";
    actionBtn.disabled = false;
  } else {
    actionBtn.hidden = true;
  }
}

async function detect() {
  const LM = globalThis.LanguageModel;
  if (!LM || typeof LM.availability !== "function") {
    availability = "unsupported";
  } else {
    try {
      availability = await LM.availability();
    } catch {
      availability = "unsupported";
    }
  }
  render();

  // Let the background worker keep the context-menu item in sync.
  try {
    await api.runtime.sendMessage({ type: "gloss:aiAvailability", availability });
  } catch {
    // service worker may be asleep; it re-probes on the next lookup anyway
  }
}

(async () => {
  const stored = await api.storage.local.get(SETTINGS_KEY);
  box.checked = Boolean(stored?.[SETTINGS_KEY]?.aiEnabled);
  await detect();
})();

box.addEventListener("change", () => {
  api.storage.local.set({ [SETTINGS_KEY]: { aiEnabled: box.checked } });
});

actionBtn.addEventListener("click", async () => {
  const LM = globalThis.LanguageModel;
  if (!LM) return;

  logEl.hidden = false;
  logEl.textContent = "";

  try {
    const session = await LM.create({
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          logEl.textContent = `downloading ${Math.round((e.loaded ?? 0) * 100)}%`;
        });
      },
    });

    logEl.textContent = "model ready\n";
    const answer = await session.prompt("In one short sentence, what is a CNAME record?");
    logEl.textContent += `answer: ${answer}\n`;
    if (typeof session.destroy === "function") session.destroy();

    await detect();
    if (availability === "available") {
      box.checked = true;
      box.disabled = false;
      api.storage.local.set({ [SETTINGS_KEY]: { aiEnabled: true } });
    }
  } catch (e) {
    logEl.textContent += `error: ${e?.name}: ${e?.message}\n`;
  }
});

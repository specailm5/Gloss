// Gloss settings: opt-in extra sources.
const api = globalThis.browser ?? globalThis.chrome;

const inputs = Array.from(document.querySelectorAll("input[data-origin]"));
const status = document.getElementById("status");

function say(text) {
  status.textContent = text;
}

async function refresh() {
  try {
    const granted = await api.permissions.getAll();
    const origins = new Set(granted?.origins ?? []);
    for (const input of inputs) input.checked = origins.has(input.dataset.origin);
  } catch {
    say("Couldn't read your settings. Reload this page and try again.");
  }
}

for (const input of inputs) {
  input.addEventListener("change", async () => {
    const origins = [input.dataset.origin];

    try {
      if (input.checked) {
        const granted = await api.permissions.request({ origins });
        if (!granted) {
          input.checked = false;
          say("Permission not granted. You can try again any time.");
        } else {
          say("Extra source enabled.");
        }
      } else {
        await api.permissions.remove({ origins });
        say("Extra source turned off.");
      }
    } catch {
      input.checked = !input.checked;
      say("Couldn't change that setting. Try again.");
    }
  });
}

refresh();

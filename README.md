# Vheer Story Studio — Chrome Extension

One-button cinematic image generation from your screenplay, built exclusively for [Vheer Text-to-Image](https://vheer.com/app/text-to-image).

Import a Universal Vheer Prompt Session, press **Start** in the side panel, and walk away. Every result is downloaded, renamed, and organized automatically.

---

## Quick Start

1. Open `chrome://extensions` in Chrome
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select this folder
4. Click the extension icon → the side panel opens
5. Click **📂 Import Universal Prompt Session** and select any `.md`, `.markdown`, or `.txt` session file
6. Open **https://vheer.com/app/text-to-image** in a tab (configure Model / Aspect Ratio / Image count manually for now)
7. Click **▶ Start** in the side panel

Images are saved to `<Chrome Downloads>/<ProjectName>/Images/SHOT001.png`.

---

## Page Tools

| Button | What it does |
|--------|--------------|
| 🔌 Test Connection | Verifies Extension → Content Script → URL → Prompt textarea |
| 🔍 Inspect Page | Full DOM dump: URL, title, framework, ready-state, iframes, and every textarea/input/button/select/contenteditable with tag, id, class, name, placeholder, aria-label, visible, disabled, innerText |
| ✏️ Test Fill Prompt | Inserts `TEST FROM AI STORY STUDIO` into the prompt field only |
| ⚡ Test Generate | Clicks the Generate button only |

Every action is logged to the **Debug Console** (🔍 button in the side-panel header):
`✓ Connected to Vheer → ✓ URL Verified → ✓ Content Script Connected → ✓ DOM Ready → ✓ Prompt Found → ✓ Prompt Filled → ✓ Generate Clicked → ✓ Waiting… → ✓ Image Detected → ✓ Download Started → ✓ Download Finished`

If anything fails, the exact element and current DOM state are reported.

---

## Architecture

```
manifest.json                 ← MV3 manifest (vheer.com only)
service-worker.js             ← orchestration hub (queue, downloads, alarms, storage)
sidepanel/
  index.html                  ← side panel shell
  sidepanel.js                ← UI logic (page tools, queue, settings)
  sidepanel.css               ← dark theme
content-scripts/
  vheer.js                    ← Vheer adapter (detector, selectors, inspector, actions, downloader)
lib/
  parser.js                   ← universal prompt-session parser + legacy adapters
  storage.js                  ← chrome.storage.local wrapper
diagnostics/                  ← standalone connection-test page
icons/                        ← extension icons
```

### How It Works

1. **Import**: User selects their markdown file → parser extracts shots → stored in `chrome.storage.local`
2. **Detect**: Content script validates `window.location.href` starts with `https://vheer.com/app/text-to-image` — no frame/iframe/Generator-Frame concept
3. **Wait**: Vheer is an SPA — the adapter waits (MutationObserver + polling) for the prompt textarea to render before failing
4. **Generate**: Side panel sends the prompt → content script fills the textarea → clicks Generate → waits intelligently for the image (new image element, no fixed sleeps)
5. **Download**: Content script clicks Vheer's Download button → service worker intercepts via `chrome.downloads.onDeterminingFilename`, renames to `<Project>/Images/SHOT###.png`, and verifies the file
6. **Delay**: Service worker uses `chrome.alarms` to schedule the next shot (fixed or random; survives service worker restarts)
7. **Resume**: On browser restart, the service worker reads queue state from storage and resumes from the first unfinished shot — completed images are never regenerated

---

## Universal Numbered Prompt Session

The official shared protocol for image, video, and future providers is the
**Universal Numbered Prompt Session**. One numbered block equals one generation
job. The parser converts the human-readable file into generic `PromptJob`
objects before the provider is called; providers never receive the delimiter or
job number.

### Session loading mechanism

The extension intentionally does not require a story-specific filename. The
existing side-panel file picker accepts any `.md`, `.markdown`, or `.txt` file
and detects this protocol from its delimiter structure. A recommended optional
filename is `UNIVERSAL-VHEER-PROMPT-SESSION.md`, but the filename is not used for
parsing or routing. Image and video mode use the same protocol and parser while
writing to their existing mode-specific queues.

```text
----------------------------------
1
----------------------------------
IMAGE OR VIDEO PROMPT 1
----------------------------------

----------------------------------
2
----------------------------------
IMAGE OR VIDEO PROMPT 2
----------------------------------
```

Rules:

- The delimiter must be a line containing exactly `----------------------------------`.
- IDs must be numeric and are retained as stable job IDs; non-consecutive IDs are allowed.
- Prompt content may contain numbers, hyphens, Markdown-like text, and line breaks.
- Blank lines between blocks are harmless; empty prompts, duplicate IDs, malformed blocks, and unexpected text are rejected before generation.
- Image and video imports use this same parser and create one queue item per block.

The legacy `SHOT 001` / `MASTER PROMPT` format below remains supported for
backward compatibility.

## Prompt File Format

Each `ALL-MASTER-PROMPTS.md` contains one block per shot:

```
SHOT 001

MASTER PROMPT
...your cinematic master prompt...

NEGATIVE PROMPT
...things to avoid...

SHOT 002

MASTER PROMPT
...
```

- `SHOT`, `MASTER PROMPT`, `NEGATIVE PROMPT` are case-insensitive
- `NEGATIVE PROMPT` is optional (Vheer currently has no negative-prompt field; it is ignored)
- Anything before the first SHOT header is ignored

---

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Delay between shots | 30 seconds (fixed) | Wait time between completed generations; fixed or random (25–45s) |
| Retries per shot | 3 | Attempts before marking a shot as failed |
| Filename template | `SHOT{N}` | `{N}` is replaced by the zero-padded shot number |
| Project name | Vheer Project | Sub-folder under Chrome Downloads |

---

## Troubleshooting

- **"No Vheer tab found"** — navigate to https://vheer.com/app/text-to-image and retry
- **"Prompt textarea not found"** — the page may still be loading (SPA) or Vheer changed its layout. Run **🔍 Inspect Page** to see the current DOM, then **✏️ Test Fill Prompt**
- **Images not downloading** — check Chrome's download settings; the extension uses the `chrome.downloads` API
- **Queue stuck** — click Stop, then Start again. State is persisted and resumes correctly
- **Content script not responding** — reload the extension in `chrome://extensions`, then refresh the Vheer tab

---

## Development

This is a plain JavaScript Chrome Extension — no build step, no Node.js required. Reload the extension in `chrome://extensions` after any change.

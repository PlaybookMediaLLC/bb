# RFC: Browser-Scoped Computer Use

Status: Proposed  
Date: 2026-08-22

## Summary

Add computer use to bb by controlling one visible, isolated in-app browser tab
per thread. The first release provides one native agent tool, `bb_browser`, and
matching SDK and `bb browser` CLI surfaces.

The server owns policy, consent, thread ownership, and request routing. The app
owns the visible tab. Desktop main owns screenshot capture and input dispatch
for its `WebContentsView`.

This RFC does not add operating-system-wide computer use.

## Why browser scope first

bb already has the important browser primitive: an isolated Electron
`WebContentsView` with restricted navigation, denied permissions and downloads,
and loopback/LAN blocking. Extending that view keeps automation visible and
contained.

Operating-system control would add platform-specific screen capture, input
drivers, Accessibility and Screen Recording permissions, and a much larger
trust boundary. It should be proposed separately after browser-scoped use is
proven useful.

## Goals

- Let an agent open, observe, click, type, press a key, scroll, and close one
  visible browser target associated with its thread.
- Return a current screenshot after every successful action so the model acts
  on observed state.
- Let the user see that the agent is controlling the tab and stop it at any
  time.
- Make the same capability available through the SDK and `bb` CLI.
- Keep target selection, authorization, and consent outside model-controlled
  arguments.
- Keep screenshot bytes out of persisted thread events and logs.

## Non-goals

- Controlling other applications or the operating system.
- Controlling ordinary user-created browser tabs.
- Hidden or background browser automation.
- Multiple automation targets for one thread.
- DOM selectors, page JavaScript evaluation, accessibility-tree queries, or
  arbitrary Chrome DevTools Protocol access.
- Playwright integration or a production remote-debugging port.
- Downloads, browser permissions, LAN access, or bypasses around the existing
  browser firewall.
- Restoring a target after the app, server, or desktop controller disconnects.

## User experience

The first `open` action for a thread passes through server-owned tool-use
approval policy. Approval creates an automation-owned browser tab in that
thread's secondary panel and starts a control session. The tab shows an "Agent
controlling browser" indicator and a Stop action.

Approval lasts only for that target. Closing the tab, selecting Stop,
disconnecting the controlling desktop window, or ending the thread closes the
target and revokes approval. A later `open` requires approval again.

SDK and CLI calls use the same approval path. Calling the CLI is not treated as
proof of a human gesture because an agent can also invoke it. Every surface
still requires an authenticated caller, a thread the caller can access, and a
focused bb desktop window displaying that thread.

If no eligible desktop window is available, the request fails with an
actionable error. The server does not silently choose a browser on another
thread or machine.

## Tool contract

`bb_browser` is a core native tool, not a public plugin API. The server injects
it into provider sessions. Because desktop availability can change during a
session, a missing compatible controller is a typed tool error rather than a
reason to mutate the live tool list.

Its input is a discriminated action:

```ts
type BrowserAction =
  | { action: "open"; url: string }
  | { action: "observe" }
  | {
      action: "click";
      frameId: string;
      x: number;
      y: number;
      button: "left" | "middle" | "right";
    }
  | { action: "type"; frameId: string; text: string }
  | { action: "key"; frameId: string; key: string }
  | {
      action: "scroll";
      frameId: string;
      deltaX: number;
      deltaY: number;
    }
  | { action: "close" };
```

The provider-facing schema may omit `button`; the server fills the default
`"left"` at the boundary before passing the typed action internally.

The model does not supply a thread, host, desktop-controller, or target ID. The
server derives the thread and project from the authenticated tool-call context,
owns the single target for that thread, and selects the focused desktop window
that is displaying it.

Every successful action except `close` returns:

```ts
interface BrowserFrame {
  targetId: string;
  frameId: string;
  url: string;
  title: string;
  viewport: {
    width: number;
    height: number;
    deviceScaleFactor: number;
  };
  image: {
    data: string;
    mimeType: "image/jpeg";
  };
}
```

The image is returned to the provider as a native image content item. The
screenshot dimensions match the reported CSS-pixel viewport, so click
coordinates use the same coordinate space.

Each captured frame receives a new `frameId`. Input actions must echo the most
recent frame ID returned for that target. The server rejects an older frame ID
instead of applying coordinates to known-changed state. This protects against
reusing an old model observation; it does not claim to detect every animation
or page-side DOM mutation between observation and input.

## Architecture

```text
agent tool / SDK / bb CLI
          |
          v
server policy, consent, ownership, and request broker
          |
          v
focused bb desktop window displaying the thread
          |
          v
app opens or focuses the automation-owned secondary-panel tab
          |
          v
desktop main controls the tab's isolated WebContentsView
          |
          v
JPEG frame and metadata return through the same request path
```

### Server

The server keeps an in-memory registry keyed by thread ID. Each entry contains
the server-generated target ID, the controlling app connection, approval state,
and the latest frame ID. The registry is intentionally not persisted.

The request broker:

- authenticates SDK and CLI requests and checks thread access;
- uses the authenticated daemon session and thread environment checks already
  performed by `/internal/session/tool-call` for agent calls;
- extends the existing generic tool-use approval with a server-owned origin and
  settles it before the first `open` from any surface, so shelling out to the
  CLI cannot bypass policy;
- routes only to a desktop-capable app connection that is focused and displaying
  the same thread;
- permits at most one in-flight action and one target per thread;
- propagates cancellation and applies a bounded timeout; and
- removes the target when either side disconnects.

The ordinary client WebSocket gains bounded request/response messages for
desktop browser control. A desktop-capable app registers only while
`BbDesktopBrowserApi` is present and reports focus and displayed-thread changes.
The server releases that registration when the socket closes.

### App

The app translates broker requests into existing secondary-panel state and the
desktop browser API. An automation target is distinct from ordinary browser
tabs even though it uses the same tab UI and view implementation.

The app owns visible layout and the control indicator. Stop first cancels the
pending request, then detaches and destroys the automation view. Compact layouts
must continue to use the shared persistent responsive drawer.

### Desktop main

`DesktopBrowserViewManager` remains the only component that touches Electron
browser primitives. It adds automation operations for registered automation
targets only:

- `webContents.loadURL` for `open`;
- `webContents.capturePage` plus `NativeImage` resize/JPEG encoding for frames;
- `webContents.insertText` for text input;
- `webContents.sendInputEvent` for mouse, key, and scroll input; and
- existing view destruction for `close`.

No remote-debugging port or general CDP bridge is opened. The existing browser
session partition, navigation policy, permission denial, download denial, and
network firewall remain in force.

The desktop contract addition must be optional and capability-checked so a new
web app still works with an older desktop binary. Existing browser IPC shapes
remain unchanged.

## SDK and CLI

The SDK adds a typed `sdk.browser` area with `open`, `observe`, `click`, `type`,
`key`, `scroll`, and `close`. Each method takes a `threadId`; input methods also
take the current `frameId`.

The CLI is a direct wrapper over that SDK area:

```text
bb browser open <url> --thread <thread-id>
bb browser observe --thread <thread-id> --output <path>
bb browser click --thread <thread-id> --frame <frame-id> --x <x> --y <y>
bb browser type --thread <thread-id> --frame <frame-id> --text <text>
bb browser key --thread <thread-id> --frame <frame-id> --key <key>
bb browser scroll --thread <thread-id> --frame <frame-id> --dx <x> --dy <y>
bb browser close --thread <thread-id>
```

Commands support the existing `BB_THREAD_ID` context and `--json` conventions.
Screenshot bytes are written only when `--output` is given; JSON output contains
metadata and the output path, not base64 image data. CLI help, the guide, and the
built-in skill must ship with the commands as required by
`docs/cli-guide-and-skill.md`.

## Validation and limits

All externally supplied values are parsed at their boundary. The implementation
must enforce:

- `http:` and `https:` URLs only, with a length limit;
- bounded typed text and key names;
- finite coordinates and scroll deltas within documented limits;
- coordinates inside the current viewport;
- a maximum viewport and a 4 MiB maximum encoded JPEG size; and
- a request timeout with cancellation on user Stop or caller disconnect.

Input errors are returned as tool errors and do not close the provider session.
Oversized screenshots fail clearly; they are never silently truncated.

## Data handling

Screenshot bytes are transient. They may travel to the active provider as an
image tool result, but bb must not write their base64 form to thread events,
logs, analytics, or the database. Persisted timeline output contains only an
`[image]` marker plus the action and result status. It excludes the URL, title,
typed text, and all page content.

This must be fixed and covered in every provider bridge before the tool is
enabled. In particular, no bridge may translate an image data URL into a text
timeline item such as `[image: <data-url>]`, or copy sensitive frame metadata
from model input into the persisted tool result.

Analytics record action names, timing, result class, and coarse image byte
size. They do not record URLs, titles, typed text, screenshots, or page content.

## Protocol compatibility

The first implementation changes the tool definitions sent in provider session
payloads and the behavior of image tool results. It must increment
`HOST_DAEMON_PROTOCOL_VERSION`; a shared TypeScript build is not evidence that
an enrolled older daemon is compatible.

Server/app WebSocket and desktop contract changes are additive and
capability-gated. Older apps remain usable but cannot register as browser
controllers. New apps connected to older desktop binaries hide the feature and
return a clear unsupported error.

## Acceptance criteria

- An approved `bb_browser open` opens a visible automation-owned tab and returns
  a JPEG frame to the model.
- Click, type, key, and scroll use the current frame coordinate space and return
  a new frame.
- Reusing a stale frame ID fails without dispatching input.
- An agent cannot target another thread, an ordinary user tab, or another app
  connection.
- Stop, tab close, disconnect, timeout, and caller cancellation terminate the
  control session.
- Permissions, downloads, non-HTTP navigation, loopback, and LAN access remain
  blocked.
- No persisted event, log, or analytics payload contains screenshot data, page
  content, or typed text.
- The same behavior is covered through the native tool, SDK, and CLI.
- A new app degrades cleanly with an old desktop binary.

## Required verification

- Contract tests for every action, response, limit, and version-skew case.
- Server tests for approval, thread ownership, controller selection, timeout,
  cancellation, and disconnect cleanup.
- App and desktop tests for target isolation, frame sequencing, input dispatch,
  Stop behavior, and preservation of browser security policy.
- Provider corpus tests proving image bytes reach model input but never the
  persisted timeline.
- SDK and CLI tests for each command and JSON output.
- Turbo typechecks for every affected package.
- A desktop smoke test that opens a page, completes a visible interaction, and
  stops the session.

## Rejected alternatives

### Playwright or an external browser

This would not control the browser the user sees inside bb and would duplicate
browser lifecycle and security policy.

### Electron remote debugging or general CDP

A production debugging port can expose trusted Electron targets, including bb's
own UI. General page evaluation also creates a larger privilege surface than
the screenshot-and-input loop requires.

### Selector and JavaScript APIs in the first release

They create a second observation model and require DOM serialization, selector
stability rules, script auditing, and more page-content handling. Coordinate
input over visible screenshots is the smallest complete computer-use loop.

### CLI-only first release

Agents can invoke the CLI, but a native tool carries image results without
temporary files and keeps approval and tool presentation under server policy.
The CLI remains a required peer surface over the same server operation.

### Operating-system computer use in this RFC

OS control has different permissions, platform support, target selection, and
safety requirements. If browser-scoped use succeeds, propose it separately as
a macOS-first host capability with explicit Screen Recording and Accessibility
checks and a user-selected host.

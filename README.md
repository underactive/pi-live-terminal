<img width="1680" height="720" alt="tanishqk_Overhead_aerial_view_of_New_York_City_at_golden_hour_650bc1e7-22f5-4e28-9576-ceaa73ed132c_0" src="https://github.com/user-attachments/assets/219e4167-d04f-4c8a-9373-bdf3a6e96856" />

# pi-live-terminal

Pi extension for running and interacting with tmux sessions through a live terminal widget inside Pi.

https://github.com/user-attachments/assets/b4ec6d34-fd8a-4254-bf74-e216779649f6

## What it does

- Starts long-running, interactive, full-screen, and watch-mode commands in detached tmux sessions.
- Attaches to existing tmux panes without taking ownership of them.
- Keeps multiple terminals tracked while showing one active widget above the editor.
- Sends input to panes and reads captured output for agent-driven interaction.
- Waits for output or lifecycle events, with live progress and recent output on timeout.
- Streams pane output through `tmux pipe-pane` for event-driven updates.
- Reports completed commands and their exit status to both the human and agent.
- Restores tracked targets when a Pi session restarts and the tmux targets still exist.

## Tools

| Tool | Purpose |
| --- | --- |
| `live_terminal_run` | Start a command, attach to an existing target, and optionally wait for output or an event. |
| `live_terminal_send` | Send literal text and/or named keys such as `enter`, `ctrl+c`, or `pageUp`. |
| `live_terminal_read` | Read a pane's recent output and its running or completed state. Defaults to 80 lines; maximum 2,000. |
| `live_terminal_close` | Close a tracked terminal using the ownership-aware behavior described below. |

`live_terminal_send`, `live_terminal_read`, and `live_terminal_close` use the active terminal when neither `target` nor `session_name` is provided.

```ts
live_terminal_send({ text: "y", keys: ["enter"] })
live_terminal_read({ lines: 80 })
live_terminal_close({ kill: false })
```

## Commands and shortcuts

| Action | Command | Shortcut |
| --- | --- | --- |
| Start a command | `/live-terminal:run <shell-command>` | — |
| Attach to a target, or open the target picker | `/live-terminal:attach [target] [title]` | — |
| Select another tracked terminal | `/live-terminal:list` | `cmd+option+s` |
| Open the focus modal | `/live-terminal:focus` | `cmd+option+f` toggles it |
| Detach and leave tmux running | `/live-terminal:detach` | `cmd+option+v` |
| Close, optionally requesting a kill | `/live-terminal:close [--kill]` | `cmd+option+x` requests a kill |
| Collapse or expand the widget | `/live-terminal:toggle` | `cmd+option+m` |
| Set the session-scoped widget height | `/live-terminal:height <rows>` | — |
| Copy recent pane output | `/live-terminal:copy [lines]` | `cmd+option+c` in the focus modal |
| Send text to the pane | `/live-terminal:send <text>` | — |
| Scroll the widget | — | `cmd+option+pageUp`, `cmd+option+pageDown` |
| Resume following live output | — | `cmd+option+end` |

Without a target, `/live-terminal:attach` lists available tmux panes. Its argument completion suggests session names; `/live-terminal:close` completes `kill`.

## Session ownership and closing

**Changed in 0.3:** externally attached sessions are no longer destroyed by default. The extension never kills a session it did not create without an explicit kill request. Omitting `kill` keeps the ownership default; `kill: false` always detaches, and `kill: true` always requests a kill.

A session created by `live_terminal_run({ command: ... })` is extension-owned. `live_terminal_close` kills an owned session by default; pass `kill: false` to detach and keep it running.

A session attached by calling `live_terminal_run` without a command and passing `target` or `session_name`, or by using `/live-terminal:attach`, remains externally owned. Closing it detaches by default. Destroying it requires `kill: true`, `/live-terminal:close --kill`, or `cmd+option+x`. UI-triggered kill requests ask for confirmation because killing a tmux session closes every pane in it. An explicit `kill: true` tool call is treated as authorization and does not open a dialog; a UI-triggered request that cannot show a confirmation detaches instead.

Detaching reports a recovery command of the form `tmux attach -t <session>`. If a kill fails, the terminal remains tracked so it can be retried.

## Multiple terminals

Starting or attaching another terminal does not discard the previous one. Only one widget is visible at a time; the other tracked terminals continue running. Use `cmd+option+s` or `/live-terminal:list` to switch; when only one terminal is tracked, this opens its focus modal directly. Closing the active terminal promotes another tracked terminal when one is available.

The active session also appears in Pi's status area, including while the widget is collapsed.

## Widget controls

The widget adapts its height to the Pi terminal. `/live-terminal:height <rows>` sets an override for the current Pi session, clamped to a six-row floor and a 40% terminal-height ceiling. `cmd+option+m` or `/live-terminal:toggle` collapses the widget to its title and footer.

Use `cmd+option+pageUp` and `cmd+option+pageDown` to inspect scrollback; the mouse wheel also works when Pi routes pointer input to the widget. Scrolling up pauses automatic following and shows `↑ N lines`; `cmd+option+end` returns to `LIVE` output. The title shows elapsed time while running and the exit status after completion.

## Focus modal

`cmd+option+f` or `/live-terminal:focus` opens the active pane in a full-screen modal. Normal input is forwarded to tmux. The modal reserves these controls:

- `shift+up` and `shift+down` — scroll three lines.
- `shift+pageUp` and `shift+pageDown` — scroll one page.
- `shift+home` and `shift+end` — jump to the beginning of the captured scrollback (up to 1,000 lines) or live output.
- `cmd+option+c` — copy recent pane output.
- `cmd+option+f` — return to Pi.
- `ctrl+]` twice within 500 ms — portable fallback to return to Pi when the terminal consumes `cmd+option` combinations.

A reminder banner appears the first time the modal opens in each Pi process. Some legacy terminals cannot distinguish shifted arrow keys; use the mouse wheel in that case.

## Clipboard

Copying tries `pbcopy`, `wl-copy`, and `xclip -selection clipboard`, then falls back to OSC 52. OSC 52 may be disabled or silently ignored by the terminal, so a copy notice does not guarantee that the clipboard changed. When Pi itself runs inside tmux, enable clipboard forwarding in `~/.tmux.conf`:

```tmux
set -g set-clipboard on
```

Install one of the supported clipboard utilities if OSC 52 is unavailable.

## Waiting from `live_terminal_run`

`live_terminal_run` returns immediately by default. Pass `wait_for` to block the tool call until a condition matches or times out:

```ts
live_terminal_run({
  command: "npm run dev",
  wait_for: { regex: "Local:|ready", timeout_ms: 60000 }
})
```

`wait_for.regex` is a JavaScript regular expression source matched against captured tmux pane output. It uses multiline matching by default, and `ignore_case: true` adds case-insensitive matching. Streaming output wakes regex waits immediately; `poll_ms` remains the upper bound between checks.

Supported events:

- `exit` — waits until a command started by `live_terminal_run` records its exit status.
- `target_closed` — waits until the attached tmux pane or session no longer exists.

`event: "exit"` is available only for commands launched by this extension because external sessions do not record the required exit-status pane option. It fails immediately for externally attached targets; use a regex or `target_closed` instead.

Defaults: `timeout_ms: 30000`, `poll_ms: 500`. Wait progress includes elapsed time and the most recent output line. A timeout includes a bounded recent-output tail and leaves the terminal running. Cancelling a wait also leaves the session running.

## Troubleshooting

| Problem | Resolution |
| --- | --- |
| The focus modal will not close | Press `ctrl+]` twice within 500 ms. |
| tmux is unavailable | Install tmux and ensure `tmux` is on Pi's `PATH`, then restart Pi. |
| The requested session name already exists | Choose another `session_name`, or attach with `target` or `/live-terminal:attach`. |
| A tracked target ended outside Pi | Use `/live-terminal:list` to switch or `cmd+option+v` to close its stale widget. |
| Clipboard copy produces nothing | macOS includes `pbcopy`; otherwise install `wl-copy` or `xclip`. When Pi runs inside tmux, also enable `set-clipboard`. |

## Install

```sh
pi install npm:pi-live-terminal
```

Restart Pi after installing or updating the extension.

## Requirements

- [tmux](https://github.com/tmux/tmux)
- Pi coding agent extension runtime

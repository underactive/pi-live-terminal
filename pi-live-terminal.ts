import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem, Component, TUI } from "@earendil-works/pi-tui";
import { Key, Text, decodeKittyPrintable, matchesKey, parseKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createReadStream, promises as fs } from "node:fs";
import type { ReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CAPTURE_LINES = 200;
const FOCUS_CAPTURE_LINES = 1000;
const VISIBLE_LINES = 16;
const MIN_WIDGET_LINES = 6;
const WIDGET_HEIGHT_RATIO = 0.4;
const POLL_MS = 500;
const EXIT_MONITOR_MS = 1000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const WAIT_PROGRESS_MS = 1000;
const TAIL_LINES = 20;
const TAIL_BYTES = 2048;
const DEFAULT_READ_LINES = 80;
const MAX_READ_LINES = 2000;
const CONTENT_PADDING = 1;
const WHEEL_SCROLL_LINES = 3;
const EXIT_CHORD_MS = 500;
const NOTICE_MS = 3000;
const BANNER_MS = 6000;
const WIDGET_ID = "pi-live-terminal";
const STATUS_ID = "live-terminal";
const ENTRY_TYPE = "pi-live-terminal";
const MESSAGE_TYPE = "live-terminal-status";
const DEFAULT_TITLE = "tmux";
const ENDED_LINE = "tmux session ended — cmd+option+v to close";
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type PaneState = "running" | "completed" | "unknown";

type LiveTerminalAttachment = {
  target: string;
  title: string;
  sessionName?: string;
  command?: string;
  cwd?: string;
  state?: "running" | "completed";
  status?: string;
  attachedExisting?: boolean;
  startedAt?: number;
};

type LiveTerminalEntryData = {
  action?: "open" | "exit" | "detach" | "kill" | "close";
  target?: string;
  paneId?: string;
  sessionName?: string;
  title?: string;
  command?: string;
  cwd?: string;
  state?: string;
  status?: string;
  attachedExisting?: boolean;
  startedAt?: number;
  reason?: string;
  at?: number;
};

type WaitForOptions = {
  regex?: string;
  event?: "exit" | "target_closed";
  ignore_case?: boolean;
  timeout_ms?: number;
  poll_ms?: number;
};

type WaitCondition =
  | { kind: "regex"; regex: RegExp; source: string }
  | { kind: "event"; event: "exit" | "target_closed" };

type WaitResult = {
  matched: boolean;
  timedOut?: boolean;
  condition: string;
  elapsedMs: number;
  status?: string;
  match?: string;
  recentOutput?: string;
  stillRunning?: boolean;
};

type PaneSubscriber = (chunk: string) => void;

type PaneStream = {
  target: string;
  fifoPath: string;
  stream: ReadStream;
  subscribers: Set<PaneSubscriber>;
};

type WaitDeps = {
  captureText: (target: string) => Promise<string>;
  exitStatus: (target: string) => Promise<string | undefined>;
  targetExists: (target: string) => Promise<boolean>;
  subscribe: (target: string, subscriber: PaneSubscriber) => Promise<() => Promise<void>>;
};

type WaitTerminalOptions = {
  signal?: AbortSignal;
  onTick?: (elapsedMs: number, lastLine: string | undefined) => void;
  /** Whether the target runs under live_terminal_run's exit-status wrapper. Defaults to membership in startedTargets. */
  exitTracked?: boolean;
  deps?: Partial<WaitDeps>;
};

export type CloseAction = "kill" | "detach" | "confirm-kill";

type BorderRole = "border" | "borderAccent";

const attachments = new Map<string, LiveTerminalAttachment>();
let activeTarget: string | undefined;
const startedTargets = new Set<string>();
let activeWidget: LiveTerminalWidget | undefined;
let widgetCollapsed = false;
let widgetHeightOverride: number | undefined;
let focusModalOpen = false;
let focusBannerShown = false;
const reportedExitTargets = new Set<string>();
let mouseReportingRefCount = 0;
const paneStreams = new Map<string, PaneStream>();
const paneStreamCreates = new Map<string, Promise<PaneStream>>();

function safeSessionName(input?: string): string {
  const base = (input || `pi-live-${randomBytes(4).toString("hex")}`)
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 64);
  return base || `pi-live-${randomBytes(4).toString("hex")}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function compactText(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maxLength ? `${compact.slice(0, Math.max(0, maxLength - 1))}…` : compact;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function startedMessage(sessionName: string): string {
  return `Started and attached to tmux session ${sessionName}.`;
}

function attachedMessage(sessionName: string | undefined, target: string): string {
  return `Attached to tmux session ${sessionName || target}.`;
}

function attachmentName(attachment: LiveTerminalAttachment): string {
  return attachment.sessionName || attachment.title || attachment.target;
}

function statusGlyph(state: PaneState, status?: string): string {
  if (state === "completed") return status === "0" ? "🟢" : "🔴";
  return SPINNER_FRAMES[Math.floor(Date.now() / POLL_MS) % SPINNER_FRAMES.length];
}

function statusBadge(attachment: LiveTerminalAttachment): string {
  if (attachment.state === "completed") return attachment.status === "0" ? "🟢" : "🔴";
  return "▶";
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m${String(totalSeconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(totalMinutes / 60)}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}

export function formatElapsed(startedAt: number, now: number = Date.now()): string {
  return formatDuration(now - startedAt);
}

export function clampWidgetHeight(rows: number, override?: number): number {
  return Math.max(MIN_WIDGET_LINES, Math.min(override ?? VISIBLE_LINES, Math.floor(rows * WIDGET_HEIGHT_RATIO)));
}

export function scrollIndicatorText(offset: number, lineCount: number, visibleLines: number): string {
  const max = maxScrollOffset(lineCount, visibleLines);
  if (max === 0) return "";
  const hidden = max - clampScrollOffset(offset, lineCount, visibleLines);
  if (hidden === 0) return "LIVE";
  return `↑ ${hidden} ${hidden === 1 ? "line" : "lines"}`;
}

/**
 * Decide what closing a live terminal should do. Sessions the extension did not start are never
 * killed without an explicit kill request, and UI-initiated kills of them require confirmation.
 */
export function decideCloseAction(
  attachment: { attachedExisting?: boolean },
  options: { kill: boolean; force?: boolean },
): CloseAction {
  if (!options.kill) return "detach";
  if (attachment.attachedExisting && !options.force) return "confirm-kill";
  return "kill";
}

export function renderFooterLine(width: number, hints: string, border: (s: string) => string): string {
  if (width <= 0) return "";
  if (width === 1) return border("╰");
  if (width === 2) return border("╰╯");
  if (width === 3) return border("╰─╯");

  const innerW = width - 2;
  const maxHintsWidth = Math.max(0, innerW - 2);
  const fittedHints = maxHintsWidth > 0
    ? truncateToWidth(hints, maxHintsWidth, "…")
    : "";
  const leftRuleWidth = Math.max(1, innerW - visibleWidth(fittedHints) - 1);
  return border("╰") + border("─".repeat(leftRuleWidth)) + fittedHints + border("─╯");
}

function renderPaneFrame(options: {
  width: number;
  title: string;
  body: string[];
  scrollOffset: number;
  visibleLines: number;
  hints: string;
  border: (s: string) => string;
  leadingBlank: boolean;
}): string[] {
  const { width, border } = options;
  const innerW = Math.max(1, width - 2);
  const reset = "\x1b[0m";
  const pad = (s: string) =>
    truncateToWidth(s, innerW, "…", true).padEnd(
      Math.max(
        0,
        innerW -
          Math.max(0, visibleWidth(truncateToWidth(s, innerW, "…", true))),
      ),
    );
  const result: string[] = [];

  if (options.leadingBlank) result.push("");
  const title = truncateToWidth(options.title, Math.max(1, innerW - 1), "…");
  const rightRuleWidth = Math.max(0, innerW - 1 - visibleWidth(title));
  result.push(border("╭─") + title + border(`${"─".repeat(rightRuleWidth)}╮`));

  const visible = options.body.slice(options.scrollOffset, options.scrollOffset + options.visibleLines);
  for (const line of visible)
    result.push(border("│") + pad(`${" ".repeat(CONTENT_PADDING)}${line}`) + reset + border("│"));
  for (let i = visible.length; i < options.visibleLines; i++)
    result.push(border("│") + pad("") + reset + border("│"));

  result.push(renderFooterLine(width, options.hints, border));
  return result;
}

function waitDescription(condition: WaitCondition): string {
  return condition.kind === "regex"
    ? `regex ${JSON.stringify(condition.source)}`
    : `event ${condition.event}`;
}

export function waitResultMessage(result: WaitResult): string {
  if (result.timedOut) {
    const lines = [
      `Timed out after ${result.elapsedMs}ms waiting for ${result.condition}.`,
      result.stillRunning === false
        ? "The tmux target is no longer running."
        : "The terminal is still running; wait again or inspect it with live_terminal_read.",
    ];
    if (result.recentOutput) lines.push("", "Recent output:", result.recentOutput);
    return lines.join("\n");
  }
  if (result.status !== undefined) return `Matched ${result.condition} with status ${result.status} after ${result.elapsedMs}ms.`;
  if (result.match !== undefined) return `Matched wait regex:\n\n${result.match}`;
  return `Matched ${result.condition} after ${result.elapsedMs}ms.`;
}

function waitProgressText(condition: string, elapsedMs: number, lastLine?: string): string {
  const last = lastLine ? ` · last: ${JSON.stringify(compactText(lastLine, 60))}` : "";
  return `waiting for ${condition} · ${formatDuration(elapsedMs)}${last}`;
}

function lineForMatch(text: string, match: RegExpMatchArray): string {
  const index = match.index ?? 0;
  const start = text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
  const end = text.indexOf("\n", index + match[0].length);
  return text.slice(start, end === -1 ? text.length : end).replace(/\r$/, "");
}

function lastNonEmptyLine(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = sanitizePaneLine(lines[i].replace(/\r$/, "")).trim();
    if (line) return line;
  }
  return undefined;
}

/** Last lines of captured pane text, sanitized and capped by line count and UTF-8 byte size. */
export function outputTail(text: string, maxLines: number = TAIL_LINES, maxBytes: number = TAIL_BYTES): string {
  const lines = text
    .replace(/\s+$/, "")
    .split("\n")
    .map((line) => sanitizePaneLine(line.replace(/\r$/, "")));
  let tail = lines.slice(-maxLines);
  while (tail.length > 1 && Buffer.byteLength(tail.join("\n"), "utf8") > maxBytes) tail = tail.slice(1);
  const result = tail.join("\n");
  const bytes = Buffer.from(result, "utf8");
  if (bytes.length <= maxBytes) return result;
  return bytes.subarray(bytes.length - maxBytes).toString("utf8").replace(/^�+/, "");
}

function lastLines(text: string, count: number): { text: string; lineCount: number; truncated: boolean } {
  const trimmed = text.replace(/\s+$/, "");
  if (!trimmed) return { text: "", lineCount: 0, truncated: false };
  const lines = trimmed.split("\n").map((line) => sanitizePaneLine(line.replace(/\r$/, "")));
  const kept = lines.slice(-count);
  return { text: kept.join("\n"), lineCount: kept.length, truncated: lines.length > count };
}

function waitForRenderSummary(waitFor: unknown): string | undefined {
  if (!waitFor || typeof waitFor !== "object") return undefined;
  const value = waitFor as { regex?: unknown; event?: unknown; ignore_case?: unknown };
  if (typeof value.regex === "string") {
    const flags = value.ignore_case ? "im" : "m";
    return `/${value.regex}/${flags}`;
  }
  if (typeof value.event === "string") return `event:${value.event}`;
  return undefined;
}

function positiveNumber(value: number | undefined, defaultValue: number, name: string): number {
  const result = value ?? defaultValue;
  if (!Number.isFinite(result) || result <= 0) throw new Error(`${name} must be a positive number.`);
  return result;
}

export function parseWaitFor(waitFor: WaitForOptions): { condition: WaitCondition; timeoutMs: number; pollMs: number } {
  const hasRegex = typeof waitFor.regex === "string" && waitFor.regex.length > 0;
  const hasEvent = typeof waitFor.event === "string";
  if (hasRegex === hasEvent) throw new Error("wait_for must include exactly one of regex or event.");

  const timeoutMs = positiveNumber(waitFor.timeout_ms, DEFAULT_WAIT_TIMEOUT_MS, "wait_for.timeout_ms");
  const pollMs = positiveNumber(waitFor.poll_ms, POLL_MS, "wait_for.poll_ms");

  if (hasEvent) {
    if (waitFor.event !== "exit" && waitFor.event !== "target_closed") {
      throw new Error("wait_for.event must be 'exit' or 'target_closed'.");
    }
    return { condition: { kind: "event", event: waitFor.event }, timeoutMs, pollMs };
  }

  try {
    const flags = waitFor.ignore_case ? "im" : "m";
    return { condition: { kind: "regex", regex: new RegExp(waitFor.regex!, flags), source: waitFor.regex! }, timeoutMs, pollMs };
  } catch (error) {
    throw new Error(`Invalid wait_for.regex: ${errorMessage(error)}`);
  }
}

/** Lets pane output interrupt a polling sleep; a trigger with no sleeper pending is remembered once. */
class Wakeup {
  private pending = false;
  private listener: (() => void) | undefined;

  trigger(): void {
    const listener = this.listener;
    if (listener) {
      this.listener = undefined;
      listener();
    } else {
      this.pending = true;
    }
  }

  /** Returns false when a trigger is already pending, in which case the listener is not installed. */
  listen(listener: () => void): boolean {
    if (this.pending) {
      this.pending = false;
      return false;
    }
    this.listener = listener;
    return true;
  }

  clear(): void {
    this.listener = undefined;
  }
}

function sleep(ms: number, signal?: AbortSignal, wakeup?: Wakeup): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Wait aborted."));
      return;
    }

    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", abort, { once: true });
    if (wakeup && !wakeup.listen(done)) done();

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      wakeup?.clear();
    }
    function done() {
      cleanup();
      resolve();
    }
    function abort() {
      cleanup();
      reject(new Error("Wait aborted."));
    }
  });
}

function enableMouseReporting(): void {
  if (!process.stdout.isTTY) return;
  if (mouseReportingRefCount++ === 0) {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
  }
}

function disableMouseReporting(): void {
  if (!process.stdout.isTTY || mouseReportingRefCount === 0) return;
  mouseReportingRefCount--;
  if (mouseReportingRefCount === 0) {
    process.stdout.write("\x1b[?1006l\x1b[?1000l");
  }
}

function parseSgrMouse(data: string): { button: number; x: number; y: number } | undefined {
  const match = data.match(/^\x1b\[<(\d+);(\d+);(\d+)[Mm]$/);
  if (!match) return undefined;
  return {
    button: Number(match[1]),
    x: Number(match[2]),
    y: Number(match[3]),
  };
}

function wheelScrollDelta(data: string): number | undefined {
  const mouse = parseSgrMouse(data);
  if (!mouse || (mouse.button & 64) === 0) return undefined;

  const wheelButton = mouse.button & 3;
  if (wheelButton === 0) return -WHEEL_SCROLL_LINES;
  if (wheelButton === 1) return WHEEL_SCROLL_LINES;
  return undefined;
}

function maxScrollOffset(lineCount: number, visibleLines: number): number {
  return Math.max(0, lineCount - visibleLines);
}

function clampScrollOffset(offset: number, lineCount: number, visibleLines: number): number {
  return Math.min(Math.max(0, offset), maxScrollOffset(lineCount, visibleLines));
}

function tmux(args: string[]): Promise<string> {
  return runCommand("tmux", args);
}

function runCommand(command: string, args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolve(stdout);
    });
    if (input !== undefined) {
      child.stdin?.on("error", () => {});
      child.stdin?.end(input);
    }
  });
}

function isTmuxMissing(error: unknown): boolean {
  return /ENOENT/.test(errorMessage(error));
}

async function listTmuxSessions(): Promise<string[]> {
  const output = await tmux(["list-sessions", "-F", "#{session_name}"]).catch(() => "");
  return output.split("\n").map((line) => line.trim()).filter(Boolean);
}

async function listTmuxPanes(): Promise<{ target: string; sessionName: string; command: string; paneId: string }[]> {
  const output = await tmux([
    "list-panes",
    "-a",
    "-F",
    "#{session_name}:#{window_index}.#{pane_index}\t#{pane_current_command}\t#{pane_id}\t#{session_name}",
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [target = "", command = "", paneId = "", sessionName = ""] = line.split("\t");
      return { target, command, paneId, sessionName };
    })
    .filter((pane) => pane.target && pane.paneId);
}

async function describeTargetFailure(target: string, error: unknown): Promise<string> {
  if (isTmuxMissing(error)) return "tmux is not installed or not on PATH.";
  const sessions = await listTmuxSessions();
  if (sessions.length === 0) return `No tmux sessions are running, so ${target} cannot be attached.`;
  return `tmux target ${target} was not found. Available sessions: ${sessions.join(", ")}.`;
}

async function createPaneStream(target: string): Promise<PaneStream> {
  try {
    const fifoPath = join(tmpdir(), `pi-live-terminal-${process.pid}-${randomBytes(6).toString("hex")}.fifo`);
    await runCommand("mkfifo", [fifoPath]);

    const stream = createReadStream(fifoPath, { encoding: "utf8" });
    const paneStream: PaneStream = {
      target,
      fifoPath,
      stream,
      subscribers: new Set(),
    };

    stream.on("data", (chunk) => {
      for (const subscriber of paneStream.subscribers) subscriber(String(chunk));
    });

    stream.on("error", () => {
      void closePaneStream(target).catch(() => {});
    });

    try {
      await tmux(["pipe-pane", "-O", "-t", target, `cat > ${shellQuote(fifoPath)}`]);
    } catch (error) {
      stream.destroy();
      await fs.unlink(fifoPath).catch(() => {});
      throw error;
    }

    paneStreams.set(target, paneStream);
    paneStreamCreates.delete(target);
    return paneStream;
  } catch (error) {
    paneStreamCreates.delete(target);
    throw error;
  }
}

async function closePaneStream(target: string): Promise<void> {
  const paneStream = paneStreams.get(target);
  if (!paneStream) return;

  paneStreams.delete(target);
  paneStreamCreates.delete(target);
  await tmux(["pipe-pane", "-t", target]).catch(() => {});
  paneStream.stream.destroy();
  await fs.unlink(paneStream.fifoPath).catch(() => {});
}

async function subscribePaneOutput(target: string, subscriber: PaneSubscriber): Promise<() => Promise<void>> {
  let paneStream = paneStreams.get(target);
  if (!paneStream) {
    const existingPipe = await tmux(["display-message", "-p", "-t", target, "#{pane_pipe}"]).catch(() => "");
    if (existingPipe.trim()) {
      // Never replace a pipe-pane installed by the user. Callers retain their polling fallback.
      return async () => {};
    }
    const pending = paneStreamCreates.get(target) ?? createPaneStream(target);
    paneStreamCreates.set(target, pending);
    paneStream = await pending;
  }
  paneStream.subscribers.add(subscriber);

  return async () => {
    const active = paneStreams.get(target);
    if (!active) return;
    active.subscribers.delete(subscriber);
    if (active.subscribers.size === 0) {
      await closePaneStream(target);
    }
  };
}

function sendTmuxLiteral(target: string, text: string): Promise<string> {
  return tmux(["send-keys", "-t", target, "-l", "--", text]);
}

function sendTmuxInput(target: string, data: string): Promise<string> {
  const printable = decodeKittyPrintable(data) ?? (isPrintableText(data) ? data : undefined);
  if (printable !== undefined) {
    return sendTmuxLiteral(target, printable);
  }

  const key = parseKey(data);
  const tmuxKey = key ? toTmuxKey(key) : undefined;
  if (tmuxKey) {
    return tmux(["send-keys", "-t", target, tmuxKey]);
  }

  return sendTmuxLiteral(target, data);
}

async function getTmuxTargetInfo(target: string): Promise<{ target: string; sessionName?: string }> {
  const output = await tmux(["list-panes", "-t", target, "-F", "#{pane_id}\t#{session_name}"]);
  const [paneId, sessionName] = output.trim().split("\n")[0]?.split("\t") ?? [];
  if (!paneId) throw new Error(`Could not resolve tmux target ${target}.`);
  return { target: paneId, sessionName: sessionName || undefined };
}

async function tmuxTargetExists(target: string): Promise<boolean> {
  if (target.startsWith("%")) {
    const panes = await tmux(["list-panes", "-a", "-F", "#{pane_id}"]).catch(() => "");
    return panes.split("\n").includes(target);
  }

  try {
    await tmux(["list-panes", "-t", target, "-F", "#{pane_id}"]);
    return true;
  } catch {
    return false;
  }
}

/** Reads the pane's exit status and whether it still exists; a missing pane prints an empty pane id. */
async function readPaneStatus(target: string): Promise<{ exists: boolean; status?: string }> {
  let output: string;
  try {
    output = await tmux(["display-message", "-p", "-t", target, "#{pane_id}\t#{@pi_tmux_run_status}"]);
  } catch (error) {
    if (!(await tmuxTargetExists(target))) return { exists: false };
    throw error;
  }
  const [paneId = "", status = ""] = output.replace(/\n$/, "").split("\t");
  if (!paneId.trim()) return { exists: false };
  return { exists: true, status: status.trim() || undefined };
}

async function getExitStatus(target: string): Promise<string | undefined> {
  const status = await tmux([
    "show-option",
    "-p",
    "-qv",
    "-t",
    target,
    "@pi_tmux_run_status",
  ]).catch(() => "");
  return status.trim() || undefined;
}

async function capturePaneText(target: string, lines: number = CAPTURE_LINES): Promise<string> {
  return tmux([
    "capture-pane",
    "-p",
    "-J",
    "-S",
    `-${lines}`,
    "-t",
    target,
  ]);
}

async function capturePaneDisplayLines(target: string, lines: number = CAPTURE_LINES): Promise<string[]> {
  const output = await tmux([
    "capture-pane",
    "-p",
    "-e",
    "-J",
    "-S",
    `-${lines}`,
    "-t",
    target,
  ]);
  const trimmed = output.replace(/\s+$/g, "");
  return (trimmed ? trimmed.split("\n") : [""]).map(sanitizePaneLine);
}

async function copyToClipboard(text: string): Promise<string> {
  const candidates: [string, string[]][] = [];
  if (process.platform === "darwin") candidates.push(["pbcopy", []]);
  if (process.env.WAYLAND_DISPLAY) candidates.push(["wl-copy", []]);
  if (process.env.DISPLAY) candidates.push(["xclip", ["-selection", "clipboard"]]);
  for (const [command, args] of candidates) {
    try {
      await runCommand(command, args, text);
      return command;
    } catch {
      // Try the next clipboard mechanism.
    }
  }

  if (!process.stdout.isTTY) throw new Error("no clipboard command is available and stdout is not a terminal");
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
  return "OSC 52";
}

async function copyPaneToClipboard(target: string, lines: number): Promise<{ lines: number; method: string }> {
  const tail = lastLines(await capturePaneText(target, lines), lines);
  const method = await copyToClipboard(tail.text);
  return { lines: tail.lineCount, method };
}

function skipEscapeSequence(value: string, position: number): number {
  const next = value[position + 1];
  if (!next) return 1;

  if (next === "[") {
    for (let i = position + 2; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0x40 && code <= 0x7e) return i + 1 - position;
    }
    return value.length - position;
  }

  if (next === "]" || next === "P" || next === "_" || next === "^") {
    for (let i = position + 2; i < value.length; i++) {
      if (value[i] === "\x07") return i + 1 - position;
      if (value[i] === "\x1b" && value[i + 1] === "\\") return i + 2 - position;
    }
    return value.length - position;
  }

  return 2;
}

function sanitizePaneLine(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] === "\x1b") {
      const sgr = line.slice(i).match(/^\x1b\[[0-9;:]*m/);
      if (sgr) {
        result += sgr[0];
        i += sgr[0].length;
      } else {
        i += skipEscapeSequence(line, i);
      }
      continue;
    }

    const code = line.codePointAt(i) ?? 0;
    const char = String.fromCodePoint(code);
    if (char === "\t") {
      result += "   ";
    } else if ((code >= 0x20 && code < 0x7f) || code > 0x9f) {
      result += char;
    }
    i += char.length;
  }
  return result;
}

export async function waitForTerminal(
  target: string,
  waitFor: WaitForOptions,
  options: WaitTerminalOptions = {},
): Promise<WaitResult> {
  const { condition, timeoutMs, pollMs } = parseWaitFor(waitFor);
  const deps: WaitDeps = {
    captureText: (paneTarget) => capturePaneText(paneTarget),
    exitStatus: getExitStatus,
    targetExists: tmuxTargetExists,
    subscribe: subscribePaneOutput,
    ...options.deps,
  };
  const startedAt = Date.now();
  const deadline = startedAt + timeoutMs;
  const description = waitDescription(condition);
  const elapsed = () => Date.now() - startedAt;

  if (condition.kind === "event" && condition.event === "exit" && !(options.exitTracked ?? startedTargets.has(target))) {
    const status = await deps.exitStatus(target);
    if (status !== undefined) return { matched: true, condition: description, status, elapsedMs: elapsed() };
    throw new Error(
      `wait_for.event 'exit' only works for commands started by live_terminal_run; ${target} is an existing tmux session that never records an exit status. Use wait_for.regex or wait_for.event='target_closed' instead.`,
    );
  }

  const wakeup = new Wakeup();
  const unsubscribe = condition.kind === "regex"
    ? await deps.subscribe(target, () => wakeup.trigger()).catch(() => undefined)
    : undefined;
  let lastTickAt = Number.NEGATIVE_INFINITY;

  try {
    while (true) {
      let lastLine: string | undefined;
      if (condition.kind === "event" && condition.event === "target_closed") {
        if (!(await deps.targetExists(target))) {
          return { matched: true, condition: description, elapsedMs: elapsed() };
        }
      } else if (condition.kind === "event") {
        const status = await deps.exitStatus(target);
        if (status !== undefined) {
          return { matched: true, condition: description, status, elapsedMs: elapsed() };
        }
      } else {
        const output = await deps.captureText(target);
        const match = output.match(condition.regex);
        if (match) {
          return { matched: true, condition: description, match: lineForMatch(output, match), elapsedMs: elapsed() };
        }
        lastLine = lastNonEmptyLine(output);
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        const recent = await deps.captureText(target).catch(() => "");
        const stillRunning = await deps.targetExists(target).catch(() => false);
        return {
          matched: false,
          timedOut: true,
          condition: description,
          elapsedMs: elapsed(),
          recentOutput: outputTail(recent) || undefined,
          stillRunning,
        };
      }

      if (options.onTick && Date.now() - lastTickAt >= WAIT_PROGRESS_MS) {
        lastTickAt = Date.now();
        if (condition.kind === "event") lastLine = lastNonEmptyLine(await deps.captureText(target).catch(() => ""));
        options.onTick(elapsed(), lastLine);
      }
      await sleep(Math.min(pollMs, remainingMs), options.signal, wakeup);
    }
  } finally {
    if (unsubscribe) await unsubscribe().catch(() => {});
  }
}

function isPrintableText(data: string): boolean {
  return data.length > 0 && !data.startsWith("\x1b") && Array.from(data).every((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 32 && code !== 127;
  });
}

export function toTmuxKey(key: string): string | undefined {
  const special: Record<string, string> = {
    escape: "Escape",
    esc: "Escape",
    enter: "Enter",
    return: "Enter",
    tab: "Tab",
    backspace: "BSpace",
    delete: "DC",
    insert: "IC",
    home: "Home",
    end: "End",
    pageUp: "PPage",
    pageDown: "NPage",
    up: "Up",
    down: "Down",
    left: "Left",
    right: "Right",
    f1: "F1",
    f2: "F2",
    f3: "F3",
    f4: "F4",
    f5: "F5",
    f6: "F6",
    f7: "F7",
    f8: "F8",
    f9: "F9",
    f10: "F10",
    f11: "F11",
    f12: "F12",
  };
  if (special[key]) return special[key];

  const parts = key.split("+");
  const base = parts.pop();
  if (!base) return undefined;
  const tmuxBase = special[base] || base;
  const modifiers = parts
    .map((part) => ({ ctrl: "C", shift: "S", alt: "M" })[part])
    .filter(Boolean);
  if (modifiers.length === 0) return undefined;
  return `${modifiers.join("-")}-${tmuxBase}`;
}

/** Normalizes agent-supplied key names so the shared toTmuxKey mapping can resolve them. */
function normalizeSendKeyName(key: string): string {
  const parts = key.trim().split("+");
  const base = parts.pop() ?? "";
  const normalizedBase = base.length === 1 ? base.toLowerCase() : base.slice(0, 1).toLowerCase() + base.slice(1);
  return [...parts.map((part) => part.toLowerCase()), normalizedBase].join("+");
}

/**
 * Shared streaming, polling, scrolling, and framing for the inline widget and the focus modal.
 * Subclasses call start() at the end of their constructors, once their own fields exist.
 */
abstract class PaneView implements Component {
  protected readonly tui: TUI;
  protected readonly theme: Theme;
  protected readonly attachment: LiveTerminalAttachment;
  private readonly onExit: ((status: string) => void) | undefined;
  protected lines: string[] = [];
  protected error: string | undefined;
  protected state: PaneState = "unknown";
  protected exitStatus: string | undefined;
  protected ended = false;
  protected disposed = false;
  private scrollOffset = 0;
  private follow = true;
  private lastResize = "";
  private resizeAllowed: boolean;
  private timer: NodeJS.Timeout | undefined;
  private unsubscribeStream: (() => Promise<void>) | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private refreshRunning = false;
  private refreshAgain = false;
  private statusSignature = "";

  constructor(tui: TUI, theme: Theme, attachment: LiveTerminalAttachment, onExit?: (status: string) => void) {
    this.tui = tui;
    this.theme = theme;
    this.attachment = attachment;
    this.onExit = onExit;
    this.resizeAllowed = !attachment.attachedExisting;
  }

  protected abstract visibleLines(): number;
  protected abstract borderRole(): BorderRole;
  protected abstract footerHints(indicator: string): string[];

  protected captureLimit(): number {
    return CAPTURE_LINES;
  }

  protected resizeEnabled(): boolean {
    return true;
  }

  protected leadingBlank(): boolean {
    return false;
  }

  protected handleKey(_data: string): boolean {
    return false;
  }

  protected start(): void {
    this.timer = setInterval(() => void this.refreshStatus(), POLL_MS);
    void this.initialize();
  }

  private async initialize(): Promise<void> {
    try {
      if (this.attachment.attachedExisting) {
        // Resizing a window someone is attached to elsewhere would clip their view.
        const clients = await tmux(["display-message", "-p", "-t", this.attachment.target, "#{session_attached}"]).catch(() => "1");
        this.resizeAllowed = Number(clients.trim()) === 0;
      }

      this.unsubscribeStream = await subscribePaneOutput(this.attachment.target, () => this.scheduleOutputRefresh());
      if (this.disposed) {
        await this.unsubscribeStream().catch(() => {});
        this.unsubscribeStream = undefined;
        return;
      }

      await this.refreshOutput();
      if (this.disposed) return;

      await this.refreshStatus();
      if (this.disposed) return;
    } catch (error) {
      if (this.disposed) return;
      await this.handleTmuxError(error);
      this.tui.requestRender();
      return;
    }
    if (!this.disposed) this.tui.requestRender();
  }

  protected lineCount(): number {
    if (this.error) return 1;
    return this.lines.length + (this.ended ? 1 : 0);
  }

  private bodyLines(): string[] {
    if (this.error) return [this.theme.fg("error", `tmux: ${this.error}`)];
    if (this.ended) return [...this.lines, this.theme.fg("warning", ENDED_LINE)];
    return this.lines;
  }

  private effectiveOffset(visibleLines: number): number {
    if (this.error) return 0;
    const count = this.lineCount();
    this.scrollOffset = this.follow
      ? maxScrollOffset(count, visibleLines)
      : clampScrollOffset(this.scrollOffset, count, visibleLines);
    return this.scrollOffset;
  }

  private scheduleOutputRefresh(): void {
    if (this.disposed || this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refreshOutput();
    }, 16);
  }

  private async refreshOutput(): Promise<void> {
    if (this.disposed || this.ended) return;
    if (this.refreshRunning) {
      this.refreshAgain = true;
      return;
    }

    this.refreshRunning = true;
    try {
      const lines = await capturePaneDisplayLines(this.attachment.target, this.captureLimit());
      if (this.disposed) return;
      this.lines = lines;
      this.error = undefined;
    } catch (error) {
      if (!this.disposed) await this.handleTmuxError(error);
    } finally {
      this.refreshRunning = false;
      if (!this.disposed) {
        this.tui.requestRender();
        if (this.refreshAgain) {
          this.refreshAgain = false;
          this.scheduleOutputRefresh();
        }
      }
    }
  }

  private async refreshStatus(): Promise<void> {
    if (this.disposed || this.ended) return;
    let paneStatus: { exists: boolean; status?: string };
    try {
      paneStatus = await readPaneStatus(this.attachment.target);
    } catch (error) {
      if (this.disposed) return;
      this.error = errorMessage(error);
      this.tui.requestRender();
      return;
    }
    if (this.disposed) return;
    if (!paneStatus.exists) {
      this.markEnded();
      return;
    }

    const exitStatus = paneStatus.status;
    const wasCompleted = this.state === "completed";
    this.exitStatus = exitStatus;
    this.state = exitStatus ? "completed" : "running";
    if (exitStatus && !wasCompleted) this.onExit?.(exitStatus);
    if (!exitStatus) await this.refreshOutput();

    // Once completed, one more output refresh is enough; stop polling so the widget stops re-rendering.
    const signature = `${this.state}|${exitStatus ?? ""}|${this.error ?? ""}`;
    if (this.state === "completed" && signature === this.statusSignature) {
      this.stopPolling();
      await this.refreshOutput();
      return;
    }
    this.statusSignature = signature;
    this.tui.requestRender();
  }

  private async handleTmuxError(error: unknown): Promise<void> {
    if (!(await tmuxTargetExists(this.attachment.target))) {
      this.markEnded();
      return;
    }
    if (!this.disposed) this.error = errorMessage(error);
  }

  private markEnded(): void {
    if (this.ended || this.disposed) return;
    this.ended = true;
    this.error = undefined;
    this.follow = true;
    this.stopPolling();
    this.releaseStream();
    this.tui.requestRender();
  }

  private stopPolling(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private releaseStream(): void {
    if (this.unsubscribeStream) {
      void this.unsubscribeStream().catch(() => {});
      this.unsubscribeStream = undefined;
    }
  }

  requestRender(): void {
    if (!this.disposed) this.tui.requestRender();
  }

  /** Forget the last applied tmux size so the next render resizes the window again. */
  invalidateSize(): void {
    this.lastResize = "";
    this.requestRender();
  }

  scrollBy(delta: number): void {
    const visibleLines = this.visibleLines();
    const count = this.lineCount();
    const current = this.effectiveOffset(visibleLines);
    this.scrollOffset = clampScrollOffset(current + delta, count, visibleLines);
    this.follow = this.scrollOffset >= maxScrollOffset(count, visibleLines);
    this.requestRender();
  }

  scrollPage(direction: 1 | -1): void {
    this.scrollBy(direction * Math.max(1, this.visibleLines()));
  }

  scrollToTop(): void {
    this.follow = maxScrollOffset(this.lineCount(), this.visibleLines()) === 0;
    this.scrollOffset = 0;
    this.requestRender();
  }

  scrollToBottom(): void {
    this.follow = true;
    this.requestRender();
  }

  protected isFollowing(): boolean {
    return this.follow;
  }

  handleInput(data: string): void {
    const delta = wheelScrollDelta(data);
    if (delta !== undefined) {
      this.scrollBy(delta);
      return;
    }
    if (parseSgrMouse(data)) return;
    this.handleKey(data);
  }

  private titleText(): string {
    const glyph = this.ended && this.state !== "completed" ? "⚫" : statusGlyph(this.state, this.exitStatus);
    let suffix = "";
    if (this.state === "completed" && this.exitStatus !== undefined) suffix = ` · exit ${this.exitStatus}`;
    else if (this.ended) suffix = " · ended";
    else if (this.attachment.startedAt !== undefined) suffix = ` · ${formatElapsed(this.attachment.startedAt)}`;
    return ` ${glyph} Live Terminal (${this.attachment.title})${suffix} `;
  }

  render(width: number): string[] {
    const visibleLines = this.visibleLines();
    if (this.resizeAllowed && this.resizeEnabled() && visibleLines > 0) {
      const tmuxW = Math.max(1, Math.max(1, width - 2) - CONTENT_PADDING * 2);
      const resizeKey = `${tmuxW}x${visibleLines}`;
      if (resizeKey !== this.lastResize) {
        this.lastResize = resizeKey;
        void tmux([
          "resize-window",
          "-t",
          this.attachment.target,
          "-x",
          String(tmuxW),
          "-y",
          String(visibleLines),
        ]).catch(() => {});
      }
    }

    const role = this.borderRole();
    const border = (s: string) => this.theme.fg(role, s);
    const scrollOffset = this.effectiveOffset(visibleLines);
    const indicator = scrollIndicatorText(scrollOffset, this.lineCount(), visibleLines);
    return renderPaneFrame({
      width,
      title: this.titleText(),
      body: this.bodyLines(),
      scrollOffset,
      visibleLines,
      hints: this.footerHints(indicator).join(border(" · ")),
      border,
      leadingBlank: this.leadingBlank(),
    });
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    this.stopPolling();
    this.releaseStream();
  }
}

class LiveTerminalWidget extends PaneView {
  constructor(tui: TUI, theme: Theme, attachment: LiveTerminalAttachment, onExit?: (status: string) => void) {
    super(tui, theme, attachment, onExit);
    this.start();
  }

  protected visibleLines(): number {
    return widgetCollapsed ? 0 : clampWidgetHeight(this.tui.terminal.rows, widgetHeightOverride);
  }

  protected borderRole(): BorderRole {
    return "border";
  }

  protected leadingBlank(): boolean {
    return true;
  }

  protected resizeEnabled(): boolean {
    // The focus modal owns the pane size while it is open; collapsed widgets never resize.
    return !widgetCollapsed && !focusModalOpen;
  }

  protected footerHints(indicator: string): string[] {
    const th = this.theme;
    const key = (s: string) => th.fg("muted", s);
    const dim = (s: string) => th.fg("dim", s);
    const hints: string[] = [];
    if (indicator) hints.push(th.fg(indicator === "LIVE" ? "success" : "warning", ` ${indicator} `));

    if (widgetCollapsed) {
      hints.push(key(" cmd+option+m ") + dim("expand"), key(" cmd+option+f ") + dim("focus"));
      return hints;
    }

    hints.push(key(" cmd+option+f ") + dim("focus"));
    if (this.state === "completed" || this.ended) {
      hints.push(key(" cmd+option+v ") + dim("close"));
    } else {
      hints.push(key(" cmd+option+x ") + dim("kill"), key(" cmd+option+v ") + dim("detach"));
    }
    if (attachments.size > 1) hints.push(key(" cmd+option+s ") + dim(`switch (${attachments.size})`));
    hints.push(key(" cmd+option+m ") + dim("collapse"));
    return hints;
  }

  dispose(): void {
    if (activeWidget === this) activeWidget = undefined;
    super.dispose();
  }
}

class TmuxFocusModal extends PaneView {
  private readonly done: () => void;
  private notice: string | undefined;
  private noticeTimer: NodeJS.Timeout | undefined;
  private pendingChord: string | undefined;
  private chordTimer: NodeJS.Timeout | undefined;
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(
    tui: TUI,
    theme: Theme,
    attachment: LiveTerminalAttachment,
    done: () => void,
    onExit?: (status: string) => void,
  ) {
    super(tui, theme, attachment, onExit);
    this.done = done;
    enableMouseReporting();
    if (!focusBannerShown) {
      focusBannerShown = true;
      this.showNotice("Keys go to tmux. Press cmd+option+f or ctrl+] twice to return.", BANNER_MS);
    }
    this.start();
  }

  protected visibleLines(): number {
    return Math.max(1, this.tui.terminal.rows - 2);
  }

  protected captureLimit(): number {
    return FOCUS_CAPTURE_LINES;
  }

  protected borderRole(): BorderRole {
    return "borderAccent";
  }

  protected footerHints(indicator: string): string[] {
    const th = this.theme;
    const key = (s: string) => th.fg("accent", s);
    const dim = (s: string) => th.fg("dim", s);
    const hints = [key(" cmd+option+f ") + dim("or ") + key("ctrl+] ×2 ") + dim("close focus")];
    if (indicator) hints.push(th.fg(indicator === "LIVE" ? "success" : "warning", ` ${indicator} `));
    if (this.notice) {
      hints.push(th.fg("warning", ` ${this.notice} `));
      return hints;
    }
    hints.push(
      key(" shift+↑↓/PgUp/PgDn ") + dim("scroll"),
      key(" cmd+option+c ") + dim("copy"),
      dim("input is sent to tmux"),
    );
    return hints;
  }

  protected handleKey(data: string): boolean {
    if (matchesKey(data, Key.ctrl("]"))) {
      if (this.pendingChord !== undefined) {
        this.clearChord();
        this.done();
        return true;
      }
      // Hold the first ctrl+] briefly; forward it to tmux if no second press follows.
      this.pendingChord = data;
      this.showNotice("Press ctrl+] again to return to Pi", EXIT_CHORD_MS);
      this.chordTimer = setTimeout(() => {
        const pending = this.pendingChord;
        this.clearChord();
        if (pending !== undefined) this.forward(pending);
      }, EXIT_CHORD_MS);
      return true;
    }
    if (this.pendingChord !== undefined) {
      const pending = this.pendingChord;
      this.clearChord();
      this.forward(pending);
    }

    if (matchesKey(data, Key.superAlt("f"))) {
      this.done();
    } else if (matchesKey(data, Key.superAlt("c"))) {
      void this.copy();
    } else if (matchesKey(data, Key.shift("up"))) {
      this.scrollBy(-WHEEL_SCROLL_LINES);
    } else if (matchesKey(data, Key.shift("down"))) {
      this.scrollBy(WHEEL_SCROLL_LINES);
    } else if (matchesKey(data, Key.shift("pageUp"))) {
      this.scrollPage(-1);
    } else if (matchesKey(data, Key.shift("pageDown"))) {
      this.scrollPage(1);
    } else if (matchesKey(data, Key.shift("home"))) {
      this.scrollToTop();
    } else if (matchesKey(data, Key.shift("end"))) {
      this.scrollToBottom();
    } else {
      if (!this.isFollowing()) this.scrollToBottom();
      this.forward(data);
    }
    return true;
  }

  private forward(data: string): void {
    this.sendQueue = this.sendQueue
      .then(() => sendTmuxInput(this.attachment.target, data))
      .then(() => this.requestRender())
      .catch((error) => {
        this.error = errorMessage(error);
        this.requestRender();
      });
  }

  private clearChord(): void {
    this.pendingChord = undefined;
    if (this.chordTimer) {
      clearTimeout(this.chordTimer);
      this.chordTimer = undefined;
    }
  }

  private showNotice(text: string, durationMs: number): void {
    this.notice = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => {
      this.noticeTimer = undefined;
      this.notice = undefined;
      this.requestRender();
    }, durationMs);
    this.requestRender();
  }

  private async copy(): Promise<void> {
    try {
      const result = await copyPaneToClipboard(this.attachment.target, FOCUS_CAPTURE_LINES);
      this.showNotice(`Copied ${result.lines} lines via ${result.method}`, NOTICE_MS);
    } catch (error) {
      this.showNotice(`Copy failed: ${errorMessage(error)}`, NOTICE_MS);
    }
  }

  dispose(): void {
    disableMouseReporting();
    this.clearChord();
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    super.dispose();
  }
}

type CloseResult = {
  message: string;
  killed: boolean;
  action: CloseAction | "none" | "cancelled";
  sessionName?: string;
  target?: string;
};

type RunToolDetails = {
  sessionName?: string;
  target?: string;
  command?: string;
  cwd?: string;
  waitResult?: WaitResult;
  visibleMessage?: string;
  progress?: { condition: string; elapsedMs: number; lastLine?: string };
};

type ReadToolDetails = {
  target: string;
  sessionName?: string;
  state: PaneState;
  exitStatus?: string;
  lines: number;
  truncated: boolean;
  header: string;
};

function entrySummary(data: LiveTerminalEntryData): { text: string; color: "accent" | "success" | "error" | "muted" | "warning" } | undefined {
  const name = data.sessionName || data.title || data.target || DEFAULT_TITLE;
  switch (data.action) {
    case "open":
      return data.attachedExisting
        ? { text: `Attached to tmux session ${name}`, color: "accent" }
        : { text: `Started live terminal "${data.title || name}"${data.command ? ` (${compactText(data.command, 80)})` : ""}`, color: "accent" };
    case "exit":
      return {
        text: `Live terminal "${data.title || name}" exited with status ${data.status ?? "?"}`,
        color: data.status === "0" ? "success" : "error",
      };
    case "detach":
    case "close":
      return { text: `Detached from live terminal ${name}${data.reason ? ` (${data.reason})` : ""}`, color: "muted" };
    case "kill":
      return { text: `Killed tmux session ${name}`, color: "warning" };
    default:
      return undefined;
  }
}

export default function (pi: ExtensionAPI) {
  let exitMonitor: NodeJS.Timeout | undefined;
  let exitMonitorCtx: ExtensionContext | undefined;
  let exitMonitorBusy = false;
  let tmuxWarningShown = false;

  function activeAttachment(): LiveTerminalAttachment | undefined {
    return activeTarget ? attachments.get(activeTarget) : undefined;
  }

  function updateStatus(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const attachment = activeAttachment();
    if (!attachment) {
      ctx.ui.setStatus(STATUS_ID, undefined);
      return;
    }
    const others = attachments.size - 1;
    ctx.ui.setStatus(STATUS_ID, `tmux: ${attachmentName(attachment)} ${statusBadge(attachment)}${others > 0 ? ` (+${others})` : ""}`);
  }

  function trackAttachment(attachment: LiveTerminalAttachment) {
    // Re-inserting keeps Map order equal to recency, which the switcher and fallbacks rely on.
    attachments.delete(attachment.target);
    attachments.set(attachment.target, attachment);
    if (!attachment.attachedExisting) startedTargets.add(attachment.target);
  }

  function nextAttachment(): LiveTerminalAttachment | undefined {
    const recentFirst = [...attachments.values()].reverse();
    return recentFirst.find((attachment) => attachment.state !== "completed") ?? recentFirst[0];
  }

  /** Makes an attachment the visible one. Lifecycle tracking is independent of whether a UI exists. */
  function showAttachment(ctx: ExtensionContext, attachment: LiveTerminalAttachment, options: { announceDisplaced?: boolean } = {}) {
    const previous = activeAttachment();
    activeTarget = attachment.target;
    if (ctx.hasUI) {
      if (
        options.announceDisplaced !== false &&
        previous &&
        previous.target !== attachment.target &&
        previous.state !== "completed"
      ) {
        ctx.ui.notify(`Previous terminal ${attachmentName(previous)} is still running — cmd+option+s to switch`, "info");
      }
      ctx.ui.setWidget(
        WIDGET_ID,
        (tui: TUI, theme: Theme) => {
          const widget = new LiveTerminalWidget(
            tui,
            theme,
            attachment,
            (status) => reportProcessExit(ctx, attachment, status),
          );
          activeWidget = widget;
          return widget;
        },
        { placement: "aboveEditor" },
      );
    }
    updateStatus(ctx);
    ensureExitMonitor(ctx);
  }

  function clearVisible(ctx: ExtensionContext) {
    activeTarget = undefined;
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_ID, undefined);
    updateStatus(ctx);
  }

  function reportProcessExit(ctx: ExtensionContext, attachment: LiveTerminalAttachment, status: string) {
    if (reportedExitTargets.has(attachment.target)) return;
    reportedExitTargets.add(attachment.target);

    const tracked = attachments.get(attachment.target);
    if (tracked !== attachment) return;
    tracked.state = "completed";
    tracked.status = status;
    const name = attachmentName(tracked);

    pi.appendEntry<LiveTerminalEntryData>(ENTRY_TYPE, {
      action: "exit",
      target: tracked.target,
      sessionName: tracked.sessionName,
      title: tracked.title,
      command: tracked.command,
      cwd: tracked.cwd,
      status,
      at: Date.now(),
    });
    if (ctx.hasUI) ctx.ui.notify(`Session exited with status code ${status}: ${name}`, status === "0" ? "info" : "warning");
    const command = tracked.command ? ` (command: ${JSON.stringify(compactText(tracked.command, 200))})` : "";
    pi.sendMessage({
      customType: MESSAGE_TYPE,
      content: `Live terminal ${name} exited with status ${status}${command}.`,
      display: false,
      details: {
        event: "exit",
        sessionName: tracked.sessionName,
        target: tracked.target,
        title: tracked.title,
        command: tracked.command ? compactText(tracked.command, 300) : undefined,
        status,
      },
    }, { deliverAs: "nextTurn" });
    updateStatus(ctx);
  }

  function stopExitMonitor() {
    if (exitMonitor) clearInterval(exitMonitor);
    exitMonitor = undefined;
  }

  /** Background terminals have no widget polling them, so exits are detected here as well. */
  function ensureExitMonitor(ctx: ExtensionContext) {
    exitMonitorCtx = ctx;
    if (exitMonitor) return;
    exitMonitor = setInterval(() => void pollExits(), EXIT_MONITOR_MS);
    exitMonitor.unref();
  }

  async function pollExits() {
    if (exitMonitorBusy) return;
    const pending = [...attachments.values()].filter((attachment) =>
      attachment.state !== "completed" &&
      startedTargets.has(attachment.target) &&
      !reportedExitTargets.has(attachment.target)
    );
    if (pending.length === 0) {
      stopExitMonitor();
      return;
    }

    exitMonitorBusy = true;
    try {
      for (const attachment of pending) {
        const paneStatus = await readPaneStatus(attachment.target).catch(() => undefined);
        if (!paneStatus) continue;
        if (!paneStatus.exists) {
          attachment.state = "completed";
          attachment.status = undefined;
          continue;
        }
        if (paneStatus.status !== undefined && exitMonitorCtx && attachments.get(attachment.target) === attachment) {
          reportProcessExit(exitMonitorCtx, attachment, paneStatus.status);
        }
      }
    } finally {
      exitMonitorBusy = false;
    }
  }

  async function startLiveTerminal(
    ctx: ExtensionContext,
    command: string,
    options: { sessionName?: string; title?: string; cwd?: string } = {},
  ): Promise<LiveTerminalAttachment> {
    const sessionName = safeSessionName(options.sessionName);
    if (options.sessionName && (await listTmuxSessions()).includes(sessionName)) {
      throw new Error(
        `Session ${sessionName} already exists; pick another session_name or attach with live_terminal_run({ target: ${JSON.stringify(sessionName)} }).`,
      );
    }

    const title = options.title || options.sessionName || compactText(command, 48) || DEFAULT_TITLE;
    const cwd = options.cwd || ctx.cwd || process.cwd();
    const shellCommand = `bash -lc ${shellQuote(`${command}
status=$?
printf '\n[Session exited with status %s]\n' "$status"
tmux set-option -p -t "$TMUX_PANE" @pi_tmux_run_status "$status" 2>/dev/null || true`)}`;

    await tmux(["new-session", "-d", "-s", sessionName, "-c", cwd]);

    const paneId = await tmux(["display-message", "-p", "-t", sessionName, "#{pane_id}"]);
    const target = paneId.trim() || sessionName;
    await sendTmuxLiteral(target, shellCommand);
    await tmux(["send-keys", "-t", target, "Enter"]);

    const attachment: LiveTerminalAttachment = { target, sessionName, title, command, cwd, state: "running", startedAt: Date.now() };
    reportedExitTargets.delete(target);
    trackAttachment(attachment);
    pi.appendEntry<LiveTerminalEntryData>(ENTRY_TYPE, {
      action: "open",
      target,
      sessionName,
      title,
      command,
      cwd,
      state: "running",
      startedAt: attachment.startedAt,
      at: attachment.startedAt,
    });
    showAttachment(ctx, attachment);
    return attachment;
  }

  async function attachLiveTerminal(
    ctx: ExtensionContext,
    target: string,
    options: { title?: string } = {},
  ): Promise<LiveTerminalAttachment> {
    let info: { target: string; sessionName?: string };
    try {
      info = await getTmuxTargetInfo(target);
    } catch (error) {
      throw new Error(await describeTargetFailure(target, error));
    }

    const existing = attachments.get(info.target);
    if (existing) {
      trackAttachment(existing);
      showAttachment(ctx, existing);
      return existing;
    }

    const attachment: LiveTerminalAttachment = {
      target: info.target,
      sessionName: info.sessionName,
      title: options.title || info.sessionName || target,
      state: "running",
      attachedExisting: !startedTargets.has(info.target),
    };
    trackAttachment(attachment);
    pi.appendEntry<LiveTerminalEntryData>(ENTRY_TYPE, {
      action: "open",
      target: attachment.target,
      sessionName: attachment.sessionName,
      title: attachment.title,
      attachedExisting: attachment.attachedExisting,
      at: Date.now(),
    });
    showAttachment(ctx, attachment);
    return attachment;
  }

  async function resolveAttachment(ref?: string): Promise<LiveTerminalAttachment | undefined> {
    if (!ref) return activeAttachment();
    const direct = attachments.get(ref) ?? [...attachments.values()].find((attachment) => attachment.sessionName === ref);
    if (direct) return direct;
    const info = await getTmuxTargetInfo(ref).catch(() => undefined);
    return info ? attachments.get(info.target) : undefined;
  }

  /** Resolves a tracked attachment, or any tmux target the agent names explicitly. */
  async function resolveToolTarget(ref?: string): Promise<{ target: string; name: string; sessionName?: string }> {
    const attachment = await resolveAttachment(ref);
    if (attachment) return { target: attachment.target, name: attachmentName(attachment), sessionName: attachment.sessionName };
    if (!ref) throw new Error("No live terminal is attached. Pass target or session_name, or start one with live_terminal_run.");
    try {
      const info = await getTmuxTargetInfo(ref);
      return { target: info.target, name: info.sessionName || ref, sessionName: info.sessionName };
    } catch (error) {
      throw new Error(await describeTargetFailure(ref, error));
    }
  }

  async function killAttachmentSession(attachment: LiveTerminalAttachment) {
    if (!attachment.sessionName) {
      await tmux(["kill-pane", "-t", attachment.target]);
      return;
    }

    try {
      await tmux(["kill-session", "-t", attachment.sessionName]);
    } catch {
      await tmux(["kill-pane", "-t", attachment.target]);
    }
  }

  function untrack(ctx: ExtensionContext, attachment: LiveTerminalAttachment, action: "detach" | "kill", reason?: string) {
    pi.appendEntry<LiveTerminalEntryData>(ENTRY_TYPE, {
      action,
      target: attachment.target,
      sessionName: attachment.sessionName,
      title: attachment.title,
      reason,
      at: Date.now(),
    });
    attachments.delete(attachment.target);
    startedTargets.delete(attachment.target);
    if (activeTarget !== attachment.target) {
      updateStatus(ctx);
      return;
    }
    const next = nextAttachment();
    if (next) showAttachment(ctx, next, { announceDisplaced: false });
    else clearVisible(ctx);
  }

  /**
   * Close a tracked terminal. `kill` undefined means the ownership default: kill sessions this
   * extension started, detach from ones it attached to. `force` skips the kill confirmation.
   */
  async function closeLiveTerminal(
    ctx: ExtensionContext,
    kill: boolean | undefined,
    options: { force?: boolean; target?: string } = {},
  ): Promise<CloseResult> {
    const notify = (message: string, type: "info" | "warning") => {
      if (ctx.hasUI) ctx.ui.notify(message, type);
    };
    const attachment = await resolveAttachment(options.target);
    if (!attachment) {
      const message = options.target ? `No tracked live terminal matches ${options.target}.` : "No live terminal is attached.";
      notify(message, "info");
      return { message, killed: false, action: "none" };
    }

    const name = attachmentName(attachment);
    const ids = { sessionName: attachment.sessionName, target: attachment.target };
    let action = decideCloseAction(attachment, { kill: kill ?? !attachment.attachedExisting, force: options.force });
    if (action === "confirm-kill") {
      if (!ctx.hasUI) {
        action = "detach";
      } else if (await ctx.ui.confirm(`Kill tmux session ${name}?`, "This closes every pane in that session.")) {
        action = "kill";
      } else {
        const message = `Kept tmux session ${name} running.`;
        notify(message, "info");
        return { message, killed: false, action: "cancelled", ...ids };
      }
    }

    if (action === "kill") {
      // Mark the exit as reported first so the dying pane does not race a bogus exit notification.
      const alreadyReported = reportedExitTargets.has(attachment.target);
      reportedExitTargets.add(attachment.target);
      try {
        await killAttachmentSession(attachment);
      } catch (error) {
        if (!(await tmuxTargetExists(attachment.target))) {
          untrack(ctx, attachment, "detach", "tmux target missing");
          const message = `Closed live terminal; session ${name} had already ended.`;
          notify(message, "info");
          return { message, killed: false, action: "detach", ...ids };
        }
        if (!alreadyReported) reportedExitTargets.delete(attachment.target);
        const message = `Could not kill session ${name}: ${errorMessage(error)}. The live terminal is still tracked; retry with cmd+option+x or /live-terminal:close --kill.`;
        notify(message, "warning");
        return { message, killed: false, action: "kill", ...ids };
      }
      const affected = attachment.sessionName
        ? [...attachments.values()].filter((candidate) => candidate.sessionName === attachment.sessionName)
        : [attachment];
      for (const candidate of affected) {
        reportedExitTargets.add(candidate.target);
        untrack(ctx, candidate, "kill");
      }
      const message = `Closed live terminal and killed session ${name}`;
      notify(message, "info");
      return { message, killed: true, action: "kill", ...ids };
    }

    untrack(ctx, attachment, "detach");
    const hint = `reattach with: tmux attach -t ${attachment.sessionName || attachment.target}`;
    const message = attachment.state === "completed"
      ? `Closed live terminal widget for completed session ${name} — ${hint}`
      : `Detached from ${name} — ${hint}`;
    notify(message, "info");
    return { message, killed: false, action: "detach", ...ids };
  }

  async function openFocusModal(ctx: ExtensionContext) {
    const attachment = activeAttachment();
    if (!attachment) {
      ctx.ui.notify("No live terminal is attached. Start one with live_terminal_run or /live-terminal:attach first.", "warning");
      return;
    }
    if (focusModalOpen) return;

    focusModalOpen = true;
    try {
      await ctx.ui.custom<void>(
        (tui: TUI, theme: Theme, _keybindings, done) =>
          new TmuxFocusModal(
            tui,
            theme,
            attachment,
            () => done(),
            (status) => reportProcessExit(ctx, attachment, status),
          ),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: "100%",
            maxHeight: "100%",
            margin: 0,
          },
        },
      );
    } finally {
      disableMouseReporting();
      focusModalOpen = false;
      activeWidget?.invalidateSize();
    }
  }

  async function pickAttachment(ctx: ExtensionContext) {
    if (!ctx.hasUI) return;
    const recentFirst = [...attachments.values()].reverse();
    if (recentFirst.length === 0) {
      ctx.ui.notify("No live terminals are tracked. Start one with live_terminal_run or /live-terminal:run.", "info");
      return;
    }
    if (recentFirst.length === 1) {
      if (activeTarget !== recentFirst[0].target) showAttachment(ctx, recentFirst[0], { announceDisplaced: false });
      await openFocusModal(ctx);
      return;
    }

    const labels = recentFirst.map((attachment, index) => {
      const visible = attachment.target === activeTarget ? " (visible)" : "";
      const detail = attachment.command ? compactText(attachment.command, 40) : "attached session";
      return `${index + 1}. ${statusBadge(attachment)} ${attachmentName(attachment)}${visible} — ${detail}`;
    });
    const choice = await ctx.ui.select("Live terminals", labels);
    if (choice === undefined) return;
    const picked = recentFirst[labels.indexOf(choice)];
    if (!picked) return;
    if (widgetCollapsed) widgetCollapsed = false;
    showAttachment(ctx, picked, { announceDisplaced: false });
  }

  function toggleCollapsed(ctx: ExtensionContext) {
    if (!activeAttachment()) {
      ctx.ui.notify("No live terminal is attached.", "info");
      return;
    }
    widgetCollapsed = !widgetCollapsed;
    activeWidget?.invalidateSize();
  }

  async function probeTmux(): Promise<boolean> {
    try {
      await tmux(["-V"]);
      return true;
    } catch {
      return false;
    }
  }

  function trackedCompletions(prefix: string): AutocompleteItem[] {
    return [...attachments.values()]
      .map((attachment) => attachmentName(attachment))
      .filter((name) => name.startsWith(prefix))
      .map((name) => ({ value: name, label: name }));
  }

  pi.registerShortcut(Key.superAlt("x"), {
    description: "Kill the visible live terminal's tmux session (asks first for sessions Pi did not start)",
    handler: async (ctx) => {
      await closeLiveTerminal(ctx, true);
    },
  });

  pi.registerShortcut(Key.superAlt("v"), {
    description: "Detach the visible live terminal without killing its session, or close it after completion",
    handler: async (ctx) => {
      await closeLiveTerminal(ctx, false);
    },
  });

  pi.registerShortcut(Key.superAlt("f"), {
    description: "Focus the live terminal in a large interactive modal",
    handler: (ctx) => openFocusModal(ctx),
  });

  pi.registerShortcut(Key.superAlt("s"), {
    description: "Switch between tracked live terminals",
    handler: (ctx) => pickAttachment(ctx),
  });

  pi.registerShortcut(Key.superAlt("m"), {
    description: "Collapse or expand the live terminal widget",
    handler: (ctx) => toggleCollapsed(ctx),
  });

  pi.registerShortcut(Key.superAlt("pageUp"), {
    description: "Scroll the live terminal widget up",
    handler: () => activeWidget?.scrollPage(-1),
  });

  pi.registerShortcut(Key.superAlt("pageDown"), {
    description: "Scroll the live terminal widget down",
    handler: () => activeWidget?.scrollPage(1),
  });

  pi.registerShortcut(Key.superAlt("end"), {
    description: "Jump the live terminal widget to the latest output and follow it",
    handler: () => activeWidget?.scrollToBottom(),
  });

  pi.registerEntryRenderer<LiveTerminalEntryData>(ENTRY_TYPE, (entry, options, theme) => {
    const data = entry.data;
    if (!data) return undefined;
    const summary = entrySummary(data);
    if (!summary) return undefined;
    const lines = [theme.fg(summary.color, summary.text)];
    if (options.expanded) {
      const fields: [string, string | undefined][] = [
        ["command", data.command],
        ["cwd", data.cwd],
        ["target", data.target],
        ["session", data.sessionName],
      ];
      for (const [label, value] of fields) {
        if (value) lines.push(theme.fg("dim", `  ${label}: ${value}`));
      }
    }
    return new Text(lines.join("\n"), 1, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    stopExitMonitor();
    exitMonitorCtx = undefined;
    attachments.clear();
    activeTarget = undefined;
    startedTargets.clear();
    reportedExitTargets.clear();
    widgetHeightOverride = undefined;
    widgetCollapsed = false;

    if (!(await probeTmux())) {
      if (ctx.hasUI && !tmuxWarningShown) {
        tmuxWarningShown = true;
        ctx.ui.notify("tmux was not found on PATH; live terminal features are unavailable.", "warning");
      }
      return;
    }

    const restored = new Map<string, LiveTerminalAttachment>();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
      const data = (entry.data ?? {}) as LiveTerminalEntryData;
      const target = optionalString(data.target) || optionalString(data.paneId) || optionalString(data.sessionName);
      if (data.action === "open" && target) {
        const attachedExisting = data.attachedExisting === true;
        restored.delete(target);
        restored.set(target, {
          target,
          sessionName: optionalString(data.sessionName),
          title: optionalString(data.title) ?? DEFAULT_TITLE,
          command: optionalString(data.command),
          cwd: optionalString(data.cwd),
          state: data.state === "completed" ? "completed" : "running",
          attachedExisting,
          startedAt: attachedExisting ? undefined : optionalNumber(data.startedAt) ?? optionalNumber(data.at),
        });
      } else if (data.action === "exit" && target) {
        reportedExitTargets.add(target);
        const attachment = restored.get(target);
        if (attachment) {
          attachment.state = "completed";
          attachment.status = optionalString(data.status);
        }
      } else if (data.action === "detach" || data.action === "kill" || data.action === "close") {
        if (target) restored.delete(target);
        else restored.clear();
      }
    }

    const survivors: LiveTerminalAttachment[] = [];
    for (const attachment of restored.values()) {
      if (await tmuxTargetExists(attachment.target)) {
        const currentSession = (await tmux(["display-message", "-p", "-t", attachment.target, "#{session_name}"]).catch(() => "")).trim() || undefined;
        if (attachment.sessionName && currentSession !== attachment.sessionName) {
          pi.appendEntry<LiveTerminalEntryData>(ENTRY_TYPE, {
            action: "detach",
            target: attachment.target,
            sessionName: attachment.sessionName,
            title: attachment.title,
            reason: "tmux target identity changed",
            at: Date.now(),
          });
          continue;
        }
        attachment.sessionName ||= currentSession;
        survivors.push(attachment);
        if (!attachment.attachedExisting) startedTargets.add(attachment.target);
      } else {
        pi.appendEntry<LiveTerminalEntryData>(ENTRY_TYPE, {
          action: "detach",
          target: attachment.target,
          sessionName: attachment.sessionName,
          title: attachment.title,
          reason: "tmux target missing",
          at: Date.now(),
        });
      }
    }

    if (survivors.length === 0) {
      clearVisible(ctx);
      return;
    }
    for (const attachment of survivors) trackAttachment(attachment);
    const visible = nextAttachment();
    if (!visible) return;
    showAttachment(ctx, visible, { announceDisplaced: false });
    if (ctx.hasUI) {
      ctx.ui.notify(
        survivors.length === 1
          ? `Reattached live terminal to session ${attachmentName(visible)}`
          : `Reattached live terminal to session ${attachmentName(visible)}; ${survivors.length - 1} more tracked — cmd+option+s to switch`,
        "info",
      );
    }
  });

  pi.on("session_shutdown", async () => {
    stopExitMonitor();
    exitMonitorCtx = undefined;
    await Promise.all([...paneStreams.keys()].map((target) => closePaneStream(target).catch(() => {})));
  });

  pi.registerCommand("live-terminal:focus", {
    description: "Focus the visible live terminal in a large interactive modal",
    handler: async (_args, ctx) => {
      await openFocusModal(ctx);
    },
  });

  pi.registerCommand("live-terminal:list", {
    description: "List tracked live terminals and switch the visible one",
    handler: async (_args, ctx) => {
      await pickAttachment(ctx);
    },
  });

  pi.registerCommand("live-terminal:toggle", {
    description: "Collapse or expand the live terminal widget",
    handler: async (_args, ctx) => {
      toggleCollapsed(ctx);
    },
  });

  pi.registerCommand("live-terminal:height", {
    description: "Set the live terminal widget height in rows for this session, or 'auto' to reset",
    handler: async (args, ctx) => {
      const value = args.trim();
      if (!value || value === "auto") {
        widgetHeightOverride = undefined;
        ctx.ui.notify(`Live terminal height reset to auto (${VISIBLE_LINES} rows, at most 40% of the terminal).`, "info");
      } else {
        const rows = Number(value);
        if (!Number.isInteger(rows) || rows < 1) {
          ctx.ui.notify("Usage: /live-terminal:height <rows|auto>", "warning");
          return;
        }
        widgetHeightOverride = rows;
        ctx.ui.notify(`Live terminal height set to ${rows} rows (clamped to ${MIN_WIDGET_LINES} and 40% of the terminal).`, "info");
      }
      activeWidget?.invalidateSize();
    },
  });

  pi.registerCommand("live-terminal:run", {
    description: "Start a command in a live terminal and attach the widget",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (!command) {
        ctx.ui.notify("Usage: /live-terminal:run <shell-command>", "warning");
        return;
      }

      try {
        const result = await startLiveTerminal(ctx, command);
        pi.sendMessage({
          customType: MESSAGE_TYPE,
          content: `User started live terminal: session=${result.sessionName} command=${JSON.stringify(compactText(command, 300))}`,
          display: false,
          details: {
            startedBy: "user",
            sessionName: result.sessionName,
            title: result.title,
            cwd: result.cwd,
            command: compactText(command, 300),
          },
        }, { deliverAs: "nextTurn" });
        ctx.ui.notify(startedMessage(result.sessionName || result.target), "info");
      } catch (error) {
        ctx.ui.notify(`Could not start live terminal: ${errorMessage(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("live-terminal:close", {
    description: "Close the live terminal: /live-terminal:close [--kill] [session]. Without --kill the tmux session keeps running",
    getArgumentCompletions: (prefix) => {
      const items: AutocompleteItem[] = [
        { value: "--kill", label: "--kill", description: "Kill the tmux session instead of detaching" },
        { value: "kill", label: "kill", description: "Alias of --kill" },
        ...trackedCompletions(prefix),
      ];
      const matches = items.filter((item) => item.value.startsWith(prefix.trim()));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const shouldKill = tokens.some((token) => token === "--kill" || token === "kill");
      const target = tokens.find((token) => token !== "--kill" && token !== "kill");
      await closeLiveTerminal(ctx, shouldKill, { target });
    },
  });

  pi.registerCommand("live-terminal:detach", {
    description: "Detach from the live terminal and leave its tmux session running: /live-terminal:detach [session]",
    getArgumentCompletions: (prefix) => {
      const matches = trackedCompletions(prefix.trim());
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      await closeLiveTerminal(ctx, false, { target: args.trim() || undefined });
    },
  });

  pi.registerCommand("live-terminal:attach", {
    description: "Attach to an existing tmux target, e.g. my-session or my-session:0.0; with no argument, pick from running panes",
    getArgumentCompletions: async (prefix) => {
      if (/\s/.test(prefix)) return null;
      const sessions = await listTmuxSessions();
      const matches = sessions
        .filter((session) => session.startsWith(prefix))
        .map((session) => ({ value: session, label: session }));
      return matches.length > 0 ? matches : null;
    },
    handler: async (args, ctx) => {
      let [target, ...titleParts] = args.trim().split(/\s+/).filter(Boolean);
      let title = titleParts.join(" ");
      if (!target) {
        let panes: Awaited<ReturnType<typeof listTmuxPanes>>;
        try {
          panes = await listTmuxPanes();
        } catch (error) {
          ctx.ui.notify(isTmuxMissing(error) ? "tmux is not installed or not on PATH." : "No tmux sessions are running.", "warning");
          return;
        }
        if (panes.length === 0) {
          ctx.ui.notify("No tmux sessions are running.", "warning");
          return;
        }
        const labels = panes.map((pane) =>
          `${pane.target} — ${pane.command || "?"}${attachments.has(pane.paneId) ? " (tracked)" : ""}`
        );
        const choice = await ctx.ui.select("Attach to tmux pane", labels);
        if (choice === undefined) return;
        const picked = panes[labels.indexOf(choice)];
        if (!picked) return;
        target = picked.target;
        title ||= picked.sessionName;
      }

      try {
        const result = await attachLiveTerminal(ctx, target, { title: title || target });
        ctx.ui.notify(attachedMessage(result.sessionName, result.target), "info");
      } catch (error) {
        ctx.ui.notify(`Could not attach to tmux target ${target}: ${errorMessage(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("live-terminal:copy", {
    description: "Copy recent output of the visible live terminal to the clipboard: /live-terminal:copy [lines]",
    handler: async (args, ctx) => {
      const attachment = activeAttachment();
      if (!attachment) {
        ctx.ui.notify("No live terminal is attached.", "info");
        return;
      }
      const requested = args.trim() ? Number(args.trim()) : CAPTURE_LINES;
      if (!Number.isInteger(requested) || requested < 1) {
        ctx.ui.notify("Usage: /live-terminal:copy [lines]", "warning");
        return;
      }
      try {
        const result = await copyPaneToClipboard(attachment.target, Math.min(requested, MAX_READ_LINES));
        ctx.ui.notify(`Copied ${result.lines} lines from ${attachmentName(attachment)} via ${result.method}`, "info");
      } catch (error) {
        ctx.ui.notify(`Could not copy terminal output: ${errorMessage(error)}`, "warning");
      }
    },
  });

  pi.registerCommand("live-terminal:send", {
    description: "Type text into the visible live terminal and press Enter; --raw sends the text without Enter",
    handler: async (args, ctx) => {
      const raw = /^\s*--raw(?:\s|$)/.test(args);
      const text = raw ? args.replace(/^\s*--raw\s?/, "") : args.trim();
      const attachment = activeAttachment();
      if (!attachment) {
        ctx.ui.notify("No live terminal is attached.", "info");
        return;
      }
      if (!text && raw) {
        ctx.ui.notify("Usage: /live-terminal:send [--raw] <text>", "warning");
        return;
      }
      try {
        if (text) await sendTmuxLiteral(attachment.target, text);
        if (!raw) await tmux(["send-keys", "-t", attachment.target, "Enter"]);
      } catch (error) {
        ctx.ui.notify(`Could not send input to ${attachmentName(attachment)}: ${errorMessage(error)}`, "warning");
      }
    },
  });

  const runParameters = Type.Object({
    command: Type.Optional(
      Type.String({
        description: "Shell command to run in a new tmux session. If omitted, live_terminal_run attaches to session_name or target instead.",
      }),
    ),
    session_name: Type.Optional(
      Type.String({
        description:
          "Optional tmux session name. With command, names the new session and defaults to pi-live-<random>; it must not already exist. Without command, names the existing session to attach to.",
      }),
    ),
    target: Type.Optional(
      Type.String({
        description: "Existing tmux target to attach to when command is omitted, e.g. my-session or my-session:0.0.",
      }),
    ),
    title: Type.Optional(
      Type.String({
        description: "Short title to show in the widget border. Defaults to 'tmux'.",
      }),
    ),
    cwd: Type.Optional(
      Type.String({
        description: "Working directory. Defaults to the current Pi cwd.",
      }),
    ),
    wait_for: Type.Optional(
      Type.Object({
        regex: Type.Optional(
          Type.String({
            description: "JavaScript regular expression source to match against captured tmux pane output.",
          }),
        ),
        event: Type.Optional(
          Type.Union([
            Type.Literal("exit"),
            Type.Literal("target_closed"),
          ], {
            description: "Event to wait for. 'exit' waits for commands started by live_terminal_run to record an exit status (attached sessions fail immediately); 'target_closed' waits until the tmux target disappears.",
          }),
        ),
        ignore_case: Type.Optional(
          Type.Boolean({
            description: "Compile wait_for.regex case-insensitively.",
          }),
        ),
        timeout_ms: Type.Optional(
          Type.Number({
            description: "Maximum time to wait in milliseconds. Defaults to 30000.",
          }),
        ),
        poll_ms: Type.Optional(
          Type.Number({
            description: "Maximum polling period in milliseconds. Defaults to 500; regex waits also wake on new output.",
          }),
        ),
      }),
    ),
  });

  pi.registerTool<typeof runParameters, RunToolDetails>({
    name: "live_terminal_run",
    label: "Run Live Terminal",
    description:
      "Start a command in a detached tmux session, or attach to an existing tmux target when no command is provided. Can optionally wait for regex output or lifecycle events.",
    promptSnippet:
      "live_terminal_run: run a command in a detached tmux session or attach to an existing session, with a live Tmux widget visible to the user.",
    promptGuidelines: [
      "For interactive, TTY, full-screen, watch-mode, development-server, or long-running flows, use live_terminal_run instead of bash so the user can see and interact with the running process.",
      "Omit command and pass session_name or target to attach to an existing tmux session instead of starting a new command.",
      "Pass wait_for.regex to wait until captured terminal output matches a JavaScript regular expression, or wait_for.event='exit'/'target_closed' to wait for an event. Defaults: timeout_ms=30000, poll_ms=500. wait_for.event='exit' only works for commands started by live_terminal_run.",
      "For long-running workflows, prefer starting the live terminal first, doing other useful work, then calling live_terminal_run again without command and with session_name/target plus wait_for when you need to wait for the next terminal state. A timed-out wait leaves the terminal running and includes its recent output.",
      "When a command started by live_terminal_run exits, a live-terminal-status message reports its exit status on the next turn.",
      "Use live_terminal_send to answer prompts or send keys (e.g. text 'y' with keys ['enter'], or keys ['ctrl+c']), and live_terminal_read to inspect recent output.",
      "When the session is no longer needed, use live_terminal_close. It kills sessions started by live_terminal_run but only detaches from pre-existing tmux sessions unless kill: true is passed.",
    ],
    parameters: runParameters,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const command = typeof params.command === "string" ? params.command.trim() : "";
      let result: LiveTerminalAttachment;
      let visibleMessage: string;

      if (command) {
        if (params.target) throw new Error("target can only be used when command is omitted.");
        result = await startLiveTerminal(
          ctx,
          command,
          { sessionName: params.session_name, title: params.title || params.session_name || DEFAULT_TITLE, cwd: params.cwd },
        );
        visibleMessage = startedMessage(result.sessionName || result.target);
      } else {
        const attachTarget = params.target || params.session_name;
        if (!attachTarget) throw new Error("live_terminal_run requires command, or session_name/target to attach to an existing tmux session.");
        result = await attachLiveTerminal(ctx, attachTarget, { title: params.title || params.session_name || params.target });
        visibleMessage = attachedMessage(result.sessionName, result.target);
      }

      const ids = { sessionName: result.sessionName, target: result.target, command: result.command, cwd: result.cwd };
      let waitResult: WaitResult | undefined;
      if (params.wait_for) {
        const condition = waitForRenderSummary(params.wait_for) ?? "wait_for";
        waitResult = await waitForTerminal(result.target, params.wait_for, {
          signal,
          onTick: onUpdate
            ? (elapsedMs, lastLine) => onUpdate({
                content: [{ type: "text", text: waitProgressText(condition, elapsedMs, lastLine) }],
                details: { ...ids, visibleMessage, progress: { condition, elapsedMs, lastLine } },
              })
            : undefined,
        });
        visibleMessage = `${visibleMessage} ${waitResultMessage(waitResult)}`;
      }

      return {
        content: [
          {
            type: "text",
            text: visibleMessage,
          },
        ],
        details: { ...ids, waitResult, visibleMessage },
      };
    },
    renderCall(args, theme) {
      const toolArgs = args as { command?: unknown; session_name?: unknown; target?: unknown; wait_for?: unknown };
      const command = typeof toolArgs.command === "string" ? toolArgs.command : "";
      const attachTarget = typeof toolArgs.target === "string"
        ? toolArgs.target
        : typeof toolArgs.session_name === "string"
          ? toolArgs.session_name
          : "";
      const summary = command ? command : `attach ${attachTarget}`;
      const waitSummary = waitForRenderSummary(toolArgs.wait_for);
      const waitText = waitSummary ? ` wait=${JSON.stringify(compactText(waitSummary, 80))}` : "";
      const content = theme.fg("toolTitle", "live_terminal_run ") + theme.fg("dim", `${compactText(summary, 120)}${waitText}`);
      return new Text(content, 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as RunToolDetails | undefined;
      if (options.isPartial && details?.progress) {
        const { condition, elapsedMs, lastLine } = details.progress;
        return new Text(theme.fg("dim", waitProgressText(condition, elapsedMs, lastLine)), 0, 0);
      }

      let message = typeof details?.visibleMessage === "string"
        ? details.visibleMessage
        : typeof details?.sessionName === "string"
          ? startedMessage(details.sessionName)
          : "Opened live terminal.";
      const recentIndex = message.indexOf("\n\nRecent output:");
      if (!options.expanded && recentIndex !== -1) {
        message = `${message.slice(0, recentIndex)}\n${theme.fg("dim", "(expand to see recent output)")}`;
      }
      const color = details?.waitResult?.timedOut ? "warning" : "success";
      return new Text(theme.fg(color, message), 0, 0);
    },
  });

  const sendParameters = Type.Object({
    text: Type.Optional(
      Type.String({
        description: "Literal text to type into the terminal. Does not press Enter; add keys: ['enter'] for that.",
      }),
    ),
    keys: Type.Optional(
      Type.Array(Type.String(), {
        description: "Keys to press after text, in order, e.g. ['enter'], ['ctrl+c'], ['escape', ':q', 'enter'], ['pageDown']. Unrecognized names are passed to tmux send-keys as-is.",
      }),
    ),
    target: Type.Optional(Type.String({ description: "tmux target. Defaults to the visible live terminal." })),
    session_name: Type.Optional(Type.String({ description: "tmux session name. Defaults to the visible live terminal." })),
  });

  pi.registerTool({
    name: "live_terminal_send",
    label: "Send to Live Terminal",
    description: "Type text and/or press keys in a live terminal (tmux pane), e.g. to answer a prompt, interrupt with ctrl+c, or quit a pager.",
    promptSnippet: "live_terminal_send: type text or press keys in a live terminal.",
    promptGuidelines: [
      "Use live_terminal_send to answer interactive prompts in a live terminal, e.g. text 'y' with keys ['enter'] for a y/N prompt.",
      "Interrupt a running command with keys ['ctrl+c']; quit pagers or full-screen programs with their own keys, e.g. keys ['q'].",
      "After sending, use live_terminal_read or live_terminal_run with wait_for to observe the result.",
    ],
    parameters: sendParameters,
    async execute(_toolCallId, params) {
      const text = params.text ?? "";
      const keys = params.keys ?? [];
      if (!text && keys.length === 0) throw new Error("live_terminal_send requires text or keys.");
      const resolved = await resolveToolTarget(params.target || params.session_name);
      if (text) await sendTmuxInput(resolved.target, text);
      const tmuxKeys = keys.map((key) => {
        const trimmed = key.trim();
        return toTmuxKey(trimmed) ?? toTmuxKey(normalizeSendKeyName(trimmed)) ?? trimmed;
      });
      for (const key of tmuxKeys) await tmux(["send-keys", "-t", resolved.target, key]);

      const parts = [
        text ? `text ${JSON.stringify(compactText(text, 80))}` : "",
        tmuxKeys.length ? `keys ${tmuxKeys.join(" ")}` : "",
      ].filter(Boolean);
      const message = `Sent ${parts.join(" and ")} to ${resolved.name}.`;
      return {
        content: [{ type: "text", text: message }],
        details: { message, target: resolved.target, sessionName: resolved.sessionName },
      };
    },
    renderCall(args, theme) {
      const toolArgs = args as { text?: unknown; keys?: unknown };
      const text = typeof toolArgs.text === "string" ? JSON.stringify(compactText(toolArgs.text, 60)) : "";
      const keys = Array.isArray(toolArgs.keys) ? toolArgs.keys.filter((key) => typeof key === "string").join(" ") : "";
      return new Text(theme.fg("toolTitle", "live_terminal_send ") + theme.fg("dim", [text, keys].filter(Boolean).join(" + ")), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as { message?: unknown } | undefined;
      const message = typeof details?.message === "string" ? details.message : "Sent input.";
      return new Text(theme.fg("success", message), 0, 0);
    },
  });

  const readParameters = Type.Object({
    lines: Type.Optional(
      Type.Number({ description: `Number of trailing lines to return. Defaults to ${DEFAULT_READ_LINES}, max ${MAX_READ_LINES}.` }),
    ),
    target: Type.Optional(Type.String({ description: "tmux target. Defaults to the visible live terminal." })),
    session_name: Type.Optional(Type.String({ description: "tmux session name. Defaults to the visible live terminal." })),
  });

  pi.registerTool<typeof readParameters, ReadToolDetails>({
    name: "live_terminal_read",
    label: "Read Live Terminal",
    description: "Read recent output from a live terminal (tmux pane) along with its run state and exit status.",
    promptSnippet: "live_terminal_read: read recent output and exit status from a live terminal.",
    promptGuidelines: [
      "Use live_terminal_read to check what a live terminal is showing, e.g. after live_terminal_send or when a wait timed out.",
    ],
    parameters: readParameters,
    async execute(_toolCallId, params) {
      const count = Math.min(MAX_READ_LINES, Math.max(1, Math.floor(params.lines ?? DEFAULT_READ_LINES)));
      const resolved = await resolveToolTarget(params.target || params.session_name);
      const captured = lastLines(await capturePaneText(resolved.target, count), count);
      const exitStatus = await getExitStatus(resolved.target);
      const state: PaneState = exitStatus !== undefined
        ? "completed"
        : startedTargets.has(resolved.target)
          ? "running"
          : "unknown";
      const stateText = exitStatus !== undefined ? `exited with status ${exitStatus}` : state;
      const header = `${resolved.name} · ${stateText} · last ${captured.lineCount} lines${captured.truncated ? " (older output truncated)" : ""}`;
      return {
        content: [{ type: "text", text: `${header}\n\n${captured.text || "(no output)"}` }],
        details: {
          target: resolved.target,
          sessionName: resolved.sessionName,
          state,
          exitStatus,
          lines: captured.lineCount,
          truncated: captured.truncated,
          header,
        },
      };
    },
    renderCall(args, theme) {
      const toolArgs = args as { lines?: unknown; target?: unknown; session_name?: unknown };
      const target = typeof toolArgs.target === "string"
        ? toolArgs.target
        : typeof toolArgs.session_name === "string"
          ? toolArgs.session_name
          : "";
      const lines = typeof toolArgs.lines === "number" ? `${toolArgs.lines} lines` : "";
      return new Text(theme.fg("toolTitle", "live_terminal_read ") + theme.fg("dim", [target, lines].filter(Boolean).join(" ")), 0, 0);
    },
    renderResult(result, options, theme) {
      const details = result.details as ReadToolDetails | undefined;
      const header = details?.header ?? "Read live terminal.";
      if (!options.expanded) return new Text(theme.fg("success", header), 0, 0);
      const first = result.content[0];
      const body = first && first.type === "text" ? first.text : header;
      return new Text(theme.fg("dim", body), 0, 0);
    },
  });

  const closeParameters = Type.Object({
    kill: Type.Optional(
      Type.Boolean({
        description: "Kill the tmux session. Defaults to true for sessions started by live_terminal_run and false for pre-existing sessions that were attached.",
      }),
    ),
    target: Type.Optional(Type.String({ description: "tmux target to close. Defaults to the visible live terminal." })),
    session_name: Type.Optional(Type.String({ description: "tmux session name to close. Defaults to the visible live terminal." })),
  });

  pi.registerTool<typeof closeParameters, CloseResult, { name?: string }>({
    name: "live_terminal_close",
    label: "Close Live Terminal",
    description:
      "Close a live terminal. Kills sessions started by live_terminal_run; detaches from pre-existing tmux sessions unless kill is true.",
    promptSnippet:
      "live_terminal_close: close a live terminal, killing sessions Pi started and detaching from pre-existing ones.",
    promptGuidelines: [
      "Use live_terminal_close when a live terminal session started with live_terminal_run is no longer needed.",
      "Detaching leaves externally-owned sessions running; pass kill: true only when destroying that session was requested.",
    ],
    parameters: closeParameters,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const result = await closeLiveTerminal(ctx, params.kill, { force: true, target: params.target || params.session_name });
      return {
        content: [
          {
            type: "text",
            text: result.message,
          },
        ],
        details: result,
      };
    },
    renderCall(args, theme, context) {
      const toolArgs = args as { kill?: unknown; target?: unknown; session_name?: unknown };
      const state = context.state;
      if (state && state.name === undefined) {
        const explicit = typeof toolArgs.target === "string"
          ? toolArgs.target
          : typeof toolArgs.session_name === "string"
            ? toolArgs.session_name
            : undefined;
        const attachment = activeAttachment();
        state.name = explicit ?? (attachment ? attachmentName(attachment) : "");
      }
      const name = state?.name ?? "";
      const kill = toolArgs.kill === true ? " kill" : toolArgs.kill === false ? " detach" : "";
      return new Text(theme.fg("toolTitle", "live_terminal_close") + theme.fg("dim", `${name ? ` ${name}` : ""}${kill}`), 0, 0);
    },
    renderResult(result, _options, theme) {
      const details = result.details as CloseResult | undefined;
      const message = typeof details?.message === "string" ? details.message : "Closed live terminal.";
      const color = details?.action === "kill" && !details.killed ? "warning" : details?.action === "none" ? "warning" : "success";
      return new Text(theme.fg(color, message), 0, 0);
    },
  });
}

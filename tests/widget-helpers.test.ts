import assert from "node:assert/strict";
import { test } from "node:test";
import {
  clampWidgetHeight,
  decideCloseAction,
  formatElapsed,
  scrollIndicatorText,
  toTmuxKey,
} from "../pi-live-terminal.ts";

test("formatElapsed formats second, minute, and hour boundaries", () => {
  const now = 10_000_000;
  const cases = [
    { elapsedMs: 12_000, expected: "12s" },
    { elapsedMs: 59_000, expected: "59s" },
    { elapsedMs: 60_000, expected: "1m00s" },
    { elapsedMs: 133_000, expected: "2m13s" },
    { elapsedMs: 3_599_000, expected: "59m59s" },
    { elapsedMs: 3_600_000, expected: "1h00m" },
    { elapsedMs: 3_840_000, expected: "1h04m" },
  ];

  for (const { elapsedMs, expected } of cases) {
    assert.equal(formatElapsed(now - elapsedMs, now), expected);
  }
});

test("clampWidgetHeight respects terminal space, defaults, and overrides", () => {
  assert.equal(clampWidgetHeight(200), 16);
  assert.equal(clampWidgetHeight(20), 8);
  assert.equal(clampWidgetHeight(12), 6);
  assert.equal(clampWidgetHeight(200, 8), 8);
  assert.equal(clampWidgetHeight(50, 40), 20);
  assert.equal(clampWidgetHeight(100, 2), 6);
});

test("scrollIndicatorText distinguishes unscrollable, live, and scrolled output", () => {
  assert.equal(scrollIndicatorText(0, 10, 16), "");
  assert.equal(scrollIndicatorText(24, 40, 16), "LIVE");
  assert.equal(scrollIndicatorText(5, 40, 16), "↑ 19 lines");
});

test("decideCloseAction covers ownership, kill intent, and force", () => {
  const started = { target: "%1", title: "started" };
  const attached = { target: "%2", title: "attached", attachedExisting: true };
  const cases = [
    { attachment: started, kill: false, force: false, expected: "detach" },
    { attachment: started, kill: false, force: true, expected: "detach" },
    { attachment: started, kill: true, force: false, expected: "kill" },
    { attachment: started, kill: true, force: true, expected: "kill" },
    { attachment: attached, kill: false, force: false, expected: "detach" },
    { attachment: attached, kill: false, force: true, expected: "detach" },
    { attachment: attached, kill: true, force: false, expected: "confirm-kill" },
    { attachment: attached, kill: true, force: true, expected: "kill" },
  ] as const;

  for (const { attachment, kill, force, expected } of cases) {
    assert.equal(
      decideCloseAction(attachment, { kill, force }),
      expected,
      `${attachment.title}: kill=${kill}, force=${force}`,
    );
  }
});

test("toTmuxKey normalizes keys used by live_terminal_send", () => {
  const cases = [
    ["enter", "Enter"],
    ["ctrl+c", "C-c"],
    ["pageUp", "PPage"],
    ["pageDown", "NPage"],
    ["shift+enter", "S-Enter"],
    ["ctrl+shift+c", "C-S-c"],
    ["f5", "F5"],
    ["c", undefined],
    ["Ctrl+C", undefined],
  ] as const;

  for (const [key, expected] of cases) {
    assert.equal(toTmuxKey(key), expected, key);
  }
});

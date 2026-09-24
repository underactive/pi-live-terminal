import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderFooterLine } from "../pi-live-terminal.ts";

const border = (s: string) => s;
const style = (s: string) => `\x1b[38;2;166;176;160m${s}\x1b[39m`;

const hintSets = [
  {
    name: "widget footer",
    hints: [
      style(" cmd+option+f ") + style("focus"),
      style(" cmd+option+x ") + style("kill"),
      style(" cmd+option+v ") + style("detach"),
      style(" cmd+option+s ") + style("switch (2)"),
      style(" cmd+option+m ") + style("collapse"),
    ].join(style(" · ")),
  },
  {
    name: "collapsed widget footer",
    hints: [
      style(" cmd+option+m ") + style("expand"),
      style(" cmd+option+f ") + style("focus"),
    ].join(style(" · ")),
  },
  {
    name: "focus modal footer with fallback exit chord",
    hints: [
      style(" cmd+option+f ") + style("or ") + style("ctrl+] ×2 ") + style("close focus"),
      style(" shift+↑↓/PgUp/PgDn ") + style("scroll"),
      style(" cmd+option+c ") + style("copy"),
      style("input is sent to tmux"),
    ].join(style(" · ")),
  },
  {
    name: "live scroll indicator footer",
    hints: [
      style(" LIVE "),
      style(" cmd+option+pageUp ") + style("scroll"),
    ].join(style(" · ")),
  },
  {
    name: "scrolled output indicator footer",
    hints: [
      style(" ↑ 128 lines "),
      style(" cmd+option+end ") + style("follow"),
      style(" cmd+option+pageDown ") + style("scroll"),
    ].join(style(" · ")),
  },
];

test("footer hints fill but do not exceed the render width", () => {
  for (const { name, hints } of hintSets) {
    for (const width of [54, 20, 5, 4, 3, 2, 1]) {
      const line = renderFooterLine(width, hints, border);

      assert.equal(
        visibleWidth(line),
        width,
        `${name} rendered ${visibleWidth(line)} columns into ${width}`,
      );
    }
  }
});

test("narrow footer keeps hints right-justified after a bottom border rule", () => {
  const line = renderFooterLine(54, hintSets[0].hints, border);

  assert.match(line, /^╰─/);
  assert.match(line, /─╯$/);
});

test("focus footer includes the fallback and prioritizes exit controls", () => {
  const focusHints = hintSets.find(({ name }) => name === "focus modal footer with fallback exit chord");
  assert.ok(focusHints);
  assert.match(focusHints.hints, /ctrl\+\]/);

  const line = renderFooterLine(20, focusHints.hints, border);
  assert.match(line, /cmd\+option\+f/);
});

test("footer keeps unpadded hints adjacent to the right rule", () => {
  const line = renderFooterLine(16, "shortcuts", border);

  assert.equal(visibleWidth(line), 16);
  assert.match(line, /^╰─+/);
  assert.match(line, /shortcuts─╯$/);
});

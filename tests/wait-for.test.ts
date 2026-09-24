import assert from "node:assert/strict";
import { test } from "node:test";
import { outputTail, parseWaitFor, waitForTerminal } from "../pi-live-terminal.ts";

async function timeoutWithOutput(output: string, advanceClock: () => void) {
  let unsubscribeCalls = 0;

  const result = await waitForTerminal(
    "%timeout-test",
    { regex: "will-not-match", timeout_ms: 10, poll_ms: 5 },
    {
      deps: {
        captureText: async () => {
          advanceClock();
          return output;
        },
        targetExists: async () => true,
        subscribe: async () => async () => {
          unsubscribeCalls++;
        },
      },
    },
  );

  return { result, unsubscribeCalls };
}

test("parseWaitFor requires exactly one condition", () => {
  assert.throws(
    () => parseWaitFor({}),
    /wait_for must include exactly one of regex or event/,
  );
  assert.throws(
    () => parseWaitFor({ regex: "", event: undefined }),
    /wait_for must include exactly one of regex or event/,
  );
  assert.throws(
    () => parseWaitFor({ regex: "ready", event: "exit" }),
    /wait_for must include exactly one of regex or event/,
  );
});

test("parseWaitFor validates events, regexes, and positive timing values", () => {
  assert.throws(
    () => parseWaitFor({ event: "finished" as never }),
    /wait_for\.event must be 'exit' or 'target_closed'/,
  );
  assert.throws(
    () => parseWaitFor({ regex: "(" }),
    /Invalid wait_for\.regex:/,
  );

  for (const timeout_ms of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => parseWaitFor({ regex: "ready", timeout_ms }),
      /wait_for\.timeout_ms must be a positive number/,
    );
  }
  for (const poll_ms of [0, -1, Number.POSITIVE_INFINITY, Number.NaN]) {
    assert.throws(
      () => parseWaitFor({ regex: "ready", poll_ms }),
      /wait_for\.poll_ms must be a positive number/,
    );
  }
});

test("parseWaitFor applies defaults and ignore-case regex flags", () => {
  const parsed = parseWaitFor({ regex: "ready", ignore_case: true });

  assert.equal(parsed.timeoutMs, 30_000);
  assert.equal(parsed.pollMs, 500);
  assert.equal(parsed.condition.kind, "regex");
  if (parsed.condition.kind === "regex") {
    assert.equal(parsed.condition.source, "ready");
    assert.match(parsed.condition.regex.flags, /i/);
    assert.match(parsed.condition.regex.flags, /m/);
  }
});

test("regex timeout sanitizes and keeps only the latest twenty output lines", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);

  const lines = Array.from({ length: 30 }, (_, index) => `line-${String(index + 1).padStart(2, "0")}`);
  const capturedLines = [...lines];
  capturedLines[29] += "\x1b]0;ignored title\x07";
  const { result, unsubscribeCalls } = await timeoutWithOutput(
    capturedLines.join("\n"),
    () => {
      now += 11;
    },
  );

  assert.equal(result.matched, false);
  assert.equal(result.timedOut, true);
  assert.equal(result.stillRunning, true);
  assert.deepEqual(result.recentOutput?.split("\n"), lines.slice(-20));
  assert.equal(unsubscribeCalls, 1);
});

test("outputTail caps recent output at 2 KiB without dropping the newest text", () => {
  const lines = Array.from(
    { length: 20 },
    (_, index) => `line-${String(index + 1).padStart(2, "0")}-${"é".repeat(180)}`,
  );
  lines.push("LAST-LINE");

  const recentOutput = outputTail(lines.join("\n"));

  assert.ok(Buffer.byteLength(recentOutput, "utf8") <= 2_048);
  assert.match(recentOutput, /LAST-LINE$/);
  assert.doesNotMatch(recentOutput, /line-01/);
});

test("exit waits reject targets not started by live_terminal_run", async () => {
  await assert.rejects(
    waitForTerminal(
      "%external-target-test",
      { event: "exit", timeout_ms: 10, poll_ms: 5 },
      {
        exitTracked: false,
        deps: {
          exitStatus: async () => undefined,
        },
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /exit/i);
      assert.match(error.message, /(started|attached|external|existing)/i);
      return true;
    },
  );
});

test("regex waits wake on pane output before the polling bound", { timeout: 1_000 }, async () => {
  const events: string[] = [];
  let output = "starting";
  let subscriber: ((chunk: string) => void) | undefined;
  let firstCaptureDone: (() => void) | undefined;
  const firstCapture = new Promise<void>((resolve) => {
    firstCaptureDone = resolve;
  });

  const resultPromise = waitForTerminal(
    "%stream-test",
    { regex: "ready", timeout_ms: 10_000, poll_ms: 5_000 },
    {
      deps: {
        captureText: async () => {
          events.push(`capture:${output}`);
          firstCaptureDone?.();
          return output;
        },
        targetExists: async () => true,
        subscribe: async (_target: string, onChunk: (chunk: string) => void) => {
          events.push("subscribe");
          subscriber = onChunk;
          return async () => {
            events.push("unsubscribe");
          };
        },
      },
    },
  );

  await firstCapture;
  assert.ok(subscriber, "wait subscribed to pane output");
  output = "service ready";
  events.push("emit");
  subscriber("service ready");

  const result = await resultPromise;
  assert.equal(result.matched, true);
  assert.equal(result.match, "service ready");

  const subscribeIndex = events.indexOf("subscribe");
  const firstCaptureIndex = events.indexOf("capture:starting");
  const emitIndex = events.indexOf("emit");
  const matchingCaptureIndex = events.indexOf("capture:service ready");
  const unsubscribeIndex = events.indexOf("unsubscribe");

  assert.ok(subscribeIndex >= 0 && subscribeIndex < firstCaptureIndex);
  assert.ok(firstCaptureIndex < emitIndex);
  assert.ok(emitIndex < matchingCaptureIndex);
  assert.ok(matchingCaptureIndex < unsubscribeIndex);
});

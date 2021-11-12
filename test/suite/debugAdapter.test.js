"use strict";

const assert = require("assert");
const vscode = require("vscode");
const { DebugClient } = require("vscode-debugadapter-testsupport");
const { DebugSession } = require("../../modules/debugSession");
const path = require("path");
const { buildTestFiles } = require("../../modules/utils");

const PROJECT_ROOT = path.normalize(path.join(__dirname, "..", ".."));
const TEST_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace", "test");
const MANDELBROT_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace", "thread");


setup(() => {
  return [buildTestFiles(TEST_PROJECT), buildTestFiles(MANDELBROT_PROJECT)];
});

suite("Extension Launch Test Suite", () => {
  let dc;
  let ds;

  let port = 44444;
  setup(() => {
    let myport = port++;
    ds = DebugSession.run(myport);

    dc = new DebugClient(
      "node",
      "we're running the adapter as a server and don't need an executable",
      "midas"
    );
    return dc.start(myport);
  });

  teardown(() => {
    dc.stop();
  });

  suite("initialize", () => {
    test("should return supported features", async () => {
      let response = await dc.initializeRequest();
      response.body = response.body || {};
      assert(response.body.supportsConfigurationDoneRequest, true);
    });
  });

  suite("launch", () => {
    test("should run program to the end", () => {
      const PROGRAM = path.join(TEST_PROJECT, "build", "testapp");

      return Promise.all([
        dc.configurationSequence(),
        dc.launch({ program: PROGRAM }),
        dc.waitForEvent("terminated"),
      ]);
    }).timeout("5s");

    test("should stop at entry", () => {
      const PROGRAM = path.join(TEST_PROJECT, "build", "testapp");

      return Promise.all([
        dc.configurationSequence(),
        dc.launch({ program: PROGRAM, stopOnEntry: true }),
        dc.waitForEvent("stopped").then((event) => {
          assert.strictEqual(
            event.body.reason,
            "entry",
            "should receive entry event"
          );
        }),
      ]);
    }).timeout("5s");
  });
});

suite("Multi-threaded testing suite", () => {
  const PROGRAM = path.join(MANDELBROT_PROJECT, "build", "testapp");
  const PORT = 44444;
  let dc;
  let ds;

  setup(async () => {
    ds = DebugSession.run(PORT);

    dc = new DebugClient(
      "node",
      "we're running the adapter as a server and don't need an executable",
      "midas"
    );

    await dc.start(PORT);
    return Promise.all([
      dc.configurationSequence(),
      dc.launch({ program: PROGRAM, stopOnEntry: true, trace: false, debuggeeArgs: ["additionalTellsProgramToRunAsTestSuite"] }),
      dc.waitForEvent("stopped"),
    ]);
  });

  teardown(() => {
    dc.stop();
  });

  test("should hit breakpoint NPCU-1 amount of times", async () => {
    const name = "main.cpp";
    const source = { path: path.join(MANDELBROT_PROJECT, "src", name), name };
    const line = 59;
    const threadId = 1;
    const NCPU = require("os").cpus().length;
    await dc.setBreakpointsRequest({ source, breakpoints: [{ line }] });
    let res = [];
    dc.assertStoppedLocation = (reason, expected) => {
      return dc.waitForEvent('stopped').then(event => {
        assert.equal(event.body.reason, reason);
        return dc.stackTraceRequest({
          threadId: event.body.threadId
        });
      }).then(response => {
        const frame = response.body.stackFrames[0];
        if (typeof expected.path === 'string' || expected.path instanceof RegExp) {
          dc.assertPath(frame.source.path, expected.path, 'stopped location: path mismatch');
        }
        if (typeof expected.line === 'number') {
          assert.equal(frame.line, expected.line, 'stopped location: line mismatch');
        }
        if (typeof expected.column === 'number') {
          assert.equal(frame.column, expected.column, 'stopped location: column mismatch');
        }
        return response;
      });
    };
    for(let i = 0; i < NCPU - 1; i++) {
      res.push(dc.continueRequest());
      res.push(dc.assertStoppedLocation("breakpoint", {path: source.path }));
    }

    return Promise.all(res);
  });
}).timeout("10s");

suite("Extension Breakpoints Test Suite", () => {
  const PROGRAM = path.join(TEST_PROJECT, "build", "testapp");
  const PORT = 44444;
  let dc;
  let ds;

  setup(async () => {
    ds = DebugSession.run(PORT);

    dc = new DebugClient(
      "node",
      "we're running the adapter as a server and don't need an executable",
      "midas"
    );

    await dc.start(PORT);
    return Promise.all([
      dc.configurationSequence(),
      dc.launch({ program: PROGRAM, stopOnEntry: true }),
      dc.waitForEvent("stopped"),
    ]);
  });

  teardown(() => {
    dc.stop();
  });

  suite("breakpoints with restart", () => {
    teardown(() => {
      return Promise.all([
        dc.restartRequest({ program: PROGRAM, stopOnEntry: true }),
        dc.waitForEvent("stopped"),
      ]);
    });

    test("should hit breakpoint", async () => {
      const name = "main.cpp";
      const source = { path: path.join(TEST_PROJECT, "src", name), name };
      const line = 20;
      const threadId = 1;
      await dc.setBreakpointsRequest({ source, breakpoints: [{ line }] });
      return Promise.all([
        dc.continueRequest({ threadId }),
        dc.assertStoppedLocation("breakpoint", { path: source.path, line }),
      ]);
    });

    test("should hit breakpoint after restart", async () => {
      const name = "main.cpp";
      const source = { path: path.join(TEST_PROJECT, "src", name), name };
      const line = 20;
      const threadId = 1;
      return Promise.all([
        dc.continueRequest({ threadId }),
        dc.assertStoppedLocation("breakpoint", { path: source.path, line }),
      ]);
    });
  });
});

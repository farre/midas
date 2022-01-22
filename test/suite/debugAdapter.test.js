"use strict";

const assert = require("assert");
const { DebugClient } = require("@vscode/debugadapter-testsupport");
const { MidasDebugSession } = require("../../modules/debugSession");
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

  let port = 44444;
  setup(() => {
    let myport = port++;
    MidasDebugSession.run(myport);

    dc = new DebugClient("node", "we're running the adapter as a server and don't need an executable", "midas");
    return dc.start(myport);
  });

  teardown(() => {
    dc.stop();
  });

  suite("initialize", () => {
    test("should return supported features", async () => {
      let response = await dc.initializeRequest();
      response.body = response.body || {};
      assert(response.body.supportsConfigurationDoneRequest, "supports configuation done");
    });
  });

  suite("launch", () => {
    test("should run program to the end", () => {
      const PROGRAM = path.join(TEST_PROJECT, "build", "testapp");

      return Promise.all([dc.configurationSequence(), dc.launch({ program: PROGRAM }), dc.waitForEvent("terminated")]);
    }).timeout("5s");

    test("should stop at entry", () => {
      const PROGRAM = path.join(TEST_PROJECT, "build", "testapp");

      return Promise.all([
        dc.configurationSequence(),
        dc.launch({ program: PROGRAM, stopOnEntry: true }),
        dc.waitForEvent("stopped").then((event) => {
          assert.strictEqual(event.body.reason, "entry", "should receive entry event");
        }),
      ]);
    }).timeout("5s");
  });
});

suite("Multi-threaded testing suite", () => {
  const PROGRAM = path.join(MANDELBROT_PROJECT, "build", "testapp");
  const PORT = 44444;
  let dc;

  setup(async () => {
    MidasDebugSession.run(PORT);

    dc = new DebugClient("node", "we're running the adapter as a server and don't need an executable", "midas");

    await dc.start(PORT);
    return Promise.all([
      dc.configurationSequence(),
      dc.launch({
        program: PROGRAM,
        stopOnEntry: true,
        trace: false,
        debuggeeArgs: ["additionalCLIParamTellsTestProgramCalled_Threads_ToRunAsTestSuiteOrShortMandelbrot"],
      }),
      dc.waitForEvent("stopped"),
    ]);
  });

  teardown(() => {
    dc.stop();
  });

  test("should hit breakpoint NPCU-1 amount of times", async () => {
    const name = "main.cpp";
    const source = { path: path.join(MANDELBROT_PROJECT, "src", name), name };
    const line = 63;
    const numThreads = 4;
    await dc.setBreakpointsRequest({ source, breakpoints: [{ line }] });
    const {
      body: { threads },
    } = await dc.threadsRequest();
    assert(threads.length == 1, `there should only be one thread`);

    const started = new Set();
    dc.on("thread", ({ body: { threadId, reason } }) => {
      if (reason === "started") {
        started.add(threadId);
      }
    });

    const breakpoints = new Set();
    dc.on("stopped", async ({ body: { reason, threadId } }) => {
      assert.strictEqual(reason, "breakpoint");
      breakpoints.add(threadId);
      await dc.continueRequest({ threadId });
    });

    dc.continueRequest({ threadId: threads[0].threadId });

    await dc.waitForEvent("terminated");
    assert.strictEqual(started.size, numThreads);
    assert.strictEqual(breakpoints.size, numThreads);
    assert.deepStrictEqual(breakpoints, started);
  });
});

suite("Extension Breakpoints Test Suite", () => {
  const PROGRAM = path.join(TEST_PROJECT, "build", "testapp");
  const PORT = 44444;
  let dc;

  setup(async () => {
    MidasDebugSession.run(PORT);

    dc = new DebugClient("node", "we're running the adapter as a server and don't need an executable", "midas");

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
    teardown(async () => {
      await dc.restartRequest({
        // @ts-ignore
        arguments: { program: PROGRAM, stopOnEntry: true },
      });
      await dc.waitForEvent("stopped");
    });

    test("should hit breakpoint", async () => {
      const name = "main.cpp";
      const source = { path: path.join(TEST_PROJECT, "src", name), name };
      const line = 20;
      const threadId = 1;
      await dc.setBreakpointsRequest({ source, breakpoints: [{ line }] });
      return Promise.all([dc.continueRequest({ threadId }), dc.assertStoppedLocation("breakpoint", { path: source.path, line })]);
    });

    test("should hit breakpoint after restart", async () => {
      const name = "main.cpp";
      const source = { path: path.join(TEST_PROJECT, "src", name), name };
      const line = 20;
      const threadId = 1;
      await dc.setBreakpointsRequest({ source, breakpoints: [{ line }] });
      return Promise.all([dc.continueRequest({ threadId }), dc.assertStoppedLocation("breakpoint", { path: source.path, line })]);
    });
  });
});

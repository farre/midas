"use strict";

const assert = require("assert");
const vscode = require("vscode");
const { DebugClient } = require("vscode-debugadapter-testsupport");
const { DebugSession } = require("../../modules/debugSession");
const path = require("path");

const PROJECT_ROOT = path.normalize(path.join(__dirname, "..", ".."));
const TEST_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace", "test");

suite("Extension Test Suite", () => {
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

  vscode.window.showInformationMessage("Start all tests.");

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
    }).timeout(5000);

    test("should stop at entry", () => {
      const PROGRAM = path.join(TEST_PROJECT, "build", "testapp");

      return Promise.all([
        dc.configurationSequence(),
        dc.launch({ program: PROGRAM, stopOnEntry: true }),
        dc.waitForEvent("entry"),
      ]);
    }).timeout(5000);
  });
});

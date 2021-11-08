"use strict";

const assert = require("assert");
const vscode = require("vscode");
const { DebugClient } = require("vscode-debugadapter-testsupport");
const { DebugSession } = require("../../modules/debugSession");
const path = require("path");

const PROJECT_ROOT = path.normalize(path.join(__dirname, "..", ".."));
const TEST_PROJECT = path.join(PROJECT_ROOT, "test", "cppworkspace");

suite("Extension Test Suite", () => {
  let dc;
  let ds;

  setup(() => {
    ds = DebugSession.run(50505);

    dc = new DebugClient(
      "node",
      "we're running the adapter as a server and don't need an executable",
      "midas"
    );
    return dc.start(50505);
  });

  teardown(() => dc.stop());

  vscode.window.showInformationMessage("Start all tests.");

  suite("initialize", () => {
    test("should return supported features", () => {
      return dc.initializeRequest().then((response) => {
        response.body = response.body || {};
        assert(response.body.supportsConfigurationDoneRequest, true);
      });
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
    });
  });
});

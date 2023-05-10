const assert = require("assert");

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
const vscode = require("vscode");
const { sanitize_config } = require("../../modules/activateDebuggerExtension");


suite("Persistent configuration test", () => {
  vscode.window.showInformationMessage("Start all tests.");

  test("Migrate configuration, root_dir property", () => {
    const cfg = {
      "midas_version": "0.11.1",
      "toolchain": {
        "rr": {
          "path": "/home/cx/.config/Code/User/globalStorage/farrese.midas/rr-5.6.0/bin/rr",
          "version": "5.6.0",
          "managed": true,
        },
        "gdb": {
          "path": "",
          "version": "",
          "managed": false,
        }
      }
    };
    const sanitized = sanitize_config(cfg);
    assert(sanitized.toolchain.rr.hasOwnProperty("root_dir"), "Migration failed for `root_dir`")
    const shouldEqual = {
      "midas_version": "0.11.1",
      "toolchain": {
        "rr": {
          "root_dir": "",
          "path": "/home/cx/.config/Code/User/globalStorage/farrese.midas/rr-5.6.0/bin/rr",
          "version": "5.6.0",
          "managed": true,
          "git": { sha: null, date: null }
        },
        "gdb": {
          "root_dir": "",
          "path": "",
          "version": "",
          "managed": false,
          "git": { sha: null, date: null }
        }
      }
    };

    assert.deepStrictEqual(shouldEqual, sanitized, "Written values were faulty");
  });

  test("Migrate configuration, git property", () => {
    const cfg = {
      "midas_version": "0.11.1",
      "toolchain": {
        "rr": {
          "path": "/home/cx/.config/Code/User/globalStorage/farrese.midas/rr-5.6.0/bin/rr",
          "version": "5.6.0",
          "managed": true,
        },
        "gdb": {
          "path": "",
          "version": "",
          "managed": false,
        }
      }
    };
    const sanitized = sanitize_config(cfg);
    assert(sanitized.toolchain.rr.hasOwnProperty("git"), "Migration failed for `git`")

    const shouldEqual = {
      "midas_version": "0.11.1",
      "toolchain": {
        "rr": {
          "root_dir": "",
          "path": "/home/cx/.config/Code/User/globalStorage/farrese.midas/rr-5.6.0/bin/rr",
          "version": "5.6.0",
          "managed": true,
          "git": { sha: null, date: null }
        },
        "gdb": {
          "root_dir": "",
          "path": "",
          "version": "",
          "managed": false,
          "git": { sha: null, date: null }
        }
      }
    };

    assert.deepStrictEqual(shouldEqual, sanitized, "Written values were faulty");
  });
});
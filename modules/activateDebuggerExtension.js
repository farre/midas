"use strict";

const vscode = require("vscode");
const { DebugSession } = require("./debugSession");

const { getVSCodeCommands } = require("./commandsRegistry");
const { ConfigurationProvider } = require("./debugSession");
const path = require("path");
const subprocess = require("child_process");
let term;

/**
 * @returns { Thenable<string[]> }
 */
function getTraces() {
  return new Promise((resolve, reject) => {
    subprocess.exec(`rr ls -l -t -r`, (err, stdout, stderr) => {
      if (err) {
        reject(stderr);
      } else {
        let lines = stdout.split("\n").splice(1);
        const traces = lines.map((line) => line.split(" ")[0].trim()).filter((trace) => trace.length > 0);
        resolve(traces);
      }
    });
  });
}

/** @type {(trace: string) => Thenable<readonly (vscode.QuickPickItem & {value: string})[]>} */
function getTraceInfo(trace) {
  const prefix = `'BEGIN { OFS = ","; printf "["; sep="" } NR!=1`;
  const suffix = `END { print "]" }`;

  const json = `\\"pid\\": %d,\\"ppid\\": \\"%s\\",\\"exit\\": \\"%d\\",\\"cmd\\": \\"%s\\"`;
  const rrps = `rr ps ${trace} | awk ${prefix} { printf "%s{ ${json} }",sep,$1,$2,$3,substr($0, index($0, $4));sep=","} ${suffix}'`;

  return new Promise((resolve, reject) => {
    subprocess.exec(rrps, (error, stdout, stderr) => {
      if (error) {
        reject(stderr);
      } else {
        resolve(JSON.parse(stdout));
      }
    });
  }).then((picks) =>
    picks.map(({ pid, ppid, exit, cmd }) => {
      return {
        value: pid,
        label: `${path.basename(cmd.split(" ")[0] ?? cmd)}`,
        description: `PID: ${pid}, PPID: ${ppid === "--" ? "--" : +ppid}, EXIT: ${exit}`,
        detail: cmd,
      };
    })
  );
}

/**
 *
 * @param {vscode.ExtensionContext} context
 * @param {vscode.DebugAdapterDescriptorFactory} [descriptorFactory]
 */
function activateExtension(context, descriptorFactory) {
  context.subscriptions.push(...getVSCodeCommands());
  context.workspaceState.update("allStopModeSet", true);
  let provider = new ConfigurationProvider();
  context.subscriptions.push(
    vscode.debug.registerDebugConfigurationProvider("midas", provider, vscode.DebugConfigurationProviderTriggerKind.Dynamic)
  );
  // TODO(simon): when we've implemented the most bare bones debugger
  //  meaning, we can start gdb, launch a program and stop on entry
  //  we need to implement some "frontend" functionality,
  //  such as, "what happens when the user hoves on a variable in the text editor?"
  //  we do that by adding subscriptions to the context, by using functions like
  //  vscode.languages.registerEvaluatableExpressionProvider(...)
  if (!descriptorFactory) {
    descriptorFactory = new DebugAdapterFactory();
  }
  context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("midas", descriptorFactory));
}

class DebugAdapterFactory {
  /**
   *
   * @param { vscode.DebugSession } session
   * @returns ProviderResult<vscode.DebugAdapterDescriptor>
   */
  async createDebugAdapterDescriptor(session) {
    if (session.configuration.hasOwnProperty("rrServerAddress")) {
      let miServerAddress = session.configuration.rrServerAddress;
      let rrPath = session.configuration.rrPath;

      const options = {
        canPickMany: false,
        ignoreFocusOut: true,
        title: "Select process to debug",
      };

      const tracePicked = async (tracePath) => {
        await vscode.window.showQuickPick(getTraceInfo(tracePath)).then((selection) => {
          const addr = miServerAddress.split(":");
          const port = addr[1];
          const cmd_str = `${rrPath} replay -s ${port} -p ${selection.value} -k`;
          term = vscode.window.createTerminal("rr terminal");
          vscode.window.createTerminal();
          term.sendText(cmd_str);
          term.show(true);
        });
      };
      await vscode.window.showQuickPick(getTraces(), options).then(tracePicked);
      let dbg_session = new DebugSession(true);
      dbg_session.registerTerminal(term);
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    } else {
      let dbg_session = new DebugSession(true);
      return new vscode.DebugAdapterInlineImplementation(dbg_session);
    }
  }
}

function deactivateExtension() {}

module.exports = {
  activateExtension,
  deactivateExtension,
};

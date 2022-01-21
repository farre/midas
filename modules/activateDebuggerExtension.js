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
const WHITESPACE_REGEX = /\s/;
function* get_field(line) {
  let it = 0;
  let end = 0;
  let parts_generated = 0;
  while(it < line.length) {
      if(parts_generated < 3) {
          while(WHITESPACE_REGEX.test(line.charAt(it))) it++;
          end = it;
          while(!WHITESPACE_REGEX.test(line.charAt(end))) end++;
          const res = line.substring(it, end).trim();
          it = end;
          parts_generated++;
          yield res;
      } else {
          const r = line.substring(it).trim();
          it = line.length;
          yield r;
      }
  }
  return null;
}

function fallbackParseOfrrps(trace) {
  return trace.split("\n").slice(1).map(line => {
    const [pid, ppid, exit, cmd] = [...get_field(line)];
    return {pid, ppid, exit, cmd }
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
        try {
          let json =  JSON.parse(stdout);
          resolve(json);
        } catch(err) {
          console.log(`Error parsing json, using fallback method`);
          try {
            subprocess.exec(`rr ps ${trace}`, (err, stdout, stderr) => {
              if(err) {
                reject(stderr);
              } else {
                let json = fallbackParseOfrrps(stdout);
                resolve(json);
              }
            });
          } catch(err) {
            reject(err); 
          }
        }
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
        return await vscode.window.showQuickPick(getTraceInfo(tracePath)).then((selection) => {
          if(selection) {
            const addr = miServerAddress.split(":");
            const port = addr[1];
            const cmd_str = `${rrPath} replay -s ${port} -p ${selection.value} -k`;
            term = vscode.window.createTerminal("rr terminal");
            vscode.window.createTerminal();
            term.sendText(cmd_str);
            term.show(true);
            return true;
          } 
          return false;
        });
      };
      return await vscode.window.showQuickPick(getTraces(), options).then(tracePicked).then((success) => {
        if(success) {
          let dbg_session = new DebugSession(true);
          dbg_session.registerTerminal(term);
          return new vscode.DebugAdapterInlineImplementation(dbg_session);
        } else {
          vscode.window.showErrorMessage("You did not pick a trace.");
          return null;
        }
      })
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

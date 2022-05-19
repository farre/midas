const vscode = require("vscode");

let ID = 0;
let files = ["gdb.c", "foo.c", "bar.c", "baz.c"];
let paths = ["/usr", "/share/lib", "/mount/device", "/some/path/to"];
let lines = [123, 1488, 32999, 5];
let whens = [1823, 123155, 232, 99999];

/**
 * @returns { { id: number, when: number, file: string, path: string, line: number } }
 */
function getNewCheckpoint() {
  return {
    id: ID++,
    when: whens[Math.floor(Math.random() * whens.length)],
    file: files[Math.floor(Math.random() * files.length)],
    path: paths[Math.floor(Math.random() * paths.length)],
    line: lines[Math.floor(Math.random() * lines.length)],
  };
}

class CheckpointsViewProvider {
  /** @type {vscode.WebviewView} */
  #view = null;
  #extensionUri;

  /**
   * @param {vscode.ExtensionContext} extension_ctx
   */
  constructor(extension_ctx) {
    this.#extensionUri = extension_ctx.extensionUri;
    extension_ctx.subscriptions.push(
      vscode.commands.registerCommand("midas.add-checkpoint", () => {
        if (vscode.debug.activeDebugSession) {
          this.addCheckpoint(getNewCheckpoint());
        }
      })
    );

    extension_ctx.subscriptions.push(
      vscode.commands.registerCommand("midas.clear-checkpoints", () => {
        this.clearCheckpoints();
      })
    );
  }

  /**
   * @returns {string}
   */
  get type() {
    return "midas.checkpoints-ui";
  }

  clearCheckpoints() {
    if (this.#view) {
      this.#view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders
      this.#view.webview.postMessage({ type: "clear-checkpoints" });
    }
  }

  addCheckpoint(checkpoint) {
    if (this.#view) {
      this.#view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders
      this.#view.webview.postMessage({ type: "add-checkpoint", payload: checkpoint });
    }
  }
  removeCheckpoint(id) {
    return true;
  }

  /**
   * Gets resource `resource` from the Checkpoints UI module.
   * @param {string} resource
   * @returns {vscode.Uri}
   */
  resourceUri(resource) {
    return vscode.Uri.joinPath(this.#extensionUri, "modules/ui/checkpoints", resource);
  }

  /**
   * Revolves a webview view.
   *
   * `resolveWebviewView` is called when a view first becomes visible. This may happen when the view is
   * first loaded or when the user hides and then shows a view again.
   * @param {vscode.WebviewView} webviewView Webview view to restore. The provider should take ownership of this view. The
   *    provider must set the webview's `.html` and hook up all webview events it is interested in.
   * @param {vscode.WebviewViewResolveContext} context Additional metadata about the view being resolved.
   * @param {vscode.CancellationToken} token Cancellation token indicating that the view being provided is no longer needed.
   *
   * @return {Promise<any>}
   */
  async resolveWebviewView(webviewView, context, token) {
    this.#view = webviewView;
    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,

      localResourceRoots: [this.#extensionUri],
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case "add-checkpoint":
          vscode.debug.activeDebugSession.customRequest("setRRCheckpointRequest");
          break;
        case "delete-checkpoint": {
          if (this.removeCheckpoint(data.value)) {
            console.log(`DELETE checkpoint: ${data.value}`);
            this.#view.webview.postMessage({ type: "removed-checkpoint", payload: data.value });
          }
          break;
        }
        case "run-to-checkpoint":
          console.log(`RUN TO checkpoint: ${data.value}`);
          break;
      }
    });
  }

  /**
   * @param {vscode.Webview} webview
   * @returns
   */
  _getHtmlForWebview(webview) {
    // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
    const scriptUri = webview.asWebviewUri(this.resourceUri("main.js"));
    // Do the same for the stylesheet.
    const styleResetUri = webview.asWebviewUri(this.resourceUri("reset.css"));
    const styleVSCodeUri = webview.asWebviewUri(this.resourceUri("vscode.css"));
    const styleMainUri = webview.asWebviewUri(this.resourceUri("main.css"));
    console.log(
      `codicon path: ${vscode.Uri.joinPath(
        this.#extensionUri,
        "node_modules",
        "@vscode/codicons",
        "dist",
        "codicon.css"
      ).fsPath.toString()}`
    );
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#extensionUri, "node_modules", "@vscode/codicons", "dist", "codicon.css")
    );

    // Use a nonce to only allow a specific script to be run.
    const nonce = getNonce();

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading images from https or from our extension directory,
					and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">

				<link href="${styleResetUri}" rel="stylesheet">
				<link href="${styleVSCodeUri}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">
        <link href="${codiconsUri}" rel="stylesheet">

			</head>
			<body>
      <div class="monaco-table">
				<div class="monaco-list-rows" id="checkpoints-list"></div>
      </div>
      <button class="add-checkpoint-button">Add checkpoint</button>

				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
  }
}

function getNonce() {
  let text = "";
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

module.exports = {
  CheckpointsViewProvider,
};

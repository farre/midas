const vscode = require("vscode");
const { registerCommand } = require("vscode").commands;
const { UI_REQUESTS, UI_MESSAGES } = require("./ui_protocol");
class CheckpointsViewProvider {
  /** @type {vscode.WebviewView} */
  #view = null;
  #extensionUri;

  /**
   * @param {vscode.ExtensionContext} extensionContext
   */
  constructor(extensionContext) {
    this.#extensionUri = extensionContext.extensionUri;
    let setCheckpoint = registerCommand("midas.set-checkpoint", () => {
      vscode.debug.activeDebugSession.customRequest("set-checkpoint");
    });

    let clearCheckpoints = registerCommand("midas.clear-checkpoints", () => {
      vscode.debug.activeDebugSession.customRequest("clear-checkpoints");
    });

    extensionContext.subscriptions.push(setCheckpoint, clearCheckpoints);
  }

  /**
   * @returns {string}
   */
  get type() {
    return "midas.checkpoints-ui";
  }

  updateCheckpoints(checkpoints, show = true) {
    if (this.#view) {
      if (show) this.#view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders

      this.#view.webview.postMessage({ type: UI_MESSAGES().UpdateCheckpoints, payload: checkpoints });
    }
  }

  addCheckpoint(checkpoint) {
    if (this.#view) {
      this.#view.show?.(true); // `show` is not implemented in 1.49 but is for 1.50 insiders
      this.#view.webview.postMessage({ type: UI_MESSAGES().AddCheckpoint, payload: checkpoint });
    }
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

    webviewView.webview.html = this.#createHTMLForWebView(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((data) => {
      switch (data.type) {
        case UI_REQUESTS().DeleteCheckpoint: {
          vscode.debug.activeDebugSession.customRequest("delete-checkpoint", data.value);
          break;
        }
        case UI_REQUESTS().RunToCheckpoint:
          vscode.debug.activeDebugSession.customRequest("restart-checkpoint", data.value);
          break;
      }
    });
  }

  /**
   * @param {vscode.Webview} webview
   * @returns
   */
  #createHTMLForWebView(webview) {
    // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
    const scriptUri = webview.asWebviewUri(this.resourceUri("main.js"));
    // Do the same for the stylesheet.
    const styleResetUri = webview.asWebviewUri(this.resourceUri("reset.css"));
    const styleVSCodeUri = webview.asWebviewUri(this.resourceUri("vscode.css"));
    const styleMainUri = webview.asWebviewUri(this.resourceUri("main.css"));
    const MessageProtocol = webview.asWebviewUri(this.resourceUri("ui_protocol.js"));
    const codiconsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.#extensionUri, "node_modules", "@vscode/codicons", "dist", "codicon.css")
    );

    // Use a nonce to only allow a specific script to be run.
    const nonce = getNonce();
    const serialize = JSON.stringify({ UI_MESSAGES: UI_MESSAGES(), UI_REQUESTS: UI_REQUESTS() });
    console.log(`Protocol serialized to: ${serialize}`);
    return `<!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}";>

        <meta name="viewport" content="width=device-width, initial-scale=1.0">

        <link href="${styleResetUri}" rel="stylesheet">
        <link href="${styleVSCodeUri}" rel="stylesheet">
        <link href="${styleMainUri}" rel="stylesheet">
        <link href="${codiconsUri}" rel="stylesheet">

      </head>
      <body>
      <div class="checkpoints-table">
        <div class="checkpoints-list-rows" id="checkpoints-list"></div>
      </div>
        <script nonce="${nonce} src="${MessageProtocol}></script>
        <script nonce="${nonce}" src="${scriptUri}"></script>
        <script nonce="${nonce}">
          setupUI('${serialize}');
        </script>
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

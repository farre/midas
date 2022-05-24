/* eslint-disable no-undef */
// @ts-nocheck
// eslint-disable-next-line no-unused-vars
function setupUI(protocol) {
  const { UI_MESSAGES, UI_REQUESTS } = JSON.parse(protocol);
  (function () {
    const vscode = acquireVsCodeApi();
    function create_row(container, cp) {
      let name = document.createElement("span");
      name.textContent = cp.when;
      name.className = "checkpoints-list-when";

      container.appendChild(name);

      let path = document.createElement("span");
      path.textContent = cp.where.path;
      path.className = "file-path";
      container.appendChild(path);

      let action_bar = document.createElement("div");
      action_bar.className = "checkpoints-action-bar";
      let action_container = document.createElement("ul");

      let play_button = document.createElement("li");
      play_button.className = "row-button codicon codicon-debug-continue";

      play_button.addEventListener("click", () => {
        vscode.postMessage({ type: UI_REQUESTS.RunToCheckpoint, value: container.dataset.checkpointId });
      });

      let remove_button = document.createElement("li");
      remove_button.className = "row-button codicon codicon-chrome-close";

      remove_button.addEventListener("click", () => {
        vscode.postMessage({ type: UI_REQUESTS.DeleteCheckpoint, value: container.dataset.checkpointId });
      });

      action_container.appendChild(play_button);
      action_container.appendChild(remove_button);
      action_bar.appendChild(action_container);
      container.appendChild(action_bar);

      let line = document.createElement("span");
      line.textContent = +cp.where.line;
      line.className = "checkpoints-count-badge";
      container.appendChild(line);
      // div.appendChild(container);
      // return div;
    }
    const oldState = { checkpoints: [] };
    /** @type {Array<CheckpointInfo>} */
    let checkpoints = oldState.checkpoints;

    updateCheckpointsList(checkpoints);

    // Handle messages sent from the extension to the webview
    window.addEventListener("message", (event) => {
      const message = event.data; // The json data that the extension sent
      switch (message.type) {
        case UI_MESSAGES.ClearCheckpoints: {
          checkpoints = [];
          updateCheckpointsList(checkpoints);
          break;
        }
        case UI_MESSAGES.RemovedCheckpoint: {
          removeCheckpoint(message.payload);
          break;
        }
        case UI_MESSAGES.UpdateCheckpoints: {
          updateCheckpointsList(message.payload);
          break;
        }
      }
    });

    /**
     * @param {Array<CheckpointInfo>} checkpoints
     */
    function updateCheckpointsList(checkpoints) {
      const cp_list = document.querySelector(".checkpoints-list-rows");
      cp_list.textContent = "";
      let idx = 0;
      for (const cp of checkpoints) {
        const row = document.createElement("div");
        row.className = "checkpoints-list-row";
        // row.role = "checkbox";
        //row.ariaChecked = true;
        row.dataIndex = idx;
        row.dataLastElement = idx == checkpoints.length - 1;
        row.dataset.index = idx;
        row.dataset.checkpointId = cp.id;
        row.ariaPosInSet = idx + 1;
        create_row(row, cp);
        cp_list.appendChild(row);

        idx += 1;
      }
      // Update the saved state
      vscode.setState({ checkpoints: checkpoints });
    }

    function removeCheckpoint(checkpointId) {
      checkpoints = checkpoints.filter((cp) => cp.id != checkpointId);
      updateCheckpointsList(checkpoints);
    }
  })();
}

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.

//@ts-check

/**
 * @typedef {{ id: number, when: number, where: {path: string, line: number} }} CheckpointInfo
 */

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.
(function () {
  const ACTIONS = {
    DELETE: 1,
    ADD: 2,
  };
  const vscode = acquireVsCodeApi();

  /**
   * @param {{ id: number, when: number, where: {path: string, line: number} }} cp
   */
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
      vscode.postMessage({ type: "run-to-checkpoint", value: container.dataset.checkpointId });
    });

    let remove_button = document.createElement("li");
    remove_button.className = "row-button codicon codicon-chrome-close";

    remove_button.addEventListener("click", () => {
      vscode.postMessage({ type: "delete-checkpoint", value: container.dataset.checkpointId });
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
  const oldState = vscode.getState() || { checkpoints: [] };
  console.log(JSON.stringify(oldState));
  /** @type {Array<CheckpointInfo>} */
  let checkpoints = oldState.checkpoints;

  updateCheckpointsList(checkpoints);

  // Handle messages sent from the extension to the webview
  window.addEventListener("message", (event) => {
    const message = event.data; // The json data that the extension sent
    switch (message.type) {
      case "add-checkpoint": {
        addCheckpoint(message.payload);
        break;
      }
      case "clear-checkpoints": {
        checkpoints = [];
        ID = 0;
        updateCheckpointsList(checkpoints);
        break;
      }
      case "removed-checkpoint": {
        removeCheckpoint(message.payload);
        break;
      }
      case "update-checkpoints": {
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

  function addCheckpoint(cp) {
    vscode.debug.activeDebugSession.customRequest("setRRCheckpointRequest");
    checkpoints.push(cp);
    console.log(checkpoints);
    updateCheckpointsList(checkpoints);
  }
})();

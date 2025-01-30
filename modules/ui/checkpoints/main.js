/* eslint-disable no-undef */
// @ts-nocheck
// eslint-disable-next-line no-unused-vars
function setupUI(protocol) {
  const { UI_MESSAGES, UI_REQUESTS } = JSON.parse(protocol);
  (function () {
    const vscode = acquireVsCodeApi();
    function create_row(container, cp) {
      const checkpointEventNumber = document.createElement("span");
      checkpointEventNumber.textContent = `${cp.when}`;
      checkpointEventNumber.className = "checkpoints-list-when";
      container.appendChild(checkpointEventNumber);

      const checkpointName = document.createElement("span");
      checkpointName.textContent = cp.name;
      checkpointName.className = "file-path";
      checkpointName.addEventListener("click", () => {
        const sourceLocPath = cp.where.path.split(" at ")[1];

        if (sourceLocPath)
          vscode.postMessage({ type: UI_REQUESTS.GotoSourceLoc, value: { path: sourceLocPath, line: cp.where.line } });
      });

      checkpointName.addEventListener("keydown", (event) => {
        if (event.keyCode === 13) {
          checkpointName.contentEditable = false;
          event.target.blur();
        }
      });

      checkpointName.addEventListener("blur", (event) => {
        const payload = { checkpointId: cp.id, name: event.target.textContent };
        vscode.postMessage({ type: UI_MESSAGES.NameCheckpoint, value: payload });
      });

      checkpointName.id = `cp-${cp.id}`;

      container.appendChild(checkpointName);

      const actionBar = document.createElement("div");
      actionBar.className = "checkpoints-action-bar";
      let actionContainer = document.createElement("ul");

      const editButton = document.createElement("li");
      editButton.className = "row-button codicon codicon-edit";

      editButton.addEventListener("click", () => {
        checkpointName.contentEditable = true;
        checkpointName.focus();
      });

      const playButton = document.createElement("li");
      playButton.className = "row-button codicon codicon-debug-continue";

      playButton.addEventListener("click", () => {
        vscode.postMessage({ type: UI_REQUESTS.RunToCheckpoint, value: container.dataset.checkpointId });
      });

      const removeButton = document.createElement("li");
      removeButton.className = "row-button codicon codicon-chrome-close";

      removeButton.addEventListener("click", () => {
        vscode.postMessage({ type: UI_REQUESTS.DeleteCheckpoint, value: container.dataset.checkpointId });
      });

      actionContainer.appendChild(editButton);
      actionContainer.appendChild(playButton);
      actionContainer.appendChild(removeButton);
      actionBar.appendChild(actionContainer);
      container.appendChild(actionBar);
    }

    // Handle messages sent from the extension to the webview
    window.addEventListener("message", (event) => {
      const message = event.data; // The json data that the extension sent
      switch (message.type) {
        case UI_MESSAGES.ClearCheckpoints: {
          updateCheckpointsList([]);
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
        row.dataIndex = idx;
        row.dataLastElement = idx == checkpoints.length - 1;
        row.dataset.index = idx;
        row.dataset.checkpointId = cp.id;
        row.ariaPosInSet = idx + 1;
        row.id = `cp-row-${cp.id}`;
        create_row(row, cp);
        cp_list.appendChild(row);

        idx += 1;
      }
    }

    function removeCheckpoint(checkpointId) {
      checkpoints = checkpoints.filter((cp) => cp.id != checkpointId);
      updateCheckpointsList(checkpoints);
    }
  })();
}

// This script will be run within the webview itself
// It cannot access the main VS Code APIs directly.

"use strict";
// pull in EventEmitter, which DebugInterface extends
// it is through this, we dispatch communication between VSCode and GDB/MI
const {EventEmitter} = require("events");

class DebugInterface extends EventEmitter {}
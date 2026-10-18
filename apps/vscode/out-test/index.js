"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// apps/vscode/test/integration/index.ts
var integration_exports = {};
__export(integration_exports, {
  run: () => run
});
module.exports = __toCommonJS(integration_exports);
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var import_mocha = __toESM(require("mocha"));
var run = async () => {
  const mocha = new import_mocha.default({ ui: "bdd", color: false, timeout: 9e4, reporter: "spec" });
  if (process.env.CODEGENT_IT_GREP) mocha.grep(process.env.CODEGENT_IT_GREP);
  for (const file of import_node_fs.default.readdirSync(__dirname).sort()) {
    if (file.endsWith(".test.js")) mocha.addFile(import_node_path.default.join(__dirname, file));
  }
  await new Promise((resolve, reject) => {
    mocha.run((failures) => failures ? reject(new Error(`${failures} integration test(s) failed.`)) : resolve());
  });
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  run
});

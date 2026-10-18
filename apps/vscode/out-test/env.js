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

// apps/vscode/test/integration/env.ts
var env_exports = {};
__export(env_exports, {
  configuration: () => configuration,
  getApi: () => getApi,
  hubPorts: () => hubPorts,
  replaceWindowFunction: () => replaceWindowFunction,
  sandbox: () => sandbox,
  setSetting: () => setSetting,
  workRepo: () => workRepo
});
module.exports = __toCommonJS(env_exports);
var vscode = __toESM(require("vscode"));

// apps/vscode/test/support/git-fixture.ts
var import_node_child_process = require("node:child_process");
var import_node_path = __toESM(require("node:path"));
var git = (cwd, ...args) => (0, import_node_child_process.execFileSync)("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
}).trimEnd();
var attachRepo = (parent, name) => {
  const dir = import_node_path.default.join(parent, name);
  const bare = import_node_path.default.join(parent, `${name}.git`);
  const base = git(dir, "rev-list", "--max-parents=0", "HEAD");
  return {
    dir,
    bare,
    base,
    reset: () => {
      git(dir, "checkout", "-q", "-f", "main");
      git(dir, "reset", "-q", "--hard", base);
      git(dir, "clean", "-fdq");
      git(dir, "push", "-q", "--force", "origin", "main");
    }
  };
};

// apps/vscode/test/integration/env.ts
var sandbox = () => {
  const dir = process.env.CODEGENT_IT_DIR;
  if (!dir)
    throw new Error(
      "CODEGENT_IT_DIR is not set; run these tests with `npm run test:integration`."
    );
  return dir;
};
var hubPorts = () => (process.env.CODEGENT_IT_PORTS ?? "").split(",").map(Number);
var workRepo = () => attachRepo(sandbox(), "work");
var getApi = async () => {
  const extension = vscode.extensions.getExtension("codegent.codegent");
  if (!extension)
    throw new Error("The CodeGent extension is not installed in the test instance.");
  return extension.isActive ? extension.exports : extension.activate();
};
var configuration = () => vscode.workspace.getConfiguration("codegent");
var setSetting = async (key, value) => {
  await configuration().update(key, value, vscode.ConfigurationTarget.Global);
};
var replaceWindowFunction = (name, replacement) => {
  const window2 = vscode.window;
  const original = window2[name];
  window2[name] = replacement;
  return () => {
    window2[name] = original;
  };
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  configuration,
  getApi,
  hubPorts,
  replaceWindowFunction,
  sandbox,
  setSetting,
  workRepo
});

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

// test/support/git-fixture.ts
var git_fixture_exports = {};
__export(git_fixture_exports, {
  attachRepo: () => attachRepo,
  cloneOfRealRepo: () => cloneOfRealRepo,
  git: () => git,
  githubLikeRepo: () => githubLikeRepo,
  write: () => write
});
module.exports = __toCommonJS(git_fixture_exports);
var import_node_child_process = require("node:child_process");
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var git = (cwd, ...args) => (0, import_node_child_process.execFileSync)("git", args, {
  cwd,
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"]
}).trimEnd();
var write = (cwd, file, content) => {
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(import_node_path.default.join(cwd, file)), { recursive: true });
  import_node_fs.default.writeFileSync(import_node_path.default.join(cwd, file), content);
};
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
var githubLikeRepo = (parent, name, files) => {
  const dir = import_node_path.default.join(parent, name);
  const bare = import_node_path.default.join(parent, `${name}.git`);
  import_node_fs.default.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "tester@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  for (const [file, content] of Object.entries(files)) write(dir, file, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "initial");
  git(parent, "init", "-q", "--bare", "-b", "main", bare);
  git(dir, "remote", "add", "origin", "https://github.com/octo/project.git");
  git(dir, "remote", "set-url", "--push", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  return attachRepo(parent, name);
};
var cloneOfRealRepo = (parent, name, source) => {
  const dir = import_node_path.default.join(parent, name);
  const bare = import_node_path.default.join(parent, `${name}.git`);
  const upstream = git(source, "remote", "get-url", "origin");
  git(parent, "clone", "-q", "--no-hardlinks", "-c", "core.autocrlf=false", source, dir);
  git(dir, "config", "user.email", "tester@example.com");
  git(dir, "config", "user.name", "Tester");
  git(dir, "config", "core.autocrlf", "false");
  git(dir, "config", "commit.gpgsign", "false");
  git(parent, "init", "-q", "--bare", "-b", "main", bare);
  git(dir, "remote", "set-url", "origin", upstream);
  git(dir, "remote", "set-url", "--push", "origin", bare);
  git(dir, "push", "-q", "-u", "origin", "main");
  return { dir, bare };
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  attachRepo,
  cloneOfRealRepo,
  git,
  githubLikeRepo,
  write
});

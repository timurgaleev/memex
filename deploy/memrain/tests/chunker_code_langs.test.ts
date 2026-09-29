/**
 * Code chunker tests for the extended language set — bash / SQL / Go.
 *
 * Exercises the real tree-sitter WASM grammars vendored under
 * deploy/memex/wasm/ (tree-sitter-{bash,go,sql}.wasm). These grammars load
 * AND parse under the pinned web-tree-sitter runtime; yaml/hcl are
 * deliberately absent (their blobs don't parse / aren't vendored).
 */
import { afterAll, describe, expect, it } from "bun:test";
import { chunkCode } from "../src/core/chunkers/code.ts";
import {
  _resetParsersForTests,
  languageForFile,
} from "../src/core/chunkers/parsers.ts";

afterAll(() => _resetParsersForTests());

describe("languageForFile (extended extensions)", () => {
  it("maps the new operator-stack extensions", () => {
    expect(languageForFile("deploy.sh")).toBe("bash");
    expect(languageForFile("lib.bash")).toBe("bash");
    expect(languageForFile("main.go")).toBe("go");
    expect(languageForFile("schema.sql")).toBe("sql");
  });
});

describe("chunkCode (bash)", () => {
  it("extracts a shell function definition", async () => {
    const src = `#!/usr/bin/env bash
set -euo pipefail

deploy() {
  echo "shipping"
}

function build {
  make all
}
`;
    const r = await chunkCode(src, "deploy.sh", "bash");
    expect(r.hasParseError).toBe(false);
    const names = r.symbols.map((s) => s.name).sort();
    expect(names).toEqual(["build", "deploy"]);
    const deploy = r.symbols.find((s) => s.name === "deploy")!;
    expect(deploy.kind).toBe("function");
    expect(deploy.body).toContain('echo "shipping"');
  });
});

describe("chunkCode (Go)", () => {
  it("extracts funcs, methods and type declarations", async () => {
    const src = `package main

import "fmt"

type Server struct {
	Addr string
}

func New() *Server {
	return &Server{}
}

func (s *Server) Start() error {
	fmt.Println(s.Addr)
	return nil
}
`;
    const r = await chunkCode(src, "server.go", "go");
    expect(r.hasParseError).toBe(false);
    const byName = new Map(r.symbols.map((s) => [s.name, s]));
    expect(byName.has("Server")).toBe(true);
    expect(byName.get("Server")!.kind).toBe("class");
    expect(byName.get("New")!.kind).toBe("function");
    expect(byName.get("Start")!.kind).toBe("method");
  });
});

describe("chunkCode (SQL)", () => {
  it("extracts DDL definitions and skips bare DML", async () => {
    const src = `CREATE TABLE users (id int primary key, name text);

CREATE INDEX idx_users_name ON users (name);

CREATE FUNCTION add_one(n int) RETURNS int AS $$ SELECT n + 1 $$ LANGUAGE sql;

SELECT * FROM users;
`;
    const r = await chunkCode(src, "schema.sql", "sql");
    expect(r.hasParseError).toBe(false);
    const byName = new Map(r.symbols.map((s) => [s.name, s]));
    expect(byName.get("users")!.kind).toBe("class");
    expect(byName.get("idx_users_name")!.kind).toBe("const");
    expect(byName.get("add_one")!.kind).toBe("function");
    // The bare SELECT is DML — no symbol emitted for it.
    expect(r.symbols.some((s) => s.body.trim().startsWith("SELECT"))).toBe(false);
  });
});

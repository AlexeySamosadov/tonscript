// ============================================================
// TonScript Compiler — Main Pipeline
// Source → Parse → Codegen → TVM Assembly / Binary
// ============================================================

import { Parser } from "./parser.js";
import { CodeGenerator } from "./codegen.js";
import { tvmToAsm, TVMAssembler, TVMInst } from "./tvm.js";
import type { Program } from "./ast.js";

export type CompileResult = {
  ast: Program;
  asm: string;
  instructions: {
    recvInternal: TVMInst[];
    getters: { name: string; id: number; code: TVMInst[] }[];
    stateInit: TVMInst[];
    asmFull: TVMInst[];
  };
  binary?: {
    codeBits: number[];
    dataBits: number[];
  };
};

export function compile(source: string, contractName?: string): CompileResult {
  // 1. Parse
  const parser = new Parser(source);
  const ast = parser.parse();

  // 2. Codegen (optionally targeting a specific contract by name)
  const codegen = new CodeGenerator();
  const instructions = codegen.generate(ast, contractName);

  // 3. Generate readable assembly
  const asmParts: string[] = [];

  asmParts.push(";; === TonScript Compiled Output ===");
  asmParts.push(";; Direct TS → TVM (no FunC, no Fift)");
  asmParts.push("");

  asmParts.push(";; ── recv_internal ──");
  asmParts.push(tvmToAsm(instructions.recvInternal));
  asmParts.push("");

  for (const getter of instructions.getters) {
    asmParts.push(`\n;; ── getter: ${getter.name} (method_id=${getter.id}) ──`);
    asmParts.push(tvmToAsm(getter.code));
  }

  asmParts.push("\n;; ── state init (deploy data) ──");
  asmParts.push(tvmToAsm(instructions.stateInit));

  const asm = asmParts.join("\n");

  // 4. Binary encoding (optional, best-effort)
  let binary: CompileResult["binary"];
  try {
    const assembler = new TVMAssembler();
    const codeResult = assembler.encodeInstructions(instructions.asmFull);

    const dataAssembler = new TVMAssembler();
    const dataResult = dataAssembler.encodeInstructions(instructions.stateInit);

    binary = {
      codeBits: codeResult.bits,
      dataBits: dataResult.bits,
    };
  } catch {
    // Binary encoding is best-effort for now
  }

  return { ast, asm, instructions, binary };
}

export function compileAll(source: string): Map<string, CompileResult> {
  // 1. Parse once
  const parser = new Parser(source);
  const ast = parser.parse();

  // 2. Collect all contract names
  const contractNames = ast.declarations
    .filter(d => d.kind === "ContractDecl")
    .map(d => d.name);

  if (contractNames.length === 0) {
    throw new Error("No contracts found");
  }

  // 3. Compile each contract by name
  const results = new Map<string, CompileResult>();
  for (const name of contractNames) {
    results.set(name, compile(source, name));
  }

  return results;
}

export function compileToAsm(source: string): string {
  return compile(source).asm;
}

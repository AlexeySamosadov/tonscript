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

export function compile(source: string): CompileResult {
  // 1. Parse
  const parser = new Parser(source);
  const ast = parser.parse();

  // 2. Codegen
  const codegen = new CodeGenerator();
  const instructions = codegen.generate(ast);

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

export function compileToAsm(source: string): string {
  return compile(source).asm;
}

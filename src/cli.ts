#!/usr/bin/env node
// ============================================================
// TonScript CLI
// Usage: tonsc <file.ts> [--asm] [--ast] [--binary] [--boc]
// ============================================================

import { readFileSync, writeFileSync } from "fs";
import { basename } from "path";
import { compile } from "./compiler.js";
import { buildContractBoc } from "./boc.js";

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("--help")) {
  console.log(`
TonScript Compiler — TypeScript -> TVM bytecode (direct)

Usage:
  tonsc <file.ts>           Compile and show TVM assembly
  tonsc <file.ts> --ast     Show AST
  tonsc <file.ts> --asm     Show TVM assembly (default)
  tonsc <file.ts> --binary  Show binary encoding info
  tonsc <file.ts> --boc     Output .boc file for deployment
  tonsc <file.ts> --all     Show everything

No FunC. No Fift. Direct compilation.
`);
  process.exit(0);
}

const file = args.find(a => !a.startsWith("--"));
if (!file) {
  console.error("Error: No input file specified");
  process.exit(1);
}

const showAst = args.includes("--ast") || args.includes("--all");
const showAsm = args.includes("--asm") || args.includes("--all") || !args.some(a => a.startsWith("--") && a !== "--help");
const showBinary = args.includes("--binary") || args.includes("--all");
const doBoc = args.includes("--boc") || args.includes("--all");

try {
  const source = readFileSync(file, "utf-8");
  const result = compile(source);

  if (showAst) {
    console.log("=== AST ===");
    console.log(JSON.stringify(result.ast, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    console.log();
  }

  if (showAsm) {
    console.log(result.asm);
    console.log();
  }

  if (showBinary && result.binary) {
    console.log("=== Binary ===");
    console.log(`Code: ${result.binary.codeBits.length} bits`);
    console.log(`Data: ${result.binary.dataBits.length} bits`);

    // Show as hex
    const toHex = (bits: number[]) => {
      let hex = "";
      for (let i = 0; i < bits.length; i += 4) {
        const nibble = (bits[i] || 0) << 3 | (bits[i+1] || 0) << 2 | (bits[i+2] || 0) << 1 | (bits[i+3] || 0);
        hex += nibble.toString(16);
      }
      return hex;
    };

    console.log(`Code hex: ${toHex(result.binary.codeBits)}`);
    console.log(`Data hex: ${toHex(result.binary.dataBits)}`);
  }

  if (doBoc) {
    console.log("=== BOC Output ===");
    const bocResult = buildContractBoc(result);

    // Derive output filename from input
    const outFile = basename(file).replace(/\.ts$/, ".boc");
    writeFileSync(outFile, bocResult.boc);

    console.log(`Contract address: ${bocResult.address.toString()}`);
    console.log(`Code cell: ${bocResult.code.bits.length} bits, ${bocResult.code.refs.length} refs`);
    console.log(`Data cell: ${bocResult.data.bits.length} bits, ${bocResult.data.refs.length} refs`);
    console.log(`StateInit: ${bocResult.stateInit.bits.length} bits, ${bocResult.stateInit.refs.length} refs`);
    console.log(`BOC size: ${bocResult.boc.length} bytes`);
    console.log(`Written to: ${outFile}`);
  }

  // Stats
  const contractDecl = result.ast.declarations.find(d => d.kind === "ContractDecl");
  if (contractDecl && contractDecl.kind === "ContractDecl") {
    console.log(`\n;; Contract: ${contractDecl.name}`);
    console.log(`;; Fields: ${contractDecl.fields.length}`);
    console.log(`;; Receivers: ${contractDecl.receivers.length}`);
    console.log(`;; Getters: ${contractDecl.getters.length}`);
    if (result.binary) {
      console.log(`;; Code size: ${Math.ceil(result.binary.codeBits.length / 8)} bytes`);
    }
  }
} catch (err: any) {
  console.error(`Compilation error: ${err.message}`);
  process.exit(1);
}

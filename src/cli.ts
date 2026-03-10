#!/usr/bin/env node
// ============================================================
// TonScript CLI
// Developer-friendly command-line interface for TonScript
// ============================================================

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { basename, resolve, join, dirname } from "path";
import { compile, compileAll, CompileResult } from "./compiler.js";
import { buildContractBoc } from "./boc.js";
import { methodId, messageOpcode } from "./tvm.js";
import { execSync, spawnSync } from "child_process";
import { fileURLToPath } from "url";

// ── ANSI Colors ─────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const BLUE = "\x1b[34m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";

function bold(s: string): string { return `${BOLD}${s}${RESET}`; }
function red(s: string): string { return `${RED}${s}${RESET}`; }
function green(s: string): string { return `${GREEN}${s}${RESET}`; }
function yellow(s: string): string { return `${YELLOW}${s}${RESET}`; }
function blue(s: string): string { return `${BLUE}${s}${RESET}`; }
function cyan(s: string): string { return `${CYAN}${s}${RESET}`; }
function dim(s: string): string { return `${DIM}${s}${RESET}`; }

// ── Helpers ─────────────────────────────────────────────────

function getVersion(): string {
  try {
    const thisFile = fileURLToPath(import.meta.url);
    const pkgPath = resolve(dirname(thisFile), "../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some(f => args.includes(f));
}

function getPositionalArgs(args: string[]): string[] {
  const result: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      // Skip flag and its value if it takes one
      if (["--contract", "--output"].includes(args[i])) {
        i++; // skip the value
      }
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

// ── Command: build ──────────────────────────────────────────

function cmdBuild(args: string[]): void {
  const positional = getPositionalArgs(args);
  const file = positional[0];

  if (!file) {
    console.error(red("Error: No input file specified"));
    console.error(`Usage: tonscript build <file.ts> [--asm] [--contract <name>] [--output <dir>]`);
    process.exit(1);
  }

  if (!existsSync(file)) {
    console.error(red(`Error: File not found: ${file}`));
    process.exit(1);
  }

  const showAsm = hasFlag(args, "--asm");
  const contractFilter = getFlag(args, "--contract");
  const outputDir = getFlag(args, "--output") || ".";

  const source = readFileSync(file, "utf-8");

  console.log(bold("\n  TonScript Build\n"));
  console.log(dim(`  Source: ${file}`));

  try {
    if (showAsm) {
      // ASM mode: print human-readable assembly
      if (contractFilter) {
        const result = compile(source, contractFilter);
        console.log(dim(`  Contract: ${contractFilter}\n`));
        console.log(result.asm);
      } else {
        const results = compileAll(source);
        for (const [name, result] of results) {
          console.log(bold(`\n  === ${name} ===\n`));
          console.log(result.asm);
        }
      }
      return;
    }

    // BOC mode: compile and write .boc files
    let results: Map<string, CompileResult>;
    if (contractFilter) {
      results = new Map();
      results.set(contractFilter, compile(source, contractFilter));
    } else {
      results = compileAll(source);
    }

    // Ensure output directory exists
    if (outputDir !== ".") {
      mkdirSync(outputDir, { recursive: true });
    }

    console.log(dim(`  Output: ${resolve(outputDir)}\n`));

    for (const [name, result] of results) {
      const bocResult = buildContractBoc(result);
      const outFile = join(outputDir, `${name}.boc`);
      writeFileSync(outFile, bocResult.boc);

      console.log(green(`  [OK] `) + bold(name));
      console.log(`       Code:    ${bocResult.code.bits.length} bits, ${bocResult.code.refs.length} refs`);
      console.log(`       Data:    ${bocResult.data.bits.length} bits, ${bocResult.data.refs.length} refs`);
      console.log(`       BOC:     ${bocResult.boc.length} bytes`);
      console.log(`       Address: ${bocResult.address.toString()}`);
      console.log(`       File:    ${outFile}`);
      console.log();
    }

    console.log(green(`  Build complete: ${results.size} contract(s)\n`));

  } catch (err: any) {
    console.error(red(`\n  Compilation error: ${err.message}\n`));
    process.exit(1);
  }
}

// ── Command: test ───────────────────────────────────────────

function cmdTest(_args: string[]): void {
  console.log(bold("\n  TonScript Test Runner\n"));

  // Find test files
  const testFiles: string[] = [];
  const srcDir = resolve("src");

  if (existsSync(srcDir)) {
    try {
      const files = execSync(`find ${srcDir} -name "*test*.ts" -o -name "*-test*.ts"`, {
        encoding: "utf-8",
      }).trim().split("\n").filter(Boolean);

      // Deduplicate, exclude deploy scripts, and sort
      const unique = [...new Set(files)]
        .filter(f => !basename(f).startsWith("deploy"))
        .sort();
      testFiles.push(...unique);
    } catch {
      // find command failed
    }
  }

  if (testFiles.length === 0) {
    console.log(yellow("  No test files found."));
    console.log(dim("  Looking for: src/*test*.ts, src/*-test*.ts\n"));
    process.exit(0);
  }

  console.log(dim(`  Found ${testFiles.length} test file(s):\n`));

  let totalPassed = 0;
  let totalFailed = 0;
  const results: { file: string; ok: boolean; output: string }[] = [];

  for (const testFile of testFiles) {
    const shortName = basename(testFile);
    process.stdout.write(`  Running ${cyan(shortName)}... `);

    const result = spawnSync("npx", ["tsx", testFile], {
      encoding: "utf-8",
      timeout: 120000,
      cwd: resolve("."),
    });

    const output = (result.stdout || "") + (result.stderr || "");
    const ok = result.status === 0;

    if (ok) {
      // Count passed/failed from output
      const passMatch = output.match(/(\d+)\s+passed/);
      const failMatch = output.match(/(\d+)\s+failed/);
      const p = passMatch ? parseInt(passMatch[1]) : 0;
      const f = failMatch ? parseInt(failMatch[1]) : 0;
      totalPassed += p;
      totalFailed += f;
      console.log(green("PASS") + dim(` (${p} passed, ${f} failed)`));
    } else {
      totalFailed += 1;
      console.log(red("FAIL"));
      // Show first few lines of error output
      const errorLines = output.split("\n").filter(l => l.includes("FAIL") || l.includes("Error")).slice(0, 5);
      for (const line of errorLines) {
        console.log(`    ${red(line.trim())}`);
      }
    }

    results.push({ file: testFile, ok, output });
  }

  // Summary
  console.log(bold("\n  ─── Summary ───\n"));
  console.log(`  Test suites: ${green(`${results.filter(r => r.ok).length} passed`)}, ${results.length} total`);
  console.log(`  Tests:       ${green(`${totalPassed} passed`)}, ${totalFailed > 0 ? red(`${totalFailed} failed`) : `${totalFailed} failed`}, ${totalPassed + totalFailed} total`);
  console.log();

  if (totalFailed > 0 || results.some(r => !r.ok)) {
    process.exit(1);
  }
}

// ── Command: deploy ─────────────────────────────────────────

function cmdDeploy(args: string[]): void {
  const positional = getPositionalArgs(args);
  const file = positional[0];

  if (!file) {
    console.error(red("Error: No input file specified"));
    console.error(`Usage: tonscript deploy <file.ts> --testnet [--contract <name>]`);
    process.exit(1);
  }

  if (!existsSync(file)) {
    console.error(red(`Error: File not found: ${file}`));
    process.exit(1);
  }

  const isTestnet = hasFlag(args, "--testnet");
  const contractFilter = getFlag(args, "--contract");

  if (!isTestnet) {
    console.error(red("Error: Only --testnet is supported. Mainnet deploy is not yet implemented."));
    console.error(dim("Usage: tonscript deploy <file.ts> --testnet"));
    process.exit(1);
  }

  const source = readFileSync(file, "utf-8");

  console.log(bold("\n  TonScript Deploy (Testnet)\n"));
  console.log(dim(`  Source: ${file}\n`));

  try {
    // Compile
    let results: Map<string, CompileResult>;
    if (contractFilter) {
      results = new Map();
      results.set(contractFilter, compile(source, contractFilter));
    } else {
      results = compileAll(source);
    }

    for (const [name, result] of results) {
      const bocResult = buildContractBoc(result);

      console.log(bold(`  Contract: ${name}`));
      console.log(`  Address:  ${bocResult.address.toString()}`);
      console.log(`  Explorer: ${cyan(`https://testnet.tonviewer.com/${bocResult.address.toString()}`)}`);
      console.log(`  Code:     ${bocResult.code.bits.length} bits, ${bocResult.code.refs.length} refs`);
      console.log(`  Data:     ${bocResult.data.bits.length} bits`);
      console.log(`  BOC:      ${bocResult.boc.length} bytes`);
      console.log();

      // Write BOC file
      const outFile = `${name}.boc`;
      writeFileSync(outFile, bocResult.boc);
      console.log(dim(`  BOC written to: ${outFile}`));
    }

    // Print deploy instructions
    console.log(bold("\n  ─── Deploy Instructions ───\n"));
    console.log(`  To deploy to testnet, you need a wallet with testnet TON.`);
    console.log();
    console.log(`  ${bold("Option 1:")} Use the deploy script directly:`);
    console.log(dim(`    npx tsx src/deploy-testnet.ts`));
    console.log();
    console.log(`  ${bold("Option 2:")} Set up mnemonic and deploy programmatically:`);
    console.log(dim(`    export TONSCRIPT_MNEMONIC="word1 word2 ... word24"`));
    console.log(dim(`    # Then use @ton/ton TonClient to send stateInit transaction`));
    console.log();
    console.log(`  ${bold("Option 3:")} Use tonkeeper or another wallet to deploy the .boc file.`);
    console.log();

    // Check for mnemonic
    const mnemonic = process.env.TONSCRIPT_MNEMONIC;
    if (mnemonic) {
      console.log(green("  Mnemonic found in TONSCRIPT_MNEMONIC environment variable."));
      console.log(yellow("  Note: Automatic deploy with mnemonic is not yet implemented in CLI."));
      console.log(dim("  Use src/deploy-testnet.ts as a reference for full deploy flow.\n"));
    } else {
      console.log(dim("  Set TONSCRIPT_MNEMONIC env var for future automatic deploy support.\n"));
    }

  } catch (err: any) {
    console.error(red(`\n  Compilation error: ${err.message}\n`));
    process.exit(1);
  }
}

// ── Command: init ───────────────────────────────────────────

function cmdInit(args: string[]): void {
  const positional = getPositionalArgs(args);
  const name = positional[0] || "my-tonscript-project";

  const projectDir = resolve(name);

  if (existsSync(projectDir)) {
    console.error(red(`Error: Directory already exists: ${projectDir}`));
    process.exit(1);
  }

  console.log(bold(`\n  TonScript Init\n`));
  console.log(dim(`  Creating project: ${name}\n`));

  // Create directory structure
  mkdirSync(join(projectDir, "contracts"), { recursive: true });
  mkdirSync(join(projectDir, "tests"), { recursive: true });

  // Copy counter.ts as the starter contract
  let counterSource: string;
  try {
    const thisFile = fileURLToPath(import.meta.url);
    counterSource = readFileSync(resolve(dirname(thisFile), "../examples/counter.ts"), "utf-8");
  } catch {
    // Fallback if examples directory is not found
    counterSource = `// Counter Contract -- TonScript

message(0x01) Increment {
  amount: uint32
}

message(0x02) Decrement {
  amount: uint32
}

message(0x03) Reset {}

contract Counter {
  value: uint32 = 0
  owner: uint256 = 0

  init(owner: uint256) {
    this.owner = owner
    this.value = 0
  }

  receive(msg: Increment) {
    this.value += msg.amount
  }

  receive(msg: Decrement) {
    require(this.value >= msg.amount, 100)
    this.value -= msg.amount
  }

  receive(msg: Reset) {
    this.value = 0
  }

  get value(): uint32 {
    return this.value
  }

  get doubled(): uint32 {
    return this.value * 2
  }
}
`;
  }

  writeFileSync(join(projectDir, "contracts", "counter.ts"), counterSource);

  // Create test template
  const testTemplate = `// Counter Contract Tests
// Run with: npx tonscript test

import { readFileSync } from "fs";
import { Blockchain, createShardAccount } from "@ton/sandbox";
import { beginCell, toNano } from "@ton/core";
import { compile } from "tonscript/compiler";
import { buildContractBoc } from "tonscript/boc";
import { methodId } from "tonscript/tvm";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => { console.log(\`  OK  \${name}\`); passed++; })
    .catch((e: any) => { console.log(\`  FAIL  \${name}: \${e.message}\`); failed++; });
}

function assert(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}

async function main() {
  console.log("\\n=== Counter Contract Tests ===\\n");

  const source = readFileSync("contracts/counter.ts", "utf-8");
  const result = compile(source);
  const bocResult = buildContractBoc(result);

  console.log(\`Compiled: \${bocResult.code.bits.length} bits code\\n\`);

  const blockchain = await Blockchain.create();
  const deployer = await blockchain.treasury("deployer");
  const addr = bocResult.address;

  await blockchain.setShardAccount(addr, createShardAccount({
    address: addr,
    code: bocResult.code,
    data: bocResult.data,
    balance: toNano("1"),
  }));

  await test("initial value is 0", async () => {
    const res = await blockchain.runGetMethod(addr, methodId("value"));
    assert(res.exitCode === 0);
    assert(res.stackReader.readBigNumber() === 0n);
  });

  await test("increment works", async () => {
    const body = beginCell().storeUint(0x01, 32).storeUint(5, 32).endCell();
    await deployer.send({ to: addr, value: toNano("0.05"), body });
    const res = await blockchain.runGetMethod(addr, methodId("value"));
    assert(res.exitCode === 0);
    assert(res.stackReader.readBigNumber() === 5n);
  });

  console.log(\`\\n=== Results: \${passed} passed, \${failed} failed ===\\n\`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
`;
  writeFileSync(join(projectDir, "tests", "counter.test.ts"), testTemplate);

  // Create package.json
  const pkgJson = {
    name: name,
    version: "0.1.0",
    description: "TonScript smart contract project",
    type: "module",
    scripts: {
      build: "npx tsx node_modules/tonscript/src/cli.ts build contracts/counter.ts",
      test: "npx tsx node_modules/tonscript/src/cli.ts test",
      deploy: "npx tsx node_modules/tonscript/src/cli.ts deploy contracts/counter.ts --testnet",
    },
    dependencies: {
      tonscript: "^0.1.0",
      "@ton/core": "^0.63.1",
      "@ton/ton": "^16.2.2",
    },
    devDependencies: {
      "@ton/sandbox": "^0.41.0",
      typescript: "^5.7.0",
    },
  };
  writeFileSync(join(projectDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");

  // Create tsconfig.json
  const tsConfig = {
    compilerOptions: {
      target: "ES2022",
      module: "ES2022",
      moduleResolution: "node",
      outDir: "./dist",
      strict: true,
      esModuleInterop: true,
      declaration: true,
      sourceMap: true,
    },
    include: ["contracts/**/*", "tests/**/*"],
  };
  writeFileSync(join(projectDir, "tsconfig.json"), JSON.stringify(tsConfig, null, 2) + "\n");

  // Create README.md
  writeFileSync(
    join(projectDir, "README.md"),
    `# ${name}

A TonScript smart contract project.

## Quick Start

\`\`\`bash
npm install
npx tonscript build contracts/counter.ts
npx tonscript build contracts/counter.ts --asm
npx tonscript info contracts/counter.ts
npx tonscript test
npx tonscript deploy contracts/counter.ts --testnet
\`\`\`

## Project Structure

- \`contracts/\` -- TonScript contract source files
- \`tests/\` -- Integration tests using @ton/sandbox
- \`*.boc\` -- Compiled contract files (generated by build)

## Learn More

TonScript compiles TypeScript-like syntax directly to TVM bytecode.
No FunC. No Fift. Direct compilation.
`
  );

  // Print results
  console.log(green("  Project created successfully!\n"));
  console.log(`  ${projectDir}/`);
  console.log(`  ├── contracts/`);
  console.log(`  │   └── counter.ts`);
  console.log(`  ├── tests/`);
  console.log(`  │   └── counter.test.ts`);
  console.log(`  ├── package.json`);
  console.log(`  ├── tsconfig.json`);
  console.log(`  └── README.md`);
  console.log();
  console.log(bold("  Next steps:\n"));
  console.log(dim(`    cd ${name}`));
  console.log(dim(`    npm install`));
  console.log(dim(`    npx tonscript build contracts/counter.ts`));
  console.log();
}

// ── Command: info ───────────────────────────────────────────

function cmdInfo(args: string[]): void {
  const positional = getPositionalArgs(args);
  const file = positional[0];

  if (!file) {
    console.error(red("Error: No input file specified"));
    console.error(`Usage: tonscript info <file.ts>`);
    process.exit(1);
  }

  if (!existsSync(file)) {
    console.error(red(`Error: File not found: ${file}`));
    process.exit(1);
  }

  const source = readFileSync(file, "utf-8");

  console.log(bold("\n  TonScript Contract Info\n"));
  console.log(dim(`  Source: ${file}\n`));

  try {
    // Use compileAll to get AST for all contracts (codegen is lightweight)
    // If there's only one contract, compile() also works
    const allResults = compileAll(source);
    // Get AST from the first result (all share the same AST since same source)
    const ast = allResults.values().next().value!.ast;

    // Collect messages
    const messages = ast.declarations.filter(d => d.kind === "MessageDecl");
    const contracts = ast.declarations.filter(d => d.kind === "ContractDecl");

    if (messages.length > 0) {
      console.log(bold("  Messages:"));
      for (const msg of messages) {
        if (msg.kind !== "MessageDecl") continue;
        const opcode = msg.opcode !== undefined
          ? `0x${msg.opcode.toString(16).padStart(2, "0")}`
          : `0x${(messageOpcode(msg.name) >>> 0).toString(16).padStart(8, "0")}`;
        console.log(`    ${cyan(msg.name)} ${dim(`(opcode: ${opcode})`)}`);
        for (const field of msg.fields) {
          const typeStr = formatType(field.type);
          console.log(`      ${field.name}: ${typeStr}`);
        }
      }
      console.log();
    }

    if (contracts.length === 0) {
      console.log(yellow("  No contracts found in this file.\n"));
      return;
    }

    for (const contract of contracts) {
      if (contract.kind !== "ContractDecl") continue;

      console.log(bold(`  Contract: ${contract.name}`));
      console.log();

      // Fields
      console.log(`    ${bold("Fields")} ${dim(`(${contract.fields.length})`)}:`);
      for (const field of contract.fields) {
        const typeStr = formatType(field.type);
        const defaultStr = field.defaultValue
          ? ` = ${formatExpr(field.defaultValue)}`
          : "";
        console.log(`      ${field.name}: ${cyan(typeStr)}${dim(defaultStr)}`);
      }
      console.log();

      // Receivers (messages)
      console.log(`    ${bold("Receivers")} ${dim(`(${contract.receivers.length})`)}:`);
      for (const recv of contract.receivers) {
        const msgName = recv.param.type.kind === "NamedType"
          ? recv.param.type.name
          : "?";
        // Find the message declaration to get its opcode
        const msgDecl = messages.find(m => m.kind === "MessageDecl" && m.name === msgName);
        let opcodeStr = "";
        if (msgDecl && msgDecl.kind === "MessageDecl") {
          const opcode = msgDecl.opcode !== undefined
            ? msgDecl.opcode
            : messageOpcode(msgDecl.name) >>> 0;
          opcodeStr = ` ${dim(`(opcode: 0x${opcode.toString(16)})`)}`;
        }
        console.log(`      receive(${cyan(msgName)})${opcodeStr}`);
      }
      console.log();

      // Getters
      console.log(`    ${bold("Getters")} ${dim(`(${contract.getters.length})`)}:`);
      for (const getter of contract.getters) {
        const mid = methodId(getter.name);
        const retType = getter.returnType ? `: ${formatType(getter.returnType)}` : "";
        console.log(`      get ${cyan(getter.name)}()${retType} ${dim(`(method_id: ${mid} / 0x${mid.toString(16)})`)}`);
      }
      console.log();

      // Methods
      if (contract.methods.length > 0) {
        console.log(`    ${bold("Methods")} ${dim(`(${contract.methods.length})`)}:`);
        for (const method of contract.methods) {
          const params = method.params.map(p => `${p.name}: ${formatType(p.type)}`).join(", ");
          const retType = method.returnType ? `: ${formatType(method.returnType)}` : "";
          console.log(`      ${cyan(method.name)}(${params})${retType}`);
        }
        console.log();
      }

      // Init
      if (contract.init) {
        const params = contract.init.params.map(p => `${p.name}: ${formatType(p.type)}`).join(", ");
        console.log(`    ${bold("Init")}: (${params})`);
        console.log();
      }
    }

  } catch (err: any) {
    console.error(red(`\n  Parse error: ${err.message}\n`));
    process.exit(1);
  }
}

// Helper to format types for display
function formatType(type: any): string {
  switch (type.kind) {
    case "IntType":
      return type.signed ? `int${type.bits}` : `uint${type.bits}`;
    case "BoolType":
      return "Bool";
    case "AddressType":
      return "Address";
    case "CoinsType":
      return "Coins";
    case "CellType":
      return "Cell";
    case "SliceType":
      return "Slice";
    case "BuilderType":
      return "Builder";
    case "StringType":
      return "String";
    case "MapType":
      return `Map<${formatType(type.keyType)}, ${formatType(type.valueType)}>`;
    case "NamedType":
      return type.name;
    default:
      return "?";
  }
}

function formatExpr(expr: any): string {
  switch (expr.kind) {
    case "NumberLit":
      return expr.value.toString();
    case "BoolLit":
      return expr.value ? "true" : "false";
    case "StringLit":
      return `"${expr.value}"`;
    case "NullLit":
      return "null";
    default:
      return "...";
  }
}

// ── Command: help ───────────────────────────────────────────

function printHelp(): void {
  const version = getVersion();
  console.log(`
${bold("TonScript")} v${version} -- TypeScript -> TVM bytecode ${dim("(no FunC, no Fift)")}

${bold("Usage:")}
  tonscript <command> [options]

${bold("Commands:")}
  ${cyan("build")} <file>          Compile contract(s) to .boc files
  ${cyan("info")}  <file>          Show contract info (fields, messages, getters)
  ${cyan("test")}                  Run all test files
  ${cyan("deploy")} <file>         Compile and deploy to testnet
  ${cyan("init")} [name]           Scaffold a new TonScript project

${bold("Build options:")}
  --asm                  Print TVM assembly instead of writing .boc
  --contract <name>      Compile only a specific contract
  --output <dir>         Output directory for .boc files (default: .)

${bold("Deploy options:")}
  --testnet              Deploy to TON testnet
  --contract <name>      Deploy a specific contract

${bold("Examples:")}
  tonscript build contracts/counter.ts
  tonscript build contracts/jetton.ts --contract JettonMaster
  tonscript build contracts/counter.ts --asm
  tonscript info contracts/nft.ts
  tonscript test
  tonscript deploy contracts/counter.ts --testnet
  tonscript init my-project

${bold("Run with:")}
  npx tsx src/cli.ts <command>
`);
}

// ── Main ────────────────────────────────────────────────────

const args = process.argv.slice(2);
const command = args[0];

switch (command) {
  case "build":
    cmdBuild(args.slice(1));
    break;
  case "test":
    cmdTest(args.slice(1));
    break;
  case "deploy":
    cmdDeploy(args.slice(1));
    break;
  case "init":
    cmdInit(args.slice(1));
    break;
  case "info":
    cmdInfo(args.slice(1));
    break;
  case "--help":
  case "-h":
  case "help":
    printHelp();
    break;
  case "--version":
  case "-v":
    console.log(getVersion());
    break;
  default:
    if (command && !command.startsWith("-")) {
      console.error(red(`Unknown command: ${command}\n`));
    }
    printHelp();
    if (command && command !== undefined) {
      process.exit(1);
    }
    break;
}

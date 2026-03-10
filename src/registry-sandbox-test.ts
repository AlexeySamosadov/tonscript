// ============================================================
// TonScript Registry Sandbox Integration Test
// Tests Map<K, V> type with set/delete operations
// ============================================================

import { readFileSync } from "fs";
import { Blockchain, createShardAccount } from "@ton/sandbox";
import { Cell, beginCell, toNano } from "@ton/core";
import { compile } from "./compiler.js";
import { buildContractBoc } from "./boc.js";
import { methodId, messageOpcode } from "./tvm.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => Promise<void>) {
  return fn()
    .then(() => {
      console.log(`  OK  ${name}`);
      passed++;
    })
    .catch((e: any) => {
      console.log(`  FAIL  ${name}: ${e.message}`);
      failed++;
    });
}

function assert(cond: boolean, msg?: string) {
  if (!cond) throw new Error(msg ?? "Assertion failed");
}

// Helper: build a CompileResult with filtered AST for correct data cell
function buildBocForContract(source: string, contractName: string) {
  const result = compile(source, contractName);
  const filteredAst = {
    ...result.ast,
    declarations: result.ast.declarations.filter(
      d => d.kind === "MessageDecl" || (d.kind === "ContractDecl" && d.name === contractName)
    ),
  };
  const filteredResult = { ...result, ast: filteredAst };
  return buildContractBoc(filteredResult);
}

async function main() {
  console.log("\n=== TonScript Registry Sandbox Integration Tests ===\n");

  const source = readFileSync(new URL("../examples/registry.ts", import.meta.url), "utf-8");

  // ── Step 1: Compile ────────────────────────────────────────

  const result = compile(source);
  console.log("Compiled registry.ts:");
  console.log(`  Instructions: ${result.instructions.asmFull.length}`);
  console.log(`  Getters: ${result.instructions.getters.map(g => g.name).join(", ")}`);

  // ── Step 2: Build BOC ──────────────────────────────────────

  const registryBoc = buildBocForContract(source, "Registry");

  console.log(`\nRegistry:`);
  console.log(`  Code: ${registryBoc.code.bits.length} bits, ${registryBoc.code.refs.length} refs`);
  console.log(`  Data: ${registryBoc.data.bits.length} bits`);
  console.log(`  Address: ${registryBoc.address.toString()}`);

  // Method IDs and opcodes
  const countId = methodId("count");
  const ownerId = methodId("owner");
  const setValueOpcode = messageOpcode("SetValue");
  const deleteValueOpcode = messageOpcode("DeleteValue");

  console.log(`\nMethod IDs: count=${countId}, owner=${ownerId}`);
  console.log(`Opcodes: SetValue=0x${setValueOpcode.toString(16)}, DeleteValue=0x${deleteValueOpcode.toString(16)}`);
  console.log();

  // ── Step 3: Deploy to sandbox ──────────────────────────────

  const blockchain = await Blockchain.create();
  const deployer = await blockchain.treasury("deployer");

  const addr = registryBoc.address;

  await blockchain.setShardAccount(
    addr,
    createShardAccount({
      address: addr,
      code: registryBoc.code,
      data: registryBoc.data,
      balance: toNano("1"),
    })
  );

  // ── Helpers ────────────────────────────────────────────────

  async function callGetter(method: number): Promise<bigint> {
    const res = await blockchain.runGetMethod(addr, method);
    if (res.exitCode !== 0) {
      throw new Error(`Getter exit code ${res.exitCode}\nvmLogs: ${res.vmLogs}`);
    }
    return res.stackReader.readBigNumber();
  }

  async function sendMsg(body: Cell, expectFailCode?: number): Promise<number> {
    const sendResult = await deployer.send({
      to: addr,
      value: toNano("0.05"),
      body,
    });
    const txs = sendResult.transactions;
    if (txs.length < 2) throw new Error(`Expected at least 2 txs, got ${txs.length}`);
    const contractTx = txs[1];
    const desc = contractTx.description;
    if (desc.type === "generic" && desc.computePhase.type === "vm") {
      const exitCode = desc.computePhase.exitCode;
      if (expectFailCode !== undefined) {
        return exitCode;
      }
      if (exitCode !== 0) {
        throw new Error(`Contract execution failed with exit code ${exitCode}`);
      }
      return 0;
    }
    return 0;
  }

  function buildSetValueMsg(key: bigint, value: bigint): Cell {
    return beginCell()
      .storeUint(setValueOpcode, 32)
      .storeUint(key, 256)
      .storeUint(value, 256)
      .endCell();
  }

  function buildDeleteValueMsg(key: bigint): Cell {
    return beginCell()
      .storeUint(deleteValueOpcode, 32)
      .storeUint(key, 256)
      .endCell();
  }

  // ── Tests ──────────────────────────────────────────────────

  console.log("Deployment:");

  await test("Registry deployed successfully", async () => {
    const provider = blockchain.provider(addr);
    const state = await provider.getState();
    assert(state.state.type === "active", `state should be active, got ${state.state.type}`);
  });

  await test("Initial count is 0", async () => {
    const val = await callGetter(countId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Initial owner is 0", async () => {
    const val = await callGetter(ownerId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  console.log("\nMap.set operations:");

  await test("Set first value (key=1, value=100)", async () => {
    await sendMsg(buildSetValueMsg(1n, 100n));
  });

  await test("Count is 1 after first set", async () => {
    const val = await callGetter(countId);
    assert(val === 1n, `expected 1, got ${val}`);
  });

  await test("Set second value (key=2, value=200)", async () => {
    await sendMsg(buildSetValueMsg(2n, 200n));
  });

  await test("Count is 2 after second set", async () => {
    const val = await callGetter(countId);
    assert(val === 2n, `expected 2, got ${val}`);
  });

  await test("Set third value (key=3, value=300)", async () => {
    await sendMsg(buildSetValueMsg(3n, 300n));
  });

  await test("Count is 3 after third set", async () => {
    const val = await callGetter(countId);
    assert(val === 3n, `expected 3, got ${val}`);
  });

  await test("Overwrite existing key (key=1, value=999)", async () => {
    await sendMsg(buildSetValueMsg(1n, 999n));
  });

  await test("Count is 4 after overwrite (count increments regardless)", async () => {
    const val = await callGetter(countId);
    assert(val === 4n, `expected 4, got ${val}`);
  });

  console.log("\nMap.delete operations:");

  await test("Delete key=2", async () => {
    await sendMsg(buildDeleteValueMsg(2n));
  });

  await test("Count is 3 after delete", async () => {
    const val = await callGetter(countId);
    assert(val === 3n, `expected 3, got ${val}`);
  });

  await test("Delete key=1", async () => {
    await sendMsg(buildDeleteValueMsg(1n));
  });

  await test("Count is 2 after second delete", async () => {
    const val = await callGetter(countId);
    assert(val === 2n, `expected 2, got ${val}`);
  });

  await test("Delete non-existent key=999 (still decrements count)", async () => {
    await sendMsg(buildDeleteValueMsg(999n));
  });

  await test("Count is 1 after deleting non-existent key", async () => {
    const val = await callGetter(countId);
    assert(val === 1n, `expected 1, got ${val}`);
  });

  console.log("\nSet after delete:");

  await test("Set new value after deletes (key=10, value=42)", async () => {
    await sendMsg(buildSetValueMsg(10n, 42n));
  });

  await test("Count is 2 after set following deletes", async () => {
    const val = await callGetter(countId);
    assert(val === 2n, `expected 2, got ${val}`);
  });

  console.log("\nLarge key operations:");

  await test("Set with large key (key=2^255, value=777)", async () => {
    const largeKey = (1n << 255n);
    await sendMsg(buildSetValueMsg(largeKey, 777n));
  });

  await test("Count is 3 after large key set", async () => {
    const val = await callGetter(countId);
    assert(val === 3n, `expected 3, got ${val}`);
  });

  await test("Delete large key (key=2^255)", async () => {
    const largeKey = (1n << 255n);
    await sendMsg(buildDeleteValueMsg(largeKey));
  });

  await test("Count is 2 after deleting large key", async () => {
    const val = await callGetter(countId);
    assert(val === 2n, `expected 2, got ${val}`);
  });

  console.log("\nMultiple rapid operations:");

  await test("Rapid set: keys 100..104", async () => {
    for (let i = 100n; i <= 104n; i++) {
      await sendMsg(buildSetValueMsg(i, i * 10n));
    }
  });

  await test("Count is 7 after rapid sets (2 + 5)", async () => {
    const val = await callGetter(countId);
    assert(val === 7n, `expected 7, got ${val}`);
  });

  await test("Rapid delete: keys 100..102", async () => {
    for (let i = 100n; i <= 102n; i++) {
      await sendMsg(buildDeleteValueMsg(i));
    }
  });

  await test("Count is 4 after rapid deletes (7 - 3)", async () => {
    const val = await callGetter(countId);
    assert(val === 4n, `expected 4, got ${val}`);
  });

  console.log("\nOwner getter:");

  await test("Owner getter still works (returns 0)", async () => {
    const val = await callGetter(ownerId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  // ── Summary ────────────────────────────────────────────────

  console.log(`\n=== Registry Sandbox Results: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

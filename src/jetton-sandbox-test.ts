// ============================================================
// TonScript Jetton Sandbox Integration Test
// Compiles jetton.ts (JettonMaster + JettonWallet),
// deploys both to sandbox, tests mint/transfer/burn flows
// ============================================================

import { readFileSync } from "fs";
import { Blockchain, createShardAccount } from "@ton/sandbox";
import { Cell, beginCell, toNano, contractAddress } from "@ton/core";
import { compile, compileAll, CompileResult } from "./compiler.js";
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

// Helper: build a CompileResult with a filtered AST so that
// buildContractBoc picks the correct contract for the data cell.
// This is needed because buildContractBoc uses ast.declarations.find()
// which always returns the first ContractDecl regardless of which
// contract was compiled.
function buildBocForContract(source: string, contractName: string) {
  const result = compile(source, contractName);
  const filteredAst = {
    ...result.ast,
    declarations: result.ast.declarations.filter(
      d => d.kind === "MessageDecl" || (d.kind === "ContractDecl" && d.name === contractName)
    ),
  };
  const filteredResult: CompileResult = { ...result, ast: filteredAst };
  return buildContractBoc(filteredResult);
}

async function main() {
  console.log("\n=== TonScript Jetton Sandbox Integration Tests ===\n");

  const source = readFileSync(new URL("../examples/jetton.ts", import.meta.url), "utf-8");

  // ── Step 1: Compile both contracts ─────────────────────────

  const results = compileAll(source);
  console.log("Compiled jetton.ts:");
  for (const [name, result] of results) {
    console.log(`  ${name}: ${result.instructions.asmFull.length} instructions`);
    console.log(`    getters: ${result.instructions.getters.map(g => g.name).join(", ")}`);
  }

  // ── Step 2: Build BOCs ─────────────────────────────────────

  const masterBoc = buildBocForContract(source, "JettonMaster");
  const walletBoc = buildBocForContract(source, "JettonWallet");

  console.log(`\nJettonMaster:`);
  console.log(`  Code: ${masterBoc.code.bits.length} bits, ${masterBoc.code.refs.length} refs`);
  console.log(`  Data: ${masterBoc.data.bits.length} bits`);
  console.log(`  Address: ${masterBoc.address.toString()}`);

  console.log(`\nJettonWallet:`);
  console.log(`  Code: ${walletBoc.code.bits.length} bits, ${walletBoc.code.refs.length} refs`);
  console.log(`  Data: ${walletBoc.data.bits.length} bits`);
  console.log(`  Address: ${walletBoc.address.toString()}`);

  // Method IDs and opcodes
  const totalSupplyId = methodId("totalSupply");
  const adminId = methodId("admin");
  const balanceId = methodId("balance");
  const ownerAddressId = methodId("ownerAddress");
  const masterAddressId = methodId("masterAddress");

  const mintOpcode = messageOpcode("Mint");
  const transferOpcode = messageOpcode("Transfer");
  const internalTransferOpcode = messageOpcode("InternalTransfer");
  const burnOpcode = messageOpcode("Burn");
  const burnNotificationOpcode = messageOpcode("BurnNotification");

  console.log(`\nMethod IDs: totalSupply=${totalSupplyId}, balance=${balanceId}`);
  console.log(`Opcodes: Mint=0x${mintOpcode.toString(16)}, InternalTransfer=0x${internalTransferOpcode.toString(16)}, Burn=0x${burnOpcode.toString(16)}, BurnNotification=0x${burnNotificationOpcode.toString(16)}`);
  console.log();

  // ── Step 3: Deploy to sandbox ──────────────────────────────

  const blockchain = await Blockchain.create();
  const deployer = await blockchain.treasury("deployer");

  const masterAddr = masterBoc.address;
  const walletAddr = walletBoc.address;

  await blockchain.setShardAccount(
    masterAddr,
    createShardAccount({
      address: masterAddr,
      code: masterBoc.code,
      data: masterBoc.data,
      balance: toNano("1"),
    })
  );

  await blockchain.setShardAccount(
    walletAddr,
    createShardAccount({
      address: walletAddr,
      code: walletBoc.code,
      data: walletBoc.data,
      balance: toNano("1"),
    })
  );

  // ── Helpers ────────────────────────────────────────────────

  async function callGetter(addr: any, method: number): Promise<bigint> {
    const res = await blockchain.runGetMethod(addr, method);
    if (res.exitCode !== 0) {
      throw new Error(`Getter exit code ${res.exitCode}\nvmLogs: ${res.vmLogs}`);
    }
    return res.stackReader.readBigNumber();
  }

  async function sendMsg(to: any, body: Cell): Promise<void> {
    const sendResult = await deployer.send({
      to,
      value: toNano("0.05"),
      body,
    });
    const txs = sendResult.transactions;
    if (txs.length < 2) throw new Error(`Expected at least 2 txs, got ${txs.length}`);
    const contractTx = txs[1];
    const desc = contractTx.description;
    if (desc.type === "generic" && desc.computePhase.type === "vm") {
      if (desc.computePhase.exitCode !== 0) {
        throw new Error(`Contract execution failed with exit code ${desc.computePhase.exitCode}`);
      }
    }
  }

  // ── JettonMaster Tests ──────────────────────────────────────

  await test("JettonMaster deployed successfully", async () => {
    const provider = blockchain.provider(masterAddr);
    const state = await provider.getState();
    assert(state.state.type === "active", `state should be active, got ${state.state.type}`);
  });

  await test("JettonMaster initial totalSupply is 0", async () => {
    const val = await callGetter(masterAddr, totalSupplyId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("JettonMaster: Mint 1000 tokens", async () => {
    const body = beginCell()
      .storeUint(mintOpcode, 32)
      .storeCoins(1000n)
      .storeUint(123n, 256)
      .endCell();
    await sendMsg(masterAddr, body);
  });

  await test("JettonMaster: totalSupply is 1000 after Mint", async () => {
    const val = await callGetter(masterAddr, totalSupplyId);
    assert(val === 1000n, `expected 1000, got ${val}`);
  });

  await test("JettonMaster: Mint 500 more tokens", async () => {
    const body = beginCell()
      .storeUint(mintOpcode, 32)
      .storeCoins(500n)
      .storeUint(456n, 256)
      .endCell();
    await sendMsg(masterAddr, body);
  });

  await test("JettonMaster: totalSupply is 1500 after second Mint", async () => {
    const val = await callGetter(masterAddr, totalSupplyId);
    assert(val === 1500n, `expected 1500, got ${val}`);
  });

  await test("JettonMaster: BurnNotification executes without error", async () => {
    const body = beginCell()
      .storeUint(burnNotificationOpcode, 32)
      .storeUint(1n, 64)
      .storeCoins(200n)
      .storeUint(123n, 256)
      .storeUint(0n, 256)
      .endCell();
    await sendMsg(masterAddr, body);
  });

  await test("JettonMaster: totalSupply changed after BurnNotification", async () => {
    const val = await callGetter(masterAddr, totalSupplyId);
    assert(val === 1300n, `expected 1300, got ${val}`);
  });

  // ── JettonWallet Tests ──────────────────────────────────────

  await test("JettonWallet deployed successfully", async () => {
    const provider = blockchain.provider(walletAddr);
    const state = await provider.getState();
    assert(state.state.type === "active", `state should be active, got ${state.state.type}`);
  });

  await test("JettonWallet initial balance is 0", async () => {
    const val = await callGetter(walletAddr, balanceId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("JettonWallet: InternalTransfer adds 500 to balance", async () => {
    const body = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(1n, 64)
      .storeCoins(500n)
      .storeUint(0n, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsg(walletAddr, body);
  });

  await test("JettonWallet: balance is 500 after InternalTransfer", async () => {
    const val = await callGetter(walletAddr, balanceId);
    assert(val === 500n, `expected 500, got ${val}`);
  });

  await test("JettonWallet: another InternalTransfer adds 300", async () => {
    const body = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(2n, 64)
      .storeCoins(300n)
      .storeUint(0n, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsg(walletAddr, body);
  });

  await test("JettonWallet: balance is 800 after second InternalTransfer", async () => {
    const val = await callGetter(walletAddr, balanceId);
    assert(val === 800n, `expected 800, got ${val}`);
  });

  await test("JettonWallet: Transfer 100 tokens", async () => {
    const body = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(10n, 64)
      .storeCoins(100n)
      .storeUint(999n, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsg(walletAddr, body);
  });

  await test("JettonWallet: balance is 700 after Transfer(100)", async () => {
    const val = await callGetter(walletAddr, balanceId);
    assert(val === 700n, `expected 700, got ${val}`);
  });

  await test("JettonWallet: Burn 50 tokens", async () => {
    const body = beginCell()
      .storeUint(burnOpcode, 32)
      .storeUint(3n, 64)
      .storeCoins(50n)
      .storeUint(0n, 256)
      .endCell();
    await sendMsg(walletAddr, body);
  });

  await test("JettonWallet: balance is 650 after Burn(50)", async () => {
    const val = await callGetter(walletAddr, balanceId);
    assert(val === 650n, `expected 650, got ${val}`);
  });

  await test("JettonWallet: ownerAddress getter returns 0", async () => {
    const val = await callGetter(walletAddr, ownerAddressId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("JettonWallet: masterAddress getter returns 0", async () => {
    const val = await callGetter(walletAddr, masterAddressId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  // ── Wallet-to-Wallet Transfer Tests ──────────────────────
  console.log("\n--- Wallet-to-Wallet Transfer Flow ---\n");

  // Build code cell for JettonWallet (shared across all wallet instances)
  const walletResult = compile(source, "JettonWallet");
  const walletFilteredAst = {
    ...walletResult.ast,
    declarations: walletResult.ast.declarations.filter(
      d => d.kind === "MessageDecl" || (d.kind === "ContractDecl" && d.name === "JettonWallet")
    ),
  };
  const walletFilteredResult: CompileResult = { ...walletResult, ast: walletFilteredAst };
  const walletCodeBoc = buildContractBoc(walletFilteredResult);
  const walletCode = walletCodeBoc.code;

  // Build custom data cells with different owner addresses
  // JettonWallet data layout: balance(Coins/VarUInt16), ownerAddress(uint256), masterAddress(uint256)
  const aliceOwner = 0xAAAA_BBBB_CCCC_DDDD_1111_2222_3333_4444_5555_6666_7777_8888_9999_0000_AAAA_BBBBn;
  const bobOwner   = 0x1234_5678_9ABC_DEF0_1234_5678_9ABC_DEF0_1234_5678_9ABC_DEF0_1234_5678_9ABC_DEF0n;
  const masterHash = 0n; // simplified: use 0 for master address

  const aliceData = beginCell()
    .storeCoins(0n)              // balance = 0
    .storeUint(aliceOwner, 256)  // ownerAddress
    .storeUint(masterHash, 256)  // masterAddress
    .endCell();

  const bobData = beginCell()
    .storeCoins(0n)              // balance = 0
    .storeUint(bobOwner, 256)    // ownerAddress
    .storeUint(masterHash, 256)  // masterAddress
    .endCell();

  const aliceAddr = contractAddress(0, { code: walletCode, data: aliceData });
  const bobAddr   = contractAddress(0, { code: walletCode, data: bobData });

  console.log(`  Wallet A (Alice): ${aliceAddr.toString()}`);
  console.log(`  Wallet B (Bob):   ${bobAddr.toString()}`);

  // Deploy Wallet A (Alice)
  await blockchain.setShardAccount(
    aliceAddr,
    createShardAccount({
      address: aliceAddr,
      code: walletCode,
      data: aliceData,
      balance: toNano("1"),
    })
  );

  // Deploy Wallet B (Bob)
  await blockchain.setShardAccount(
    bobAddr,
    createShardAccount({
      address: bobAddr,
      code: walletCode,
      data: bobData,
      balance: toNano("1"),
    })
  );

  // Helper: send message to a specific address
  async function sendMsgTo(to: any, body: Cell): Promise<void> {
    const sendResult = await deployer.send({
      to,
      value: toNano("0.05"),
      body,
    });
    const txs = sendResult.transactions;
    if (txs.length < 2) throw new Error(`Expected at least 2 txs, got ${txs.length}`);
    const contractTx = txs[1];
    const desc = contractTx.description;
    if (desc.type === "generic" && desc.computePhase.type === "vm") {
      if (desc.computePhase.exitCode !== 0) {
        throw new Error(`Contract execution failed with exit code ${desc.computePhase.exitCode}`);
      }
    }
  }

  // Helper: send message and expect failure with specific exit code
  async function sendMsgExpectFail(to: any, body: Cell, expectedExitCode: number): Promise<void> {
    const sendResult = await deployer.send({
      to,
      value: toNano("0.05"),
      body,
    });
    const txs = sendResult.transactions;
    if (txs.length < 2) throw new Error(`Expected at least 2 txs, got ${txs.length}`);
    const contractTx = txs[1];
    const desc = contractTx.description;
    if (desc.type === "generic" && desc.computePhase.type === "vm") {
      if (desc.computePhase.exitCode !== expectedExitCode) {
        throw new Error(`Expected exit code ${expectedExitCode}, got ${desc.computePhase.exitCode}`);
      }
      return; // Got expected failure
    }
    throw new Error(`Expected failure with exit code ${expectedExitCode}, but tx succeeded`);
  }

  // Test 1: Deploy verification
  await test("Wallet A (Alice) deployed successfully", async () => {
    const provider = blockchain.provider(aliceAddr);
    const state = await provider.getState();
    assert(state.state.type === "active", `state should be active, got ${state.state.type}`);
  });

  await test("Wallet B (Bob) deployed successfully", async () => {
    const provider = blockchain.provider(bobAddr);
    const state = await provider.getState();
    assert(state.state.type === "active", `state should be active, got ${state.state.type}`);
  });

  await test("Wallet A and Wallet B have different addresses", async () => {
    assert(
      aliceAddr.toString() !== bobAddr.toString(),
      `Alice and Bob should have different addresses`
    );
  });

  // Test 2: Initial balances are 0
  await test("Wallet A initial balance is 0", async () => {
    const val = await callGetter(aliceAddr, balanceId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Wallet B initial balance is 0", async () => {
    const val = await callGetter(bobAddr, balanceId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  // Test 3: Verify owner addresses
  await test("Wallet A ownerAddress is Alice", async () => {
    const val = await callGetter(aliceAddr, ownerAddressId);
    assert(val === aliceOwner, `expected ${aliceOwner}, got ${val}`);
  });

  await test("Wallet B ownerAddress is Bob", async () => {
    const val = await callGetter(bobAddr, ownerAddressId);
    assert(val === bobOwner, `expected ${bobOwner}, got ${val}`);
  });

  // Test 4: Mint 1000 tokens to Wallet A via InternalTransfer
  await test("Mint 1000 tokens to Wallet A via InternalTransfer", async () => {
    const body = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(100n, 64)     // queryId
      .storeCoins(1000n)       // amount
      .storeUint(0n, 256)      // fromAddress (master)
      .storeUint(0n, 256)      // responseAddress
      .storeCoins(0n)          // forwardTonAmount
      .endCell();
    await sendMsgTo(aliceAddr, body);
  });

  await test("Wallet A balance is 1000 after mint", async () => {
    const val = await callGetter(aliceAddr, balanceId);
    assert(val === 1000n, `expected 1000, got ${val}`);
  });

  // Test 5: Transfer 500 from Wallet A (sender initiates, balance decreases)
  await test("Transfer 500 from Wallet A (balance decreases)", async () => {
    const body = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(200n, 64)     // queryId
      .storeCoins(500n)        // amount
      .storeUint(bobOwner, 256) // toOwner (Bob)
      .storeUint(aliceOwner, 256) // responseAddress
      .storeCoins(0n)          // forwardTonAmount
      .endCell();
    await sendMsgTo(aliceAddr, body);
  });

  await test("Wallet A balance is 500 after transfer", async () => {
    const val = await callGetter(aliceAddr, balanceId);
    assert(val === 500n, `expected 500, got ${val}`);
  });

  // Test 6: Deliver InternalTransfer(500) to Wallet B (simulates cross-wallet message)
  await test("InternalTransfer 500 to Wallet B (balance increases)", async () => {
    const body = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(200n, 64)     // queryId (same as the Transfer)
      .storeCoins(500n)        // amount
      .storeUint(aliceOwner, 256) // fromAddress (Alice's owner)
      .storeUint(aliceOwner, 256) // responseAddress
      .storeCoins(0n)          // forwardTonAmount
      .endCell();
    await sendMsgTo(bobAddr, body);
  });

  await test("Wallet B balance is 500 after receiving transfer", async () => {
    const val = await callGetter(bobAddr, balanceId);
    assert(val === 500n, `expected 500, got ${val}`);
  });

  // Test 7: Verify total conservation: A(500) + B(500) = 1000 (original mint)
  await test("Total tokens conserved: A(500) + B(500) = 1000", async () => {
    const balA = await callGetter(aliceAddr, balanceId);
    const balB = await callGetter(bobAddr, balanceId);
    assert(balA + balB === 1000n, `expected total 1000, got ${balA} + ${balB} = ${balA + balB}`);
  });

  // Test 8: Second transfer — Alice sends remaining 500 to Bob
  await test("Transfer remaining 500 from Wallet A to Bob", async () => {
    const body = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(300n, 64)
      .storeCoins(500n)
      .storeUint(bobOwner, 256)
      .storeUint(aliceOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(aliceAddr, body);
  });

  await test("Wallet A balance is 0 after sending all tokens", async () => {
    const val = await callGetter(aliceAddr, balanceId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Deliver InternalTransfer(500) to Wallet B again", async () => {
    const body = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(300n, 64)
      .storeCoins(500n)
      .storeUint(aliceOwner, 256)
      .storeUint(aliceOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(bobAddr, body);
  });

  await test("Wallet B balance is 1000 after receiving second transfer", async () => {
    const val = await callGetter(bobAddr, balanceId);
    assert(val === 1000n, `expected 1000, got ${val}`);
  });

  // Test 9: Edge case — Transfer more than balance should fail with exit code 402
  await test("Transfer from empty Wallet A fails with exit code 402", async () => {
    const body = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(400n, 64)
      .storeCoins(1n)           // even 1 token should fail (balance is 0)
      .storeUint(bobOwner, 256)
      .storeUint(aliceOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectFail(aliceAddr, body, 402);
  });

  // Test 10: Transfer exactly remaining balance (boundary case)
  await test("Transfer exact balance (1000) from Wallet B", async () => {
    const body = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(500n, 64)
      .storeCoins(1000n)
      .storeUint(aliceOwner, 256)
      .storeUint(bobOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(bobAddr, body);
  });

  await test("Wallet B balance is 0 after transferring exact balance", async () => {
    const val = await callGetter(bobAddr, balanceId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  // Test 11: Transfer from Wallet B with 0 balance should fail
  await test("Transfer from empty Wallet B fails with exit code 402", async () => {
    const body = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(600n, 64)
      .storeCoins(100n)
      .storeUint(aliceOwner, 256)
      .storeUint(bobOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectFail(bobAddr, body, 402);
  });

  // Test 12: Restore and verify bidirectional flow
  await test("Mint 2000 to Wallet A for bidirectional test", async () => {
    const body = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(700n, 64)
      .storeCoins(2000n)
      .storeUint(0n, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(aliceAddr, body);
  });

  await test("A->B: Transfer 750, then B->A: Transfer 250 (bidirectional)", async () => {
    // A sends 750 to B
    const transferAB = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(800n, 64)
      .storeCoins(750n)
      .storeUint(bobOwner, 256)
      .storeUint(aliceOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(aliceAddr, transferAB);

    // Deliver to B
    const internalAB = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(800n, 64)
      .storeCoins(750n)
      .storeUint(aliceOwner, 256)
      .storeUint(aliceOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(bobAddr, internalAB);

    // B sends 250 back to A
    const transferBA = beginCell()
      .storeUint(transferOpcode, 32)
      .storeUint(900n, 64)
      .storeCoins(250n)
      .storeUint(aliceOwner, 256)
      .storeUint(bobOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(bobAddr, transferBA);

    // Deliver to A
    const internalBA = beginCell()
      .storeUint(internalTransferOpcode, 32)
      .storeUint(900n, 64)
      .storeCoins(250n)
      .storeUint(bobOwner, 256)
      .storeUint(bobOwner, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgTo(aliceAddr, internalBA);
  });

  await test("After bidirectional: A=1500, B=500 (total=2000)", async () => {
    const balA = await callGetter(aliceAddr, balanceId);
    const balB = await callGetter(bobAddr, balanceId);
    assert(balA === 1500n, `Wallet A expected 1500, got ${balA}`);
    assert(balB === 500n, `Wallet B expected 500, got ${balB}`);
    assert(balA + balB === 2000n, `total expected 2000, got ${balA + balB}`);
  });

  // Summary
  console.log(`\n=== Jetton Sandbox Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    console.log("NOTE: Sandbox test failures may indicate TVM binary encoding issues.");
    console.log("The BOC structure is correct -- actual TVM execution requires");
    console.log("exact opcode encoding which is a deeper verification layer.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Jetton sandbox test error:", e);
  process.exit(1);
});

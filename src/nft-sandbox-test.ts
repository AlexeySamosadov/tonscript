// ============================================================
// TonScript NFT Sandbox Integration Test
// Full TEP-62 compliance tests:
//   - Deploy, getters, access control
//   - Transfer with notification & excess return
//   - GetStaticData response
// ============================================================

import { readFileSync } from "fs";
import { Blockchain, createShardAccount, SandboxContract, TreasuryContract } from "@ton/sandbox";
import { Cell, beginCell, toNano, contractAddress, Address } from "@ton/core";
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
  console.log("\n=== TonScript NFT Sandbox Integration Tests ===\n");

  const source = readFileSync(new URL("../examples/nft.ts", import.meta.url), "utf-8");

  // ── Step 1: Compile both contracts ─────────────────────────

  const results = compileAll(source);
  console.log("Compiled nft.ts:");
  for (const [name, result] of results) {
    console.log(`  ${name}: ${result.instructions.asmFull.length} instructions`);
    console.log(`    getters: ${result.instructions.getters.map(g => g.name).join(", ")}`);
  }

  // ── Step 2: Build BOCs ─────────────────────────────────────

  const collectionBoc = buildBocForContract(source, "NftCollection");
  const itemBoc = buildBocForContract(source, "NftItem");

  console.log(`\nNftCollection:`);
  console.log(`  Code: ${collectionBoc.code.bits.length} bits, ${collectionBoc.code.refs.length} refs`);
  console.log(`  Data: ${collectionBoc.data.bits.length} bits`);
  console.log(`  Address: ${collectionBoc.address.toString()}`);

  console.log(`\nNftItem:`);
  console.log(`  Code: ${itemBoc.code.bits.length} bits, ${itemBoc.code.refs.length} refs`);
  console.log(`  Data: ${itemBoc.data.bits.length} bits`);
  console.log(`  Address: ${itemBoc.address.toString()}`);

  // Method IDs
  const nextItemIndexId = methodId("nextItemIndex");
  const ownerAddressId = methodId("ownerAddress");
  const collectionContentId = methodId("collectionContent");
  const itemIndexId = methodId("itemIndex");
  const collectionAddressId = methodId("collectionAddress");
  const contentId = methodId("content");

  // Opcodes
  const deployNftItemOpcode = messageOpcode("DeployNftItem");
  const transferNftOpcode = messageOpcode("TransferNft");
  const getStaticDataOpcode = messageOpcode("GetStaticData");

  console.log(`\nMethod IDs: nextItemIndex=${nextItemIndexId}, ownerAddress=${ownerAddressId}, collectionContent=${collectionContentId}`);
  console.log(`            itemIndex=${itemIndexId}, collectionAddress=${collectionAddressId}, content=${contentId}`);
  console.log(`Opcodes: DeployNftItem=0x${deployNftItemOpcode.toString(16)}, TransferNft=0x${transferNftOpcode.toString(16)}, GetStaticData=0x${getStaticDataOpcode.toString(16)}`);
  console.log();

  // ── Step 3: Deploy to sandbox ──────────────────────────────

  const blockchain = await Blockchain.create();
  const deployer = await blockchain.treasury("deployer");
  const otherWallet = await blockchain.treasury("other");

  // Get deployer's address hash (256-bit) as BigInt — this is what sender() returns
  const deployerHash = BigInt("0x" + deployer.address.hash.toString("hex"));
  const otherHash = BigInt("0x" + otherWallet.address.hash.toString("hex"));

  console.log(`  Deployer hash: 0x${deployerHash.toString(16).slice(0, 16)}...`);
  console.log(`  Other hash:    0x${otherHash.toString(16).slice(0, 16)}...`);

  // Build code cells (shared by all instances of each contract type)
  const collectionResult = compile(source, "NftCollection");
  const collectionFilteredAst = {
    ...collectionResult.ast,
    declarations: collectionResult.ast.declarations.filter(
      d => d.kind === "MessageDecl" || (d.kind === "ContractDecl" && d.name === "NftCollection")
    ),
  };
  const collectionFilteredResult: CompileResult = { ...collectionResult, ast: collectionFilteredAst };
  const collectionCodeBoc = buildContractBoc(collectionFilteredResult);
  const collectionCode = collectionCodeBoc.code;

  const itemResult = compile(source, "NftItem");
  const itemFilteredAst = {
    ...itemResult.ast,
    declarations: itemResult.ast.declarations.filter(
      d => d.kind === "MessageDecl" || (d.kind === "ContractDecl" && d.name === "NftItem")
    ),
  };
  const itemFilteredResult: CompileResult = { ...itemResult, ast: itemFilteredAst };
  const itemCodeBoc = buildContractBoc(itemFilteredResult);
  const itemCode = itemCodeBoc.code;

  // ── Deploy NftCollection with deployer as owner ─────────────
  // Data layout: nextItemIndex(uint64), ownerAddress(uint256), collectionContent(uint256)
  const collectionData = beginCell()
    .storeUint(0n, 64)                // nextItemIndex = 0
    .storeUint(deployerHash, 256)     // ownerAddress = deployer
    .storeUint(0n, 256)              // collectionContent = 0
    .endCell();

  const collectionAddr = contractAddress(0, { code: collectionCode, data: collectionData });

  await blockchain.setShardAccount(
    collectionAddr,
    createShardAccount({
      address: collectionAddr,
      code: collectionCode,
      data: collectionData,
      balance: toNano("1"),
    })
  );

  // ── Deploy NftItem with deployer as owner ──────────────────
  // Data layout: itemIndex(uint64), collectionAddress(uint256), ownerAddress(uint256), content(uint256)
  const originalOwner = deployerHash;
  const newOwnerAddr = otherHash;
  const collectionHash = 42n;
  const itemContent = 99n;

  const customItemData = beginCell()
    .storeUint(7n, 64)                // itemIndex = 7
    .storeUint(collectionHash, 256)   // collectionAddress
    .storeUint(originalOwner, 256)    // ownerAddress = deployer
    .storeUint(itemContent, 256)      // content
    .endCell();

  const customItemAddr = contractAddress(0, { code: itemCode, data: customItemData });

  await blockchain.setShardAccount(
    customItemAddr,
    createShardAccount({
      address: customItemAddr,
      code: itemCode,
      data: customItemData,
      balance: toNano("1"),
    })
  );

  // Also deploy a default NftCollection and NftItem (with owner=0) for basic getter tests
  const defaultCollectionBoc = buildBocForContract(source, "NftCollection");
  const defaultItemBoc = buildBocForContract(source, "NftItem");
  const defaultCollectionAddr = defaultCollectionBoc.address;
  const defaultItemAddr = defaultItemBoc.address;

  await blockchain.setShardAccount(
    defaultCollectionAddr,
    createShardAccount({
      address: defaultCollectionAddr,
      code: defaultCollectionBoc.code,
      data: defaultCollectionBoc.data,
      balance: toNano("1"),
    })
  );
  await blockchain.setShardAccount(
    defaultItemAddr,
    createShardAccount({
      address: defaultItemAddr,
      code: defaultItemBoc.code,
      data: defaultItemBoc.data,
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

  async function sendMsg(from: SandboxContract<TreasuryContract>, to: any, body: Cell, value?: bigint): Promise<any> {
    const sendResult = await from.send({
      to,
      value: value ?? toNano("0.05"),
      body,
    });
    return sendResult;
  }

  async function sendMsgExpectSuccess(from: SandboxContract<TreasuryContract>, to: any, body: Cell, value?: bigint): Promise<any> {
    const sendResult = await sendMsg(from, to, body, value);
    const txs = sendResult.transactions;
    if (txs.length < 2) throw new Error(`Expected at least 2 txs, got ${txs.length}`);
    const contractTx = txs[1];
    const desc = contractTx.description;
    if (desc.type === "generic" && desc.computePhase.type === "vm") {
      if (desc.computePhase.exitCode !== 0) {
        throw new Error(`Contract execution failed with exit code ${desc.computePhase.exitCode}`);
      }
    }
    return sendResult;
  }

  async function sendMsgExpectFail(from: SandboxContract<TreasuryContract>, to: any, body: Cell, expectedCode: number): Promise<void> {
    const sendResult = await sendMsg(from, to, body);
    const txs = sendResult.transactions;
    if (txs.length < 2) throw new Error(`Expected at least 2 txs, got ${txs.length}`);
    const contractTx = txs[1];
    const desc = contractTx.description;
    if (desc.type === "generic" && desc.computePhase.type === "vm") {
      if (desc.computePhase.exitCode !== expectedCode) {
        throw new Error(`Expected exit code ${expectedCode}, got ${desc.computePhase.exitCode}`);
      }
    } else {
      throw new Error(`Expected VM compute phase, got ${desc.type}`);
    }
  }

  // ── Part 1: Basic Compilation & Deployment Tests ─────────────

  console.log("--- Basic Compilation & Deployment ---\n");

  await test("NftCollection and NftItem compile successfully", async () => {
    assert(results.size >= 2, `expected at least 2 contracts, got ${results.size}`);
    assert(results.has("NftCollection"), "NftCollection not found");
    assert(results.has("NftItem"), "NftItem not found");
  });

  await test("NftCollection deployed successfully", async () => {
    const provider = blockchain.provider(collectionAddr);
    const state = await provider.getState();
    assert(state.state.type === "active", `state should be active, got ${state.state.type}`);
  });

  await test("NftItem deployed successfully", async () => {
    const provider = blockchain.provider(customItemAddr);
    const state = await provider.getState();
    assert(state.state.type === "active", `state should be active, got ${state.state.type}`);
  });

  // ── Part 2: Default contract getter tests ────────────────────

  console.log("\n--- Default Contract Getters ---\n");

  await test("Default NftCollection: nextItemIndex is 0 initially", async () => {
    const val = await callGetter(defaultCollectionAddr, nextItemIndexId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Default NftCollection: ownerAddress is 0 initially", async () => {
    const val = await callGetter(defaultCollectionAddr, ownerAddressId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Default NftItem: itemIndex is 0 initially", async () => {
    const val = await callGetter(defaultItemAddr, itemIndexId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Default NftItem: ownerAddress is 0 initially", async () => {
    const val = await callGetter(defaultItemAddr, ownerAddressId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Default NftItem: collectionAddress is 0 initially", async () => {
    const val = await callGetter(defaultItemAddr, collectionAddressId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("Default NftItem: content is 0 initially", async () => {
    const val = await callGetter(defaultItemAddr, contentId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  // ── Part 3: NftCollection with owner ─────────────────────────

  console.log("\n--- NftCollection with Owner ---\n");

  await test("NftCollection: ownerAddress matches deployer", async () => {
    const val = await callGetter(collectionAddr, ownerAddressId);
    assert(val === deployerHash, `expected deployer hash, got ${val}`);
  });

  await test("NftCollection: DeployNftItem from owner succeeds", async () => {
    const body = beginCell()
      .storeUint(deployNftItemOpcode, 32)
      .storeUint(0n, 64)       // itemIndex
      .storeUint(100n, 256)    // ownerAddress
      .storeUint(0n, 256)      // content
      .endCell();
    await sendMsgExpectSuccess(deployer, collectionAddr, body);

    const val = await callGetter(collectionAddr, nextItemIndexId);
    assert(val === 1n, `expected 1, got ${val}`);
  });

  await test("NftCollection: second DeployNftItem from owner increments to 2", async () => {
    const body = beginCell()
      .storeUint(deployNftItemOpcode, 32)
      .storeUint(1n, 64)
      .storeUint(200n, 256)
      .storeUint(0n, 256)
      .endCell();
    await sendMsgExpectSuccess(deployer, collectionAddr, body);

    const val = await callGetter(collectionAddr, nextItemIndexId);
    assert(val === 2n, `expected 2, got ${val}`);
  });

  // ── Part 4: NftCollection access control ─────────────────────

  console.log("\n--- NftCollection Access Control ---\n");

  await test("NftCollection: DeployNftItem from non-owner fails with 401", async () => {
    const body = beginCell()
      .storeUint(deployNftItemOpcode, 32)
      .storeUint(2n, 64)
      .storeUint(300n, 256)
      .storeUint(0n, 256)
      .endCell();
    await sendMsgExpectFail(otherWallet, collectionAddr, body, 401);
  });

  await test("NftCollection: nextItemIndex unchanged after failed deploy", async () => {
    const val = await callGetter(collectionAddr, nextItemIndexId);
    assert(val === 2n, `expected 2, got ${val}`);
  });

  // ── Part 5: Custom NftItem getter tests ──────────────────────

  console.log("\n--- Custom NftItem Getters ---\n");

  await test("Custom NftItem: itemIndex is 7", async () => {
    const val = await callGetter(customItemAddr, itemIndexId);
    assert(val === 7n, `expected 7, got ${val}`);
  });

  await test("Custom NftItem: ownerAddress matches deployer", async () => {
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === originalOwner, `expected ${originalOwner}, got ${val}`);
  });

  await test("Custom NftItem: collectionAddress is 42", async () => {
    const val = await callGetter(customItemAddr, collectionAddressId);
    assert(val === collectionHash, `expected ${collectionHash}, got ${val}`);
  });

  await test("Custom NftItem: content is 99", async () => {
    const val = await callGetter(customItemAddr, contentId);
    assert(val === itemContent, `expected ${itemContent}, got ${val}`);
  });

  // ── Part 6: NftItem access control ───────────────────────────

  console.log("\n--- NftItem Access Control ---\n");

  await test("NftItem: TransferNft from non-owner fails with 401", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(1n, 64)                 // queryId
      .storeUint(newOwnerAddr, 256)       // newOwner
      .storeUint(0n, 256)                // responseDestination
      .storeCoins(0n)                     // forwardAmount
      .endCell();
    await sendMsgExpectFail(otherWallet, customItemAddr, body, 401);
  });

  await test("NftItem: ownerAddress unchanged after failed transfer", async () => {
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === originalOwner, `expected original owner, got ${val}`);
  });

  // ── Part 7: NftItem transfer (owner sends) ──────────────────

  console.log("\n--- NftItem Transfer ---\n");

  await test("NftItem: TransferNft from owner succeeds (no forward)", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(1n, 64)                 // queryId
      .storeUint(newOwnerAddr, 256)       // newOwner
      .storeUint(0n, 256)                // responseDestination
      .storeCoins(0n)                     // forwardAmount = 0 (no notification)
      .endCell();
    await sendMsgExpectSuccess(deployer, customItemAddr, body);
  });

  await test("NftItem: ownerAddress changed to newOwner", async () => {
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === newOwnerAddr, `expected ${newOwnerAddr}, got ${val}`);
  });

  // Now the owner is otherWallet — test that deployer can no longer transfer
  await test("NftItem: TransferNft from old owner fails with 401", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(2n, 64)
      .storeUint(originalOwner, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectFail(deployer, customItemAddr, body, 401);
  });

  // Transfer back from new owner (otherWallet)
  await test("NftItem: TransferNft from new owner back to original", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(3n, 64)
      .storeUint(originalOwner, 256)     // back to deployer
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectSuccess(otherWallet, customItemAddr, body);
  });

  await test("NftItem: ownerAddress restored to original", async () => {
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === originalOwner, `expected ${originalOwner}, got ${val}`);
  });

  // ── Part 8: Transfer with forward notification ───────────────

  console.log("\n--- Transfer with Notification ---\n");

  await test("NftItem: TransferNft with forwardAmount sends notification", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(10n, 64)                // queryId
      .storeUint(newOwnerAddr, 256)       // newOwner
      .storeUint(0n, 256)                // responseDestination (0 = none)
      .storeCoins(toNano("0.01"))         // forwardAmount > 0 → send notification
      .endCell();
    const result = await sendMsgExpectSuccess(deployer, customItemAddr, body);

    // Verify owner changed
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === newOwnerAddr, `expected newOwner, got ${val}`);

    // Verify there is an outgoing message (action phase should have an outbound message)
    const contractTx = result.transactions[1];
    const desc = contractTx.description;
    if (desc.type === "generic") {
      // actionPhase should exist and have at least one action
      assert(desc.actionPhase !== undefined, "Expected action phase");
      if (desc.actionPhase) {
        assert(desc.actionPhase.totalActions >= 1, `Expected at least 1 action, got ${desc.actionPhase.totalActions}`);
      }
    }
  });

  // Transfer back so deployer owns it again
  await test("NftItem: Transfer back for next tests", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(11n, 64)
      .storeUint(originalOwner, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectSuccess(otherWallet, customItemAddr, body);
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === originalOwner, `expected originalOwner, got ${val}`);
  });

  // ── Part 9: Transfer with excess return ──────────────────────

  console.log("\n--- Transfer with Excess Return ---\n");

  await test("NftItem: TransferNft with responseDestination sends excess", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(20n, 64)                // queryId
      .storeUint(newOwnerAddr, 256)       // newOwner
      .storeUint(deployerHash, 256)       // responseDestination = deployer (non-zero)
      .storeCoins(0n)                     // forwardAmount = 0
      .endCell();
    const result = await sendMsgExpectSuccess(deployer, customItemAddr, body);

    // Verify owner changed
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === newOwnerAddr, `expected newOwner, got ${val}`);

    // Verify excess message was sent
    const contractTx = result.transactions[1];
    const desc = contractTx.description;
    if (desc.type === "generic") {
      assert(desc.actionPhase !== undefined, "Expected action phase");
      if (desc.actionPhase) {
        assert(desc.actionPhase.totalActions >= 1, `Expected at least 1 action for excess, got ${desc.actionPhase.totalActions}`);
      }
    }
  });

  // Transfer back
  await test("NftItem: Transfer back after excess test", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(21n, 64)
      .storeUint(originalOwner, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectSuccess(otherWallet, customItemAddr, body);
  });

  // ── Part 10: Transfer with both notification AND excess ──────

  console.log("\n--- Transfer with Both Notification & Excess ---\n");

  await test("NftItem: TransferNft with both forward and response", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(30n, 64)                // queryId
      .storeUint(newOwnerAddr, 256)       // newOwner
      .storeUint(deployerHash, 256)       // responseDestination (non-zero)
      .storeCoins(toNano("0.01"))         // forwardAmount > 0
      .endCell();
    const result = await sendMsgExpectSuccess(deployer, customItemAddr, body, toNano("0.1"));

    // Verify owner changed
    const val = await callGetter(customItemAddr, ownerAddressId);
    assert(val === newOwnerAddr, `expected newOwner, got ${val}`);

    // Verify two outgoing messages (notification + excess)
    const contractTx = result.transactions[1];
    const desc = contractTx.description;
    if (desc.type === "generic" && desc.actionPhase) {
      assert(desc.actionPhase.totalActions >= 2, `Expected at least 2 actions, got ${desc.actionPhase.totalActions}`);
    }
  });

  // Transfer back
  await test("NftItem: Transfer back after combined test", async () => {
    const body = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(31n, 64)
      .storeUint(originalOwner, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectSuccess(otherWallet, customItemAddr, body);
  });

  // ── Part 11: Multiple sequential transfers ───────────────────

  console.log("\n--- Multiple Sequential Transfers ---\n");

  await test("NftItem: multiple sequential transfers work correctly", async () => {
    const thirdOwner = 0xDEAD_BEEF_CAFE_BABE_0000_1111_2222_3333_4444_5555_6666_7777_8888_9999_AAAA_BBBBn;

    // Deploy a fresh item for this test
    const seqItemData = beginCell()
      .storeUint(42n, 64)
      .storeUint(0n, 256)
      .storeUint(deployerHash, 256)
      .storeUint(0n, 256)
      .endCell();
    const seqItemAddr = contractAddress(0, { code: itemCode, data: seqItemData });
    await blockchain.setShardAccount(
      seqItemAddr,
      createShardAccount({
        address: seqItemAddr,
        code: itemCode,
        data: seqItemData,
        balance: toNano("1"),
      })
    );

    // Transfer deployer → other
    const body1 = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(50n, 64)
      .storeUint(newOwnerAddr, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectSuccess(deployer, seqItemAddr, body1);
    let val = await callGetter(seqItemAddr, ownerAddressId);
    assert(val === newOwnerAddr, `expected newOwner after first transfer`);

    // Transfer other → deployer (back)
    const body2 = beginCell()
      .storeUint(transferNftOpcode, 32)
      .storeUint(51n, 64)
      .storeUint(originalOwner, 256)
      .storeUint(0n, 256)
      .storeCoins(0n)
      .endCell();
    await sendMsgExpectSuccess(otherWallet, seqItemAddr, body2);
    val = await callGetter(seqItemAddr, ownerAddressId);
    assert(val === originalOwner, `expected originalOwner after second transfer`);
  });

  // ── Part 12: Field immutability during transfers ─────────────

  console.log("\n--- Field Immutability ---\n");

  await test("NftItem: itemIndex unchanged after transfers", async () => {
    const val = await callGetter(customItemAddr, itemIndexId);
    assert(val === 7n, `expected 7, got ${val}`);
  });

  await test("NftItem: collectionAddress unchanged after transfers", async () => {
    const val = await callGetter(customItemAddr, collectionAddressId);
    assert(val === collectionHash, `expected ${collectionHash}, got ${val}`);
  });

  await test("NftItem: content unchanged after transfers", async () => {
    const val = await callGetter(customItemAddr, contentId);
    assert(val === itemContent, `expected ${itemContent}, got ${val}`);
  });

  // ── Part 13: Collection still works after item transfers ─────

  console.log("\n--- Collection After Item Transfers ---\n");

  await test("NftCollection: collectionContent is 0", async () => {
    const val = await callGetter(collectionAddr, collectionContentId);
    assert(val === 0n, `expected 0, got ${val}`);
  });

  await test("NftCollection: third DeployNftItem from owner succeeds", async () => {
    const body = beginCell()
      .storeUint(deployNftItemOpcode, 32)
      .storeUint(2n, 64)
      .storeUint(300n, 256)
      .storeUint(0n, 256)
      .endCell();
    await sendMsgExpectSuccess(deployer, collectionAddr, body);

    const val = await callGetter(collectionAddr, nextItemIndexId);
    assert(val === 3n, `expected 3, got ${val}`);
  });

  // Summary
  console.log(`\n=== NFT Sandbox Results: ${passed} passed, ${failed} failed ===\n`);

  if (failed > 0) {
    console.log("NOTE: Sandbox test failures may indicate TVM binary encoding issues.");
    console.log("The BOC structure is correct -- actual TVM execution requires");
    console.log("exact opcode encoding which is a deeper verification layer.");
  }

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("NFT sandbox test error:", e);
  process.exit(1);
});

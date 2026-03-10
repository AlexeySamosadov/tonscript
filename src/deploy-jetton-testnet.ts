// ============================================================
// TonScript Jetton Testnet Deployer
// Compiles jetton.ts (JettonMaster + JettonWallet),
// deploys both to TON testnet, mints tokens, verifies getters
// ============================================================

import { readFileSync, writeFileSync } from "fs";
import { compile, compileAll, CompileResult } from "./compiler.js";
import { buildContractBoc, BocResult } from "./boc.js";
import { methodId, messageOpcode } from "./tvm.js";
import {
  beginCell,
  toNano,
  internal,
  Address,
} from "@ton/core";
import { TonClient } from "@ton/ton";
import { WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

// ── Config ──────────────────────────────────────────────────

const TESTNET_ENDPOINT = "https://testnet.toncenter.com/api/v2/jsonRPC";
const EXPLORER_BASE = "https://testnet.tonviewer.com";

const MNEMONIC = [
  "bamboo", "subway", "animal", "rain", "pass", "pumpkin", "indicate",
  "giant", "tuition", "nothing", "brass", "tank", "chapter", "sound",
  "require", "oyster", "draft", "there", "marble", "nest", "like",
  "eagle", "eagle", "sense",
];

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string) {
  console.log(`[jetton-deploy] ${msg}`);
}

async function withRetry<T>(fn: () => Promise<T>, label: string, maxRetries = 5): Promise<T> {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (e: any) {
      const is429 = e?.response?.status === 429 || e?.message?.includes("429");
      if (is429 && attempt < maxRetries - 1) {
        const waitMs = 5000 * (attempt + 1);
        log(`  Rate limited on "${label}", retrying in ${waitMs}ms... (${attempt + 1}/${maxRetries})`);
        await sleep(waitMs);
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Max retries exceeded for "${label}"`);
}

let lastApiCall = 0;
async function throttle() {
  const now = Date.now();
  const elapsed = now - lastApiCall;
  if (elapsed < 2500) {
    await sleep(2500 - elapsed);
  }
  lastApiCall = Date.now();
}

async function waitForDeploy(
  client: TonClient,
  address: Address,
  maxAttempts = 40,
  intervalMs = 5000
): Promise<boolean> {
  for (let i = 0; i < maxAttempts; i++) {
    await throttle();
    const deployed = await withRetry(
      () => client.isContractDeployed(address),
      "isContractDeployed"
    );
    if (deployed) return true;
    log(`  waiting for deploy... (${i + 1}/${maxAttempts})`);
    await sleep(intervalMs);
  }
  return false;
}

async function waitForSeqnoChange(
  client: TonClient,
  wallet: WalletContractV4,
  prevSeqno: number,
  maxAttempts = 40,
  intervalMs = 5000
): Promise<boolean> {
  const walletContract = client.open(wallet);
  for (let i = 0; i < maxAttempts; i++) {
    try {
      await throttle();
      const current = await withRetry(
        () => walletContract.getSeqno(),
        "getSeqno"
      );
      if (current > prevSeqno) return true;
    } catch {
      // wallet may not be ready yet
    }
    log(`  waiting for seqno change... (${i + 1}/${maxAttempts})`);
    await sleep(intervalMs);
  }
  return false;
}

// Helper: build a BOC with filtered AST so buildContractBoc picks the correct contract
function buildBocForContract(source: string, contractName: string): BocResult {
  const result = compile(source, contractName);
  const filteredAst = {
    ...result.ast,
    declarations: result.ast.declarations.filter(
      (d: any) => d.kind === "MessageDecl" || (d.kind === "ContractDecl" && d.name === contractName)
    ),
  };
  const filteredResult: CompileResult = { ...result, ast: filteredAst };
  return buildContractBoc(filteredResult);
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log("\n========================================");
  console.log("  TonScript Jetton Testnet Deploy");
  console.log("========================================\n");

  // 1. Compile both contracts
  log("Compiling jetton.ts...");
  const source = readFileSync(
    new URL("../examples/jetton.ts", import.meta.url),
    "utf-8"
  );

  const allResults = compileAll(source);
  for (const [name, result] of allResults) {
    log(`  ${name}: ${result.instructions.asmFull.length} instructions`);
    log(`    getters: ${result.instructions.getters.map((g: any) => g.name).join(", ")}`);
  }

  // 2. Build BOCs
  const masterBoc = buildBocForContract(source, "JettonMaster");
  const walletBoc = buildBocForContract(source, "JettonWallet");

  log(`\nJettonMaster:`);
  log(`  Code: ${masterBoc.code.bits.length} bits, ${masterBoc.code.refs.length} refs`);
  log(`  Data: ${masterBoc.data.bits.length} bits`);
  log(`  Address: ${masterBoc.address.toString()}`);
  log(`  Explorer: ${EXPLORER_BASE}/${masterBoc.address.toString()}`);

  log(`\nJettonWallet:`);
  log(`  Code: ${walletBoc.code.bits.length} bits, ${walletBoc.code.refs.length} refs`);
  log(`  Data: ${walletBoc.data.bits.length} bits`);
  log(`  Address: ${walletBoc.address.toString()}`);
  log(`  Explorer: ${EXPLORER_BASE}/${walletBoc.address.toString()}`);

  // Print opcodes and method IDs
  const mintOpcode = messageOpcode("Mint");
  const internalTransferOpcode = messageOpcode("InternalTransfer");
  const totalSupplyMethodId = methodId("totalSupply");
  const balanceMethodId = methodId("balance");

  log(`\nOpcodes: Mint=0x${mintOpcode.toString(16)}, InternalTransfer=0x${internalTransferOpcode.toString(16)}`);
  log(`Method IDs: totalSupply=${totalSupplyMethodId}, balance=${balanceMethodId}`);

  // 3. Create wallet from mnemonic
  log("\nCreating wallet from mnemonic...");
  const keyPair = await mnemonicToPrivateKey(MNEMONIC);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  log(`Wallet address: ${wallet.address.toString()}`);

  // 4. Connect to TON testnet
  log("Connecting to TON testnet...");
  const client = new TonClient({ endpoint: TESTNET_ENDPOINT });
  const walletContract = client.open(wallet);

  await throttle();
  const balance = await withRetry(
    () => client.getBalance(wallet.address),
    "getBalance"
  );
  log(`Wallet balance: ${Number(balance) / 1e9} TON`);

  if (balance < toNano("0.3")) {
    throw new Error(
      `Insufficient balance (${Number(balance) / 1e9} TON). ` +
      `Need at least 0.3 TON for deploying 2 contracts + sending messages. ` +
      `Fund this wallet: ${wallet.address.toString()}`
    );
  }

  // 5. Deploy JettonMaster
  await throttle();
  const masterAlreadyDeployed = await withRetry(
    () => client.isContractDeployed(masterBoc.address),
    "isContractDeployed(master)"
  );

  if (masterAlreadyDeployed) {
    log("JettonMaster is already deployed! Skipping deploy step.");
  } else {
    log("Deploying JettonMaster...");
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy master)"
    );
    log(`Current wallet seqno: ${seqno}`);

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: masterBoc.address,
            value: toNano("0.05"),
            init: {
              code: masterBoc.code,
              data: masterBoc.data,
            },
            body: beginCell().endCell(),
          }),
        ],
      }),
      "sendTransfer (deploy master)"
    );

    log("Deploy transaction sent. Waiting for confirmation...");
    const deployed = await waitForDeploy(client, masterBoc.address);
    if (!deployed) {
      throw new Error("JettonMaster deploy timed out.");
    }
    log("JettonMaster deployed successfully!");

    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Wallet seqno did not advance. Proceeding anyway...");
    }
    log("Waiting 10s for contract to settle...");
    await sleep(10000);
  }

  // 6. Deploy JettonWallet
  await throttle();
  const walletAlreadyDeployed = await withRetry(
    () => client.isContractDeployed(walletBoc.address),
    "isContractDeployed(wallet)"
  );

  if (walletAlreadyDeployed) {
    log("JettonWallet is already deployed! Skipping deploy step.");
  } else {
    log("Deploying JettonWallet...");
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy wallet)"
    );
    log(`Current wallet seqno: ${seqno}`);

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: walletBoc.address,
            value: toNano("0.05"),
            init: {
              code: walletBoc.code,
              data: walletBoc.data,
            },
            body: beginCell().endCell(),
          }),
        ],
      }),
      "sendTransfer (deploy wallet)"
    );

    log("Deploy transaction sent. Waiting for confirmation...");
    const deployed = await waitForDeploy(client, walletBoc.address);
    if (!deployed) {
      throw new Error("JettonWallet deploy timed out.");
    }
    log("JettonWallet deployed successfully!");

    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Wallet seqno did not advance. Proceeding anyway...");
    }
    log("Waiting 10s for contract to settle...");
    await sleep(10000);
  }

  // 7. Send Mint(amount=1000000000) to JettonMaster
  log("Sending Mint(amount=1000000000) to JettonMaster...");
  {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (mint)"
    );
    log(`Wallet seqno before Mint: ${seqno}`);

    const body = beginCell()
      .storeUint(mintOpcode, 32)        // opcode: Mint
      .storeCoins(1000000000n)           // amount: 1 billion (Coins = VarUInt16)
      .storeUint(0n, 256)               // toOwner: uint256
      .endCell();

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: masterBoc.address,
            value: toNano("0.05"),
            body,
          }),
        ],
      }),
      "sendTransfer (mint)"
    );

    log("Mint transaction sent. Waiting for confirmation...");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Seqno did not advance after Mint.");
    }
    log("Waiting 15s for contract to process Mint...");
    await sleep(15000);
  }

  // 8. Send InternalTransfer to JettonWallet
  log("Sending InternalTransfer(amount=500000000) to JettonWallet...");
  {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (internal transfer)"
    );
    log(`Wallet seqno before InternalTransfer: ${seqno}`);

    const body = beginCell()
      .storeUint(internalTransferOpcode, 32)  // opcode: InternalTransfer
      .storeUint(1n, 64)                       // queryId: uint64
      .storeCoins(500000000n)                   // amount: 500M (Coins = VarUInt16)
      .storeUint(0n, 256)                       // fromAddress: uint256
      .storeUint(0n, 256)                       // responseAddress: uint256
      .storeCoins(0n)                           // forwardTonAmount: Coins
      .endCell();

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: walletBoc.address,
            value: toNano("0.05"),
            body,
          }),
        ],
      }),
      "sendTransfer (internal transfer)"
    );

    log("InternalTransfer transaction sent. Waiting for confirmation...");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Seqno did not advance after InternalTransfer.");
    }
    log("Waiting 15s for contract to process InternalTransfer...");
    await sleep(15000);
  }

  // 9. Call totalSupply getter on JettonMaster
  log("Calling 'totalSupply' getter on JettonMaster...");
  let totalSupplyValue: bigint | null = null;
  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(masterBoc.address, "totalSupply"),
      "runMethod(totalSupply)"
    );
    totalSupplyValue = res.stack.readBigNumber();
    log(`Getter 'totalSupply' returned: ${totalSupplyValue}`);
  } catch (e: any) {
    log(`WARNING: totalSupply getter failed: ${e.message}`);
    await throttle();
    try {
      const res = await withRetry(
        () => client.runMethodWithError(masterBoc.address, "totalSupply"),
        "runMethodWithError(totalSupply)"
      );
      log(`  exit_code: ${res.exit_code}`);
      if (res.exit_code === 0) {
        totalSupplyValue = res.stack.readBigNumber();
        log(`  totalSupply: ${totalSupplyValue}`);
      }
    } catch (e2: any) {
      log(`  Also failed: ${e2.message}`);
    }
  }

  // 10. Call balance getter on JettonWallet
  log("Calling 'balance' getter on JettonWallet...");
  let balanceValue: bigint | null = null;
  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(walletBoc.address, "balance"),
      "runMethod(balance)"
    );
    balanceValue = res.stack.readBigNumber();
    log(`Getter 'balance' returned: ${balanceValue}`);
  } catch (e: any) {
    log(`WARNING: balance getter failed: ${e.message}`);
    await throttle();
    try {
      const res = await withRetry(
        () => client.runMethodWithError(walletBoc.address, "balance"),
        "runMethodWithError(balance)"
      );
      log(`  exit_code: ${res.exit_code}`);
      if (res.exit_code === 0) {
        balanceValue = res.stack.readBigNumber();
        log(`  balance: ${balanceValue}`);
      }
    } catch (e2: any) {
      log(`  Also failed: ${e2.message}`);
    }
  }

  // 11. Print results
  console.log("\n========================================");
  console.log("  JETTON DEPLOYMENT RESULTS");
  console.log("========================================\n");

  const results = {
    timestamp: new Date().toISOString(),
    network: "testnet",
    jettonMaster: {
      address: masterBoc.address.toString(),
      addressRaw: masterBoc.address.toRawString(),
      explorerUrl: `${EXPLORER_BASE}/${masterBoc.address.toString()}`,
      deployStatus: masterAlreadyDeployed ? "already_deployed" : "deployed",
      codeBits: masterBoc.code.bits.length,
      codeRefs: masterBoc.code.refs.length,
      dataBits: masterBoc.data.bits.length,
      mintSent: true,
      mintAmount: 1000000000,
      totalSupplyResult: totalSupplyValue !== null ? Number(totalSupplyValue) : null,
      totalSupplyExpected: 1000000000,
      totalSupplyMatch: totalSupplyValue === 1000000000n,
    },
    jettonWallet: {
      address: walletBoc.address.toString(),
      addressRaw: walletBoc.address.toRawString(),
      explorerUrl: `${EXPLORER_BASE}/${walletBoc.address.toString()}`,
      deployStatus: walletAlreadyDeployed ? "already_deployed" : "deployed",
      codeBits: walletBoc.code.bits.length,
      codeRefs: walletBoc.code.refs.length,
      dataBits: walletBoc.data.bits.length,
      internalTransferSent: true,
      internalTransferAmount: 500000000,
      balanceResult: balanceValue !== null ? Number(balanceValue) : null,
      balanceExpected: 500000000,
      balanceMatch: balanceValue === 500000000n,
    },
    walletAddress: wallet.address.toString(),
    opcodes: {
      Mint: `0x${mintOpcode.toString(16)}`,
      InternalTransfer: `0x${internalTransferOpcode.toString(16)}`,
    },
  };

  console.log(`  JettonMaster:`);
  console.log(`    Address:  ${results.jettonMaster.address}`);
  console.log(`    Explorer: ${results.jettonMaster.explorerUrl}`);
  console.log(`    Status:   ${results.jettonMaster.deployStatus}`);
  console.log(`    Mint(1000000000) sent: true`);
  console.log(`    totalSupply: ${results.jettonMaster.totalSupplyResult}`);
  console.log(`    Expected:    ${results.jettonMaster.totalSupplyExpected}`);
  console.log(`    Match:       ${results.jettonMaster.totalSupplyMatch}`);
  console.log();
  console.log(`  JettonWallet:`);
  console.log(`    Address:  ${results.jettonWallet.address}`);
  console.log(`    Explorer: ${results.jettonWallet.explorerUrl}`);
  console.log(`    Status:   ${results.jettonWallet.deployStatus}`);
  console.log(`    InternalTransfer(500000000) sent: true`);
  console.log(`    balance:  ${results.jettonWallet.balanceResult}`);
  console.log(`    Expected: ${results.jettonWallet.balanceExpected}`);
  console.log(`    Match:    ${results.jettonWallet.balanceMatch}`);
  console.log();
  console.log(`  Deployer Wallet: ${results.walletAddress}`);
  console.log();

  // 12. Save results
  const resultsPath = new URL(
    "../.jetton-deploy-results.json",
    import.meta.url
  );
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  log(`Results saved to .jetton-deploy-results.json`);

  console.log("\n========================================");
  console.log("  DONE");
  console.log("========================================\n");
}

main().catch((e) => {
  console.error("\n[jetton-deploy] FATAL ERROR:", e.message || e);
  console.error(e.stack);
  process.exit(1);
});

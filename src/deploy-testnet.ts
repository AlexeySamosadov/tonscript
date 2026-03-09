// ============================================================
// TonScript Testnet Deployer
// Compiles counter.ts, deploys to TON testnet, sends messages,
// verifies getter results
// ============================================================

import { readFileSync, writeFileSync } from "fs";
import { compile } from "./compiler.js";
import { buildContractBoc } from "./boc.js";
import { methodId } from "./tvm.js";
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
  console.log(`[deploy] ${msg}`);
}

// Rate-limited API call wrapper: retries on 429 with exponential backoff
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

// Throttle: ensure minimum delay between API calls
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

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log("\n========================================");
  console.log("  TonScript Testnet Deploy");
  console.log("========================================\n");

  // 1. Compile the counter contract
  log("Compiling counter.ts...");
  const source = readFileSync(
    new URL("../examples/counter.ts", import.meta.url),
    "utf-8"
  );
  const result = compile(source);
  const bocResult = buildContractBoc(result);

  log(`Code cell: ${bocResult.code.bits.length} bits, ${bocResult.code.refs.length} refs`);
  log(`Data cell: ${bocResult.data.bits.length} bits`);
  log(`Contract address: ${bocResult.address.toString()}`);
  log(`Explorer: ${EXPLORER_BASE}/${bocResult.address.toString()}`);

  const valueMethodId = methodId("value");
  log(`methodId("value") = ${valueMethodId} (0x${valueMethodId.toString(16)})`);

  // 2. Create wallet from mnemonic
  log("Creating wallet from mnemonic...");
  const keyPair = await mnemonicToPrivateKey(MNEMONIC);

  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  log(`Wallet address: ${wallet.address.toString()}`);

  // 3. Connect to TON testnet
  log("Connecting to TON testnet...");
  const client = new TonClient({ endpoint: TESTNET_ENDPOINT });
  const walletContract = client.open(wallet);

  await throttle();
  const balance = await withRetry(
    () => client.getBalance(wallet.address),
    "getBalance"
  );
  log(`Wallet balance: ${Number(balance) / 1e9} TON`);

  if (balance < toNano("0.1")) {
    throw new Error(
      `Insufficient balance (${Number(balance) / 1e9} TON). ` +
      `Need at least 0.1 TON. Fund this wallet: ${wallet.address.toString()}`
    );
  }

  // Check if contract is already deployed
  await throttle();
  const alreadyDeployed = await withRetry(
    () => client.isContractDeployed(bocResult.address),
    "isContractDeployed"
  );
  if (alreadyDeployed) {
    log("Contract is already deployed! Skipping deploy step.");
  }

  // 4. Deploy the contract
  if (!alreadyDeployed) {
    log("Deploying contract...");

    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy)"
    );
    log(`Current wallet seqno: ${seqno}`);

    // Send deploy transaction: internal message with stateInit
    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: bocResult.address,
            value: toNano("0.05"),
            init: {
              code: bocResult.code,
              data: bocResult.data,
            },
            body: beginCell().endCell(), // empty body for deploy
          }),
        ],
      }),
      "sendTransfer (deploy)"
    );

    log("Deploy transaction sent. Waiting for confirmation...");

    const deployed = await waitForDeploy(client, bocResult.address);
    if (!deployed) {
      throw new Error("Deploy timed out. Check the explorer for details.");
    }

    log("Contract deployed successfully!");

    // Wait for wallet seqno to advance
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Wallet seqno did not advance. Proceeding anyway...");
    }

    // Extra wait for the contract to be fully settled
    log("Waiting 10s for contract to settle...");
    await sleep(10000);
  }

  // 5. Send Increment(amount=5)
  log("Sending Increment(amount=5)...");
  {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (increment)"
    );
    log(`Wallet seqno before Increment: ${seqno}`);

    const body = beginCell()
      .storeUint(0x01, 32) // opcode: Increment
      .storeUint(5, 32)    // amount: 5
      .endCell();

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: bocResult.address,
            value: toNano("0.05"),
            body,
          }),
        ],
      }),
      "sendTransfer (increment)"
    );

    log("Increment transaction sent. Waiting for confirmation...");

    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Seqno did not advance after Increment.");
    }

    // Wait for the contract to process the message
    log("Waiting 15s for contract to process message...");
    await sleep(15000);
  }

  // 6. Call the "value" getter
  log("Calling 'value' getter...");
  let getterValue: bigint | null = null;
  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(bocResult.address, "value"),
      "runMethod(value)"
    );
    getterValue = res.stack.readBigNumber();
    log(`Getter 'value' returned: ${getterValue}`);
  } catch (e: any) {
    log(`WARNING: Getter call failed: ${e.message}`);
    log("Trying runMethodWithError...");
    await throttle();
    try {
      const res = await withRetry(
        () => client.runMethodWithError(bocResult.address, "value"),
        "runMethodWithError(value)"
      );
      log(`  exit_code: ${res.exit_code}`);
      if (res.exit_code === 0) {
        getterValue = res.stack.readBigNumber();
        log(`  value: ${getterValue}`);
      }
    } catch (e2: any) {
      log(`  Also failed: ${e2.message}`);
    }
  }

  // 7. Print results
  console.log("\n========================================");
  console.log("  DEPLOYMENT RESULTS");
  console.log("========================================\n");

  const results = {
    timestamp: new Date().toISOString(),
    network: "testnet",
    contractAddress: bocResult.address.toString(),
    contractAddressRaw: bocResult.address.toRawString(),
    explorerUrl: `${EXPLORER_BASE}/${bocResult.address.toString()}`,
    walletAddress: wallet.address.toString(),
    deployStatus: alreadyDeployed ? "already_deployed" : "deployed",
    incrementSent: true,
    incrementAmount: 5,
    getterResult: getterValue !== null ? Number(getterValue) : null,
    getterExpected: 5,
    getterMatch: getterValue === 5n,
    codeBits: bocResult.code.bits.length,
    codeRefs: bocResult.code.refs.length,
    dataBits: bocResult.data.bits.length,
  };

  console.log(`  Contract: ${results.contractAddress}`);
  console.log(`  Explorer: ${results.explorerUrl}`);
  console.log(`  Wallet:   ${results.walletAddress}`);
  console.log(`  Status:   ${results.deployStatus}`);
  console.log(`  Increment(5) sent: ${results.incrementSent}`);
  console.log(`  Getter 'value':    ${results.getterResult}`);
  console.log(`  Expected:          ${results.getterExpected}`);
  console.log(`  Match:             ${results.getterMatch}`);
  console.log();

  // 8. Save results
  const resultsPath = new URL(
    "../.testnet-deploy-results.json",
    import.meta.url
  );
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  log(`Results saved to .testnet-deploy-results.json`);

  console.log("\n========================================");
  console.log("  DONE");
  console.log("========================================\n");
}

main().catch((e) => {
  console.error("\n[deploy] FATAL ERROR:", e.message || e);
  console.error(e.stack);
  process.exit(1);
});

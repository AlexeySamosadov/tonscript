// ============================================================
// TonScript NFT Testnet Deployer (Full TEP-62)
// Compiles nft.ts (NftCollection + NftItem),
// deploys both to TON testnet, sends messages, verifies getters,
// fetches gas usage and compares with previous minimal deploy
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
  Cell,
  contractAddress,
} from "@ton/core";
import { TonClient } from "@ton/ton";
import { WalletContractV4 } from "@ton/ton";
import { mnemonicToPrivateKey } from "@ton/crypto";

// ── Config ──────────────────────────────────────────────────

const TESTNET_ENDPOINT = "https://testnet.toncenter.com/api/v2/jsonRPC";
const TESTNET_API_V3 = "https://testnet.toncenter.com/api/v3";
const EXPLORER_BASE = "https://testnet.tonviewer.com";

const MNEMONIC = [
  "bamboo", "subway", "animal", "rain", "pass", "pumpkin", "indicate",
  "giant", "tuition", "nothing", "brass", "tank", "chapter", "sound",
  "require", "oyster", "draft", "there", "marble", "nest", "like",
  "eagle", "eagle", "sense",
];

// Previous results from minimal NFT deploy (no access control, no notifications)
const PREV_RESULTS = {
  DeployNftItem: { gas: 1858, steps: 53 },
  TransferNft:   { gas: 1972, steps: 58 },
};

// ── Helpers ─────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(msg: string) {
  console.log(`[nft-deploy] ${msg}`);
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

// Helper: fetch transactions from toncenter v3 API (has compute_ph data)
async function fetchTransactions(address: string, limit = 10): Promise<any[]> {
  const url = `${TESTNET_API_V3}/transactions?account=${address}&limit=${limit}`;
  log(`  Fetching transactions from v3 API...`);

  for (let attempt = 0; attempt < 5; attempt++) {
    await throttle();
    try {
      const resp = await fetch(url);
      if (resp.status === 429) {
        const waitMs = 5000 * (attempt + 1);
        log(`  Rate limited fetching txs, retrying in ${waitMs}ms...`);
        await sleep(waitMs);
        continue;
      }
      const json = await resp.json() as any;
      // v3 API returns { transactions: [...] }
      if (json.transactions) {
        return json.transactions;
      }
      log(`  API returned keys: ${Object.keys(json).join(", ")}`);
      return [];
    } catch (e: any) {
      log(`  Fetch attempt ${attempt + 1} failed: ${e.message}`);
      if (attempt < 4) await sleep(3000);
    }
  }
  return [];
}

// Helper: extract gas info from a v3 API transaction
function extractGasInfo(tx: any): { gas_used: number; vm_steps: number; exit_code: number } | null {
  const computePh = tx?.description?.compute_ph;
  if (!computePh || computePh.skipped) return null;
  return {
    gas_used: Number(computePh.gas_used || 0),
    vm_steps: Number(computePh.vm_steps || 0),
    exit_code: Number(computePh.exit_code ?? -1),
  };
}

// Helper: format number with commas
function fmtNum(n: number): string {
  return n.toLocaleString("en-US");
}

// ── Main ────────────────────────────────────────────────────

async function main() {
  console.log("\n========================================");
  console.log("  TonScript NFT Testnet Deploy (Full TEP-62)");
  console.log("========================================\n");

  // 1. Compile both contracts
  log("Compiling nft.ts...");
  const source = readFileSync(
    new URL("../examples/nft.ts", import.meta.url),
    "utf-8"
  );

  const allResults = compileAll(source);
  for (const [name, result] of allResults) {
    log(`  ${name}: ${result.instructions.asmFull.length} instructions`);
    log(`    getters: ${result.instructions.getters.map((g: any) => g.name).join(", ")}`);
  }

  // 2. Build BOCs (initial, with default zero data)
  const collectionBocDefault = buildBocForContract(source, "NftCollection");
  const itemBocDefault = buildBocForContract(source, "NftItem");

  // 3. Create wallet from mnemonic
  log("\nCreating wallet from mnemonic...");
  const keyPair = await mnemonicToPrivateKey(MNEMONIC);
  const wallet = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });
  log(`Wallet address: ${wallet.address.toString()}`);

  // Get the wallet's 256-bit address hash (for ownerAddress fields)
  const walletHash = BigInt('0x' + wallet.address.hash.toString('hex'));
  log(`Wallet hash (uint256): 0x${walletHash.toString(16).slice(0, 16)}...`);

  // 4. Rebuild data cells with correct ownerAddress = walletHash
  // NftCollection data layout: nextItemIndex(uint64) + ownerAddress(uint256) + collectionContent(uint256)
  const collectionData = beginCell()
    .storeUint(0n, 64)              // nextItemIndex = 0
    .storeUint(walletHash, 256)     // ownerAddress = deployer wallet hash
    .storeUint(0n, 256)             // collectionContent = 0
    .endCell();

  const collectionCode = collectionBocDefault.code;
  const collectionAddress = contractAddress(0, { code: collectionCode, data: collectionData });

  // NftItem data layout: itemIndex(uint64) + collectionAddress(uint256) + ownerAddress(uint256) + content(uint256)
  const itemData = beginCell()
    .storeUint(0n, 64)              // itemIndex = 0
    .storeUint(0n, 256)             // collectionAddress = 0
    .storeUint(walletHash, 256)     // ownerAddress = deployer wallet hash
    .storeUint(0n, 256)             // content = 0
    .endCell();

  const itemCode = itemBocDefault.code;
  const itemAddress = contractAddress(0, { code: itemCode, data: itemData });

  log(`\nNftCollection (full TEP-62):`);
  log(`  Code: ${collectionCode.bits.length} bits, ${collectionCode.refs.length} refs`);
  log(`  Data: ${collectionData.bits.length} bits`);
  log(`  Address: ${collectionAddress.toString()}`);
  log(`  Explorer: ${EXPLORER_BASE}/${collectionAddress.toString()}`);

  log(`\nNftItem (full TEP-62):`);
  log(`  Code: ${itemCode.bits.length} bits, ${itemCode.refs.length} refs`);
  log(`  Data: ${itemData.bits.length} bits`);
  log(`  Address: ${itemAddress.toString()}`);
  log(`  Explorer: ${EXPLORER_BASE}/${itemAddress.toString()}`);

  // Print opcodes and method IDs
  const deployNftItemOpcode = messageOpcode("DeployNftItem");
  const transferNftOpcode = messageOpcode("TransferNft");
  const getStaticDataOpcode = messageOpcode("GetStaticData");
  const nextItemIndexMethodId = methodId("nextItemIndex");
  const ownerAddressMethodId = methodId("ownerAddress");
  const collectionContentMethodId = methodId("collectionContent");
  const itemIndexMethodId = methodId("itemIndex");
  const collectionAddressMethodId = methodId("collectionAddress");
  const contentMethodId = methodId("content");

  log(`\nOpcodes: DeployNftItem=0x${deployNftItemOpcode.toString(16)}, TransferNft=0x${transferNftOpcode.toString(16)}, GetStaticData=0x${getStaticDataOpcode.toString(16)}`);
  log(`Method IDs: nextItemIndex=${nextItemIndexMethodId}, ownerAddress=${ownerAddressMethodId}, collectionContent=${collectionContentMethodId}`);
  log(`            itemIndex=${itemIndexMethodId}, collectionAddress=${collectionAddressMethodId}, content=${contentMethodId}`);

  // 5. Connect to TON testnet
  log("\nConnecting to TON testnet...");
  const client = new TonClient({ endpoint: TESTNET_ENDPOINT });
  const walletContract = client.open(wallet);

  await throttle();
  const balance = await withRetry(
    () => client.getBalance(wallet.address),
    "getBalance"
  );
  log(`Wallet balance: ${Number(balance) / 1e9} TON`);

  if (balance < toNano("0.5")) {
    throw new Error(
      `Insufficient balance (${Number(balance) / 1e9} TON). ` +
      `Need at least 0.5 TON for deploying 2 contracts + sending 4 messages. ` +
      `Fund this wallet: ${wallet.address.toString()}`
    );
  }

  // 6. Deploy NftCollection
  await throttle();
  const collectionAlreadyDeployed = await withRetry(
    () => client.isContractDeployed(collectionAddress),
    "isContractDeployed(collection)"
  );

  if (collectionAlreadyDeployed) {
    log("NftCollection is already deployed! Skipping deploy step.");
  } else {
    log("Deploying NftCollection (with ownerAddress = wallet hash)...");
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy collection)"
    );
    log(`Current wallet seqno: ${seqno}`);

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: collectionAddress,
            value: toNano("0.05"),
            init: {
              code: collectionCode,
              data: collectionData,
            },
            body: beginCell().endCell(),
          }),
        ],
      }),
      "sendTransfer (deploy collection)"
    );

    log("Deploy transaction sent. Waiting for confirmation...");
    const deployed = await waitForDeploy(client, collectionAddress);
    if (!deployed) {
      throw new Error("NftCollection deploy timed out.");
    }
    log("NftCollection deployed successfully!");

    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Wallet seqno did not advance. Proceeding anyway...");
    }
    log("Waiting 10s for contract to settle...");
    await sleep(10000);
  }

  // 7. Deploy NftItem
  await throttle();
  const itemAlreadyDeployed = await withRetry(
    () => client.isContractDeployed(itemAddress),
    "isContractDeployed(item)"
  );

  if (itemAlreadyDeployed) {
    log("NftItem is already deployed! Skipping deploy step.");
  } else {
    log("Deploying NftItem (with ownerAddress = wallet hash)...");
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy item)"
    );
    log(`Current wallet seqno: ${seqno}`);

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: itemAddress,
            value: toNano("0.05"),
            init: {
              code: itemCode,
              data: itemData,
            },
            body: beginCell().endCell(),
          }),
        ],
      }),
      "sendTransfer (deploy item)"
    );

    log("Deploy transaction sent. Waiting for confirmation...");
    const deployed = await waitForDeploy(client, itemAddress);
    if (!deployed) {
      throw new Error("NftItem deploy timed out.");
    }
    log("NftItem deployed successfully!");

    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Wallet seqno did not advance. Proceeding anyway...");
    }
    log("Waiting 10s for contract to settle...");
    await sleep(10000);
  }

  // 8. Send DeployNftItem to NftCollection (sender is wallet, ownerAddress = walletHash -> passes access control)
  log("Sending DeployNftItem to NftCollection...");
  {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy nft item msg)"
    );
    log(`Wallet seqno before DeployNftItem: ${seqno}`);

    const body = beginCell()
      .storeUint(deployNftItemOpcode, 32)  // opcode: DeployNftItem
      .storeUint(0n, 64)                   // itemIndex: uint64
      .storeUint(100n, 256)                // ownerAddress: uint256
      .storeUint(0n, 256)                  // content: uint256
      .endCell();

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: collectionAddress,
            value: toNano("0.05"),
            body,
          }),
        ],
      }),
      "sendTransfer (deploy nft item msg)"
    );

    log("DeployNftItem transaction sent. Waiting for confirmation...");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Seqno did not advance after DeployNftItem.");
    }
    log("Waiting 15s for contract to process DeployNftItem...");
    await sleep(15000);
  }

  // 9. Send TransferNft (basic, forwardAmount=0) to NftItem
  const newOwnerAddr = 999n;
  log(`Sending TransferNft(newOwner=${newOwnerAddr}, forwardAmount=0) to NftItem...`);
  {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (transfer nft basic)"
    );
    log(`Wallet seqno before TransferNft (basic): ${seqno}`);

    const body = beginCell()
      .storeUint(transferNftOpcode, 32)     // opcode: TransferNft
      .storeUint(1n, 64)                    // queryId: uint64
      .storeUint(newOwnerAddr, 256)          // newOwner: uint256
      .storeUint(walletHash, 256)            // responseDestination: wallet (for excess return)
      .storeCoins(0n)                        // forwardAmount: 0 (no notification)
      .endCell();

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: itemAddress,
            value: toNano("0.05"),
            body,
          }),
        ],
      }),
      "sendTransfer (transfer nft basic)"
    );

    log("TransferNft (basic) transaction sent. Waiting for confirmation...");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Seqno did not advance after TransferNft (basic).");
    }
    log("Waiting 15s for contract to process TransferNft (basic)...");
    await sleep(15000);
  }

  // 10. Transfer ownership back to wallet so we can test further
  // (item's ownerAddress is now 999, need to deploy a fresh item or skip)
  // Actually, we can't transfer back since ownerAddress is now 999 and sender() won't match.
  // So for the notification test, let's deploy a second NftItem with ownerAddress = walletHash.
  log("Deploying second NftItem for notification test...");
  const item2Data = beginCell()
    .storeUint(1n, 64)              // itemIndex = 1 (different from first item)
    .storeUint(0n, 256)             // collectionAddress = 0
    .storeUint(walletHash, 256)     // ownerAddress = deployer wallet hash
    .storeUint(0n, 256)             // content = 0
    .endCell();

  const item2Address = contractAddress(0, { code: itemCode, data: item2Data });
  log(`  Second NftItem address: ${item2Address.toString()}`);

  await throttle();
  const item2AlreadyDeployed = await withRetry(
    () => client.isContractDeployed(item2Address),
    "isContractDeployed(item2)"
  );

  if (item2AlreadyDeployed) {
    log("  Second NftItem already deployed! Skipping.");
  } else {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy item2)"
    );

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: item2Address,
            value: toNano("0.05"),
            init: {
              code: itemCode,
              data: item2Data,
            },
            body: beginCell().endCell(),
          }),
        ],
      }),
      "sendTransfer (deploy item2)"
    );

    log("  Deploy transaction sent. Waiting...");
    const deployed = await waitForDeploy(client, item2Address);
    if (!deployed) {
      throw new Error("Second NftItem deploy timed out.");
    }
    log("  Second NftItem deployed!");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("  WARNING: Seqno did not advance.");
    }
    log("  Waiting 10s for contract to settle...");
    await sleep(10000);
  }

  // 11. Send TransferNft with forwardAmount > 0 (notification test) to item2
  log(`Sending TransferNft(newOwner=${newOwnerAddr}, forwardAmount=0.01 TON) to second NftItem...`);
  {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (transfer nft notify)"
    );
    log(`Wallet seqno before TransferNft (notify): ${seqno}`);

    const body = beginCell()
      .storeUint(transferNftOpcode, 32)     // opcode: TransferNft
      .storeUint(2n, 64)                    // queryId: uint64
      .storeUint(newOwnerAddr, 256)          // newOwner: uint256
      .storeUint(walletHash, 256)            // responseDestination: wallet
      .storeCoins(toNano("0.01"))            // forwardAmount: 0.01 TON (triggers notification)
      .endCell();

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: item2Address,
            value: toNano("0.05"),
            body,
          }),
        ],
      }),
      "sendTransfer (transfer nft notify)"
    );

    log("TransferNft (notify) transaction sent. Waiting...");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Seqno did not advance after TransferNft (notify).");
    }
    log("Waiting 15s for contract to process TransferNft (notify)...");
    await sleep(15000);
  }

  // 12. Deploy a third NftItem for GetStaticData test (item2's owner is now 999)
  log("Deploying third NftItem for GetStaticData test...");
  const item3Data = beginCell()
    .storeUint(42n, 64)             // itemIndex = 42
    .storeUint(77n, 256)            // collectionAddress = 77
    .storeUint(walletHash, 256)     // ownerAddress = deployer wallet hash
    .storeUint(0n, 256)             // content = 0
    .endCell();

  const item3Address = contractAddress(0, { code: itemCode, data: item3Data });
  log(`  Third NftItem address: ${item3Address.toString()}`);

  await throttle();
  const item3AlreadyDeployed = await withRetry(
    () => client.isContractDeployed(item3Address),
    "isContractDeployed(item3)"
  );

  if (item3AlreadyDeployed) {
    log("  Third NftItem already deployed! Skipping.");
  } else {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (deploy item3)"
    );

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: item3Address,
            value: toNano("0.05"),
            init: {
              code: itemCode,
              data: item3Data,
            },
            body: beginCell().endCell(),
          }),
        ],
      }),
      "sendTransfer (deploy item3)"
    );

    log("  Deploy transaction sent. Waiting...");
    const deployed = await waitForDeploy(client, item3Address);
    if (!deployed) {
      throw new Error("Third NftItem deploy timed out.");
    }
    log("  Third NftItem deployed!");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("  WARNING: Seqno did not advance.");
    }
    log("  Waiting 10s for contract to settle...");
    await sleep(10000);
  }

  // 13. Send GetStaticData to third NftItem
  log("Sending GetStaticData to third NftItem...");
  {
    await throttle();
    const seqno = await withRetry(
      () => walletContract.getSeqno(),
      "getSeqno (get static data)"
    );
    log(`Wallet seqno before GetStaticData: ${seqno}`);

    const body = beginCell()
      .storeUint(getStaticDataOpcode, 32)   // opcode: GetStaticData
      .storeUint(3n, 64)                    // queryId: uint64
      .endCell();

    await throttle();
    await withRetry(
      () => walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
          internal({
            to: item3Address,
            value: toNano("0.05"),
            body,
          }),
        ],
      }),
      "sendTransfer (get static data)"
    );

    log("GetStaticData transaction sent. Waiting...");
    const seqnoChanged = await waitForSeqnoChange(client, wallet, seqno);
    if (!seqnoChanged) {
      log("WARNING: Seqno did not advance after GetStaticData.");
    }
    log("Waiting 15s for contract to process GetStaticData...");
    await sleep(15000);
  }

  // 14. Call getters on NftCollection
  log("\nCalling getters on NftCollection...");
  let nextItemIndexValue: bigint | null = null;
  let collectionOwnerValue: bigint | null = null;
  let collectionContentValue: bigint | null = null;

  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(collectionAddress, "nextItemIndex"),
      "runMethod(nextItemIndex)"
    );
    nextItemIndexValue = res.stack.readBigNumber();
    log(`  nextItemIndex: ${nextItemIndexValue}`);
  } catch (e: any) {
    log(`  WARNING: nextItemIndex getter failed: ${e.message}`);
  }

  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(collectionAddress, "ownerAddress"),
      "runMethod(ownerAddress on collection)"
    );
    collectionOwnerValue = res.stack.readBigNumber();
    log(`  ownerAddress: 0x${collectionOwnerValue.toString(16).slice(0, 16)}...`);
  } catch (e: any) {
    log(`  WARNING: ownerAddress getter failed: ${e.message}`);
  }

  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(collectionAddress, "collectionContent"),
      "runMethod(collectionContent)"
    );
    collectionContentValue = res.stack.readBigNumber();
    log(`  collectionContent: ${collectionContentValue}`);
  } catch (e: any) {
    log(`  WARNING: collectionContent getter failed: ${e.message}`);
  }

  // 15. Call getters on NftItem (first item — ownerAddress should be 999 after transfer)
  log("\nCalling getters on NftItem (first)...");
  let itemOwnerValue: bigint | null = null;
  let itemIndexValue: bigint | null = null;

  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(itemAddress, "ownerAddress"),
      "runMethod(ownerAddress on item)"
    );
    itemOwnerValue = res.stack.readBigNumber();
    log(`  ownerAddress: ${itemOwnerValue}`);
  } catch (e: any) {
    log(`  WARNING: ownerAddress getter failed: ${e.message}`);
  }

  await throttle();
  try {
    const res = await withRetry(
      () => client.runMethod(itemAddress, "itemIndex"),
      "runMethod(itemIndex)"
    );
    itemIndexValue = res.stack.readBigNumber();
    log(`  itemIndex: ${itemIndexValue}`);
  } catch (e: any) {
    log(`  WARNING: itemIndex getter failed: ${e.message}`);
  }

  // 16. Fetch gas data from transactions
  log("\nFetching transaction data for gas analysis...");

  // Collection transactions
  log("Fetching NftCollection transactions...");
  await sleep(3000);
  const collectionTxs = await fetchTransactions(collectionAddress.toRawString());
  log(`  Got ${collectionTxs.length} transactions`);

  // Item1 transactions
  log("Fetching NftItem (first) transactions...");
  await sleep(3000);
  const item1Txs = await fetchTransactions(itemAddress.toRawString());
  log(`  Got ${item1Txs.length} transactions`);

  // Item2 transactions (notification test)
  log("Fetching NftItem (second, notify) transactions...");
  await sleep(3000);
  const item2Txs = await fetchTransactions(item2Address.toRawString());
  log(`  Got ${item2Txs.length} transactions`);

  // Item3 transactions (GetStaticData)
  log("Fetching NftItem (third, GetStaticData) transactions...");
  await sleep(3000);
  const item3Txs = await fetchTransactions(item3Address.toRawString());
  log(`  Got ${item3Txs.length} transactions`);

  // Parse gas data
  interface GasResult {
    operation: string;
    gas_used: number;
    vm_steps: number;
    exit_code: number;
  }
  const gasResults: GasResult[] = [];

  // Helper: find the first successful non-deploy tx with matching opcode
  function findTxByOpcode(txs: any[], expectedOpcode: string): any | null {
    for (const tx of txs) {
      const gas = extractGasInfo(tx);
      if (!gas || gas.exit_code !== 0) continue;
      if (tx?.in_msg?.init_state != null) continue; // skip deploy txs
      const opcode = tx?.in_msg?.opcode;
      if (opcode === expectedOpcode) return tx;
    }
    return null;
  }

  const deployNftItemOpcodeHex = `0x${deployNftItemOpcode.toString(16)}`;
  const transferNftOpcodeHex = `0x${transferNftOpcode.toString(16)}`;
  const getStaticDataOpcodeHex = `0x${getStaticDataOpcode.toString(16)}`;

  // DeployNftItem on collection
  const deployItemTx = findTxByOpcode(collectionTxs, deployNftItemOpcodeHex);
  if (deployItemTx) {
    const gas = extractGasInfo(deployItemTx)!;
    gasResults.push({ operation: "DeployNftItem", ...gas });
    log(`  DeployNftItem: gas=${gas.gas_used}, steps=${gas.vm_steps}, exit=${gas.exit_code}`);
  } else {
    log(`  DeployNftItem: no matching tx found`);
  }

  // TransferNft (basic) on item1
  const transferBasicTx = findTxByOpcode(item1Txs, transferNftOpcodeHex);
  if (transferBasicTx) {
    const gas = extractGasInfo(transferBasicTx)!;
    gasResults.push({ operation: "TransferNft (basic)", ...gas });
    log(`  TransferNft (basic): gas=${gas.gas_used}, steps=${gas.vm_steps}, exit=${gas.exit_code}`);
  } else {
    log(`  TransferNft (basic): no matching tx found`);
  }

  // TransferNft (notify) on item2 — must be the one with 2 out_msgs
  // (notification + excess), not a bounced message
  let transferNotifyTx: any = null;
  for (const tx of item2Txs) {
    const gas = extractGasInfo(tx);
    if (!gas || gas.exit_code !== 0) continue;
    const opcode = tx?.in_msg?.opcode;
    if (opcode !== transferNftOpcodeHex) continue;
    // The notify transfer should have out_msgs (notification + excess)
    const outMsgCount = tx?.out_msgs?.length || 0;
    if (outMsgCount >= 2) {
      transferNotifyTx = tx;
      break;
    }
  }
  if (transferNotifyTx) {
    const gas = extractGasInfo(transferNotifyTx)!;
    gasResults.push({ operation: "TransferNft (notify)", ...gas });
    log(`  TransferNft (notify): gas=${gas.gas_used}, steps=${gas.vm_steps}, exit=${gas.exit_code}, out_msgs=${transferNotifyTx.out_msgs?.length}`);
  } else {
    log(`  TransferNft (notify): no matching tx found (with 2+ out_msgs)`);
  }

  // GetStaticData on item3
  const getStaticDataTx = findTxByOpcode(item3Txs, getStaticDataOpcodeHex);
  if (getStaticDataTx) {
    const gas = extractGasInfo(getStaticDataTx)!;
    gasResults.push({ operation: "GetStaticData", ...gas });
    log(`  GetStaticData: gas=${gas.gas_used}, steps=${gas.vm_steps}, exit=${gas.exit_code}`);
  } else {
    log(`  GetStaticData: no matching tx found`);
  }

  // 17. Print results
  console.log("\n========================================");
  console.log("  NFT DEPLOYMENT RESULTS (Full TEP-62)");
  console.log("========================================\n");

  console.log(`  NftCollection:`);
  console.log(`    Address:  ${collectionAddress.toString()}`);
  console.log(`    Explorer: ${EXPLORER_BASE}/${collectionAddress.toString()}`);
  console.log(`    Status:   ${collectionAlreadyDeployed ? "already_deployed" : "deployed"}`);
  console.log(`    DeployNftItem sent: true`);
  console.log(`    nextItemIndex: ${nextItemIndexValue}`);
  console.log(`    ownerAddress matches wallet: ${collectionOwnerValue === walletHash}`);
  console.log(`    collectionContent: ${collectionContentValue}`);
  console.log();
  console.log(`  NftItem (first):`);
  console.log(`    Address:  ${itemAddress.toString()}`);
  console.log(`    Explorer: ${EXPLORER_BASE}/${itemAddress.toString()}`);
  console.log(`    Status:   ${itemAlreadyDeployed ? "already_deployed" : "deployed"}`);
  console.log(`    TransferNft(basic, newOwner=${newOwnerAddr}) sent: true`);
  console.log(`    ownerAddress: ${itemOwnerValue} (expected: ${newOwnerAddr})`);
  console.log(`    ownerAddress match: ${itemOwnerValue === newOwnerAddr}`);
  console.log();
  console.log(`  NftItem (second — notification test):`);
  console.log(`    Address:  ${item2Address.toString()}`);
  console.log(`    Explorer: ${EXPLORER_BASE}/${item2Address.toString()}`);
  console.log(`    TransferNft(notify, forwardAmount=0.01 TON) sent: true`);
  console.log();
  console.log(`  NftItem (third — GetStaticData test):`);
  console.log(`    Address:  ${item3Address.toString()}`);
  console.log(`    Explorer: ${EXPLORER_BASE}/${item3Address.toString()}`);
  console.log(`    GetStaticData(queryId=3) sent: true`);
  console.log();
  console.log(`  Deployer Wallet: ${wallet.address.toString()}`);
  console.log();

  // 18. Gas comparison table
  console.log("========================================");
  console.log("  GAS COMPARISON");
  console.log("========================================\n");

  const findGas = (op: string) => gasResults.find(r => r.operation === op);

  const deployItem = findGas("DeployNftItem");
  const transferBasic = findGas("TransferNft (basic)");
  const transferNotify = findGas("TransferNft (notify)");
  const getStaticData = findGas("GetStaticData");

  const pad = (s: string, n: number) => s.padEnd(n);
  const padL = (s: string, n: number) => s.padStart(n);

  console.log(`  ${pad("Operation", 22)} | ${pad("Minimal (prev)", 16)} | ${pad("Full TEP-62", 16)} | Delta`);
  console.log(`  ${"-".repeat(22)}-+-${"-".repeat(16)}-+-${"-".repeat(16)}-+--------`);

  if (deployItem) {
    const delta = ((deployItem.gas_used - PREV_RESULTS.DeployNftItem.gas) / PREV_RESULTS.DeployNftItem.gas * 100).toFixed(0);
    console.log(`  ${pad("DeployNftItem", 22)} | ${padL(fmtNum(PREV_RESULTS.DeployNftItem.gas) + " gas", 16)} | ${padL(fmtNum(deployItem.gas_used) + " gas", 16)} | ${delta.startsWith("-") ? delta : "+" + delta}%`);
    console.log(`  ${pad("", 22)} | ${padL(PREV_RESULTS.DeployNftItem.steps + " steps", 16)} | ${padL(deployItem.vm_steps + " steps", 16)} |`);
  } else {
    console.log(`  ${pad("DeployNftItem", 22)} | ${padL(fmtNum(PREV_RESULTS.DeployNftItem.gas) + " gas", 16)} | ${padL("(no data)", 16)} |`);
  }

  if (transferBasic) {
    const delta = ((transferBasic.gas_used - PREV_RESULTS.TransferNft.gas) / PREV_RESULTS.TransferNft.gas * 100).toFixed(0);
    console.log(`  ${pad("TransferNft (basic)", 22)} | ${padL(fmtNum(PREV_RESULTS.TransferNft.gas) + " gas", 16)} | ${padL(fmtNum(transferBasic.gas_used) + " gas", 16)} | ${delta.startsWith("-") ? delta : "+" + delta}%`);
    console.log(`  ${pad("", 22)} | ${padL(PREV_RESULTS.TransferNft.steps + " steps", 16)} | ${padL(transferBasic.vm_steps + " steps", 16)} |`);
  } else {
    console.log(`  ${pad("TransferNft (basic)", 22)} | ${padL(fmtNum(PREV_RESULTS.TransferNft.gas) + " gas", 16)} | ${padL("(no data)", 16)} |`);
  }

  if (transferNotify) {
    console.log(`  ${pad("TransferNft (notify)", 22)} | ${padL("--", 16)} | ${padL(fmtNum(transferNotify.gas_used) + " gas", 16)} | (new)`);
    console.log(`  ${pad("", 22)} | ${padL("", 16)} | ${padL(transferNotify.vm_steps + " steps", 16)} |`);
  } else {
    console.log(`  ${pad("TransferNft (notify)", 22)} | ${padL("--", 16)} | ${padL("(no data)", 16)} |`);
  }

  if (getStaticData) {
    console.log(`  ${pad("GetStaticData", 22)} | ${padL("--", 16)} | ${padL(fmtNum(getStaticData.gas_used) + " gas", 16)} | (new)`);
    console.log(`  ${pad("", 22)} | ${padL("", 16)} | ${padL(getStaticData.vm_steps + " steps", 16)} |`);
  } else {
    console.log(`  ${pad("GetStaticData", 22)} | ${padL("--", 16)} | ${padL("(no data)", 16)} |`);
  }

  console.log();

  // 19. Save results
  const results = {
    timestamp: new Date().toISOString(),
    network: "testnet",
    version: "full-tep62",
    nftCollection: {
      address: collectionAddress.toString(),
      addressRaw: collectionAddress.toRawString(),
      explorerUrl: `${EXPLORER_BASE}/${collectionAddress.toString()}`,
      deployStatus: collectionAlreadyDeployed ? "already_deployed" : "deployed",
      codeBits: collectionCode.bits.length,
      codeRefs: collectionCode.refs.length,
      dataBits: collectionData.bits.length,
      deployNftItemSent: true,
      nextItemIndexResult: nextItemIndexValue !== null ? Number(nextItemIndexValue) : null,
      ownerAddressMatchesWallet: collectionOwnerValue === walletHash,
      collectionContentResult: collectionContentValue !== null ? Number(collectionContentValue) : null,
    },
    nftItem: {
      address: itemAddress.toString(),
      addressRaw: itemAddress.toRawString(),
      explorerUrl: `${EXPLORER_BASE}/${itemAddress.toString()}`,
      deployStatus: itemAlreadyDeployed ? "already_deployed" : "deployed",
      codeBits: itemCode.bits.length,
      codeRefs: itemCode.refs.length,
      dataBits: itemData.bits.length,
      transferNftBasicSent: true,
      ownerAddressResult: itemOwnerValue !== null ? Number(itemOwnerValue) : null,
      ownerAddressExpected: Number(newOwnerAddr),
      ownerAddressMatch: itemOwnerValue === newOwnerAddr,
      itemIndexResult: itemIndexValue !== null ? Number(itemIndexValue) : null,
    },
    nftItem2: {
      address: item2Address.toString(),
      explorerUrl: `${EXPLORER_BASE}/${item2Address.toString()}`,
      transferNftNotifySent: true,
      forwardAmount: "0.01 TON",
    },
    nftItem3: {
      address: item3Address.toString(),
      explorerUrl: `${EXPLORER_BASE}/${item3Address.toString()}`,
      getStaticDataSent: true,
      queryId: 3,
    },
    gasComparison: {
      previous: PREV_RESULTS,
      current: {
        DeployNftItem: deployItem || null,
        TransferNftBasic: transferBasic || null,
        TransferNftNotify: transferNotify || null,
        GetStaticData: getStaticData || null,
      },
    },
    walletAddress: wallet.address.toString(),
    opcodes: {
      DeployNftItem: `0x${deployNftItemOpcode.toString(16)}`,
      TransferNft: `0x${transferNftOpcode.toString(16)}`,
      GetStaticData: `0x${getStaticDataOpcode.toString(16)}`,
    },
  };

  const resultsPath = new URL(
    "../.nft-deploy-results.json",
    import.meta.url
  );
  writeFileSync(resultsPath, JSON.stringify(results, null, 2));
  log(`Results saved to .nft-deploy-results.json`);

  console.log("\n========================================");
  console.log("  DONE");
  console.log("========================================\n");
}

main().catch((e) => {
  console.error("\n[nft-deploy] FATAL ERROR:", e.message || e);
  console.error(e.stack);
  process.exit(1);
});

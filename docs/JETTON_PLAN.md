# Jetton (TEP-74) Implementation Plan

## Overview

Implement TEP-74 compliant Jetton (fungible token) in TonScript.
Two contracts: JettonMaster + JettonWallet.

## Current State (Sprint 4 completed)

- Full pipeline: Lexer → Parser → AST → Codegen → TVM → BOC → Deploy
- Counter contract deployed on testnet: `EQAqj08mXzWKGnpR0lp81-oNgT5Z9LG5sdk7IFgQwh4RseIo`
- 59 unit tests + 12 sandbox E2E tests
- Supported: fields, messages, receivers, getters, if/else, while, for, require, send, let

## What Jetton Requires

### JettonMaster contract
- **Storage:** total_supply (coins), mintable (bool), admin_address (address), jetton_content (Cell), jetton_wallet_code (Cell)
- **Messages:**
  - Mint (`0x642fcc9f`) — verify admin, create wallet, increment supply
  - Burn Notification (`0x7bab48c3`) — verify sender is wallet, decrement supply
  - Change Admin — update admin_address
- **Getters:**
  - `get_jetton_data()` → (total_supply, mintable, admin, content, wallet_code)
  - `get_wallet_address(owner)` → Address (computed from stateInit hash)

### JettonWallet contract
- **Storage:** balance (coins), owner_address (address), jetton_master_address (address), jetton_wallet_code (Cell)
- **Messages:**
  - Transfer (`0x0f8a7ea5`) — verify balance, send internal_transfer to dest wallet
  - Internal Transfer (`0x178d4519`) — receive tokens, verify sender is legit wallet
  - Transfer Notification (`0x7362d09c`) — notify destination owner
  - Burn (`0x595f07bc`) — verify balance, send burn_notification to master
- **Getters:**
  - `get_wallet_data()` → (balance, owner, master, wallet_code)

---

## Implementation Phases

### Phase 1: Multi-Contract Support
**Complexity: Medium | ~2 days**

Currently compiler handles only 1 contract per file. Need to support 2+ contracts.

Changes:
- `codegen.ts`: Accept contract name parameter in `generate()` (currently finds first ContractDecl)
- `compiler.ts`: Modify `compile()` to accept target contract name or compile all
- `boc.ts`: No changes (already works per-contract)
- `cli.ts`: Add `--contract <name>` flag

Milestone: Compile two contracts from one file, deploy both to sandbox.

### Phase 2: Cell/Slice/Builder API + Method Chaining
**Complexity: HIGH — hardest phase | ~5 days**

Jetton protocol requires building complex internal messages with specific layouts.

#### Parser changes (parser.ts):
- Parse method calls on expressions: `expr.method(args)`
- Support chaining: `beginCell().storeUint(0x18, 6).storeAddress(addr).endCell()`
- Currently `CallExpr` only supports `name(args)`, not `expr.method(args)`

#### AST changes (ast.ts):
- Add `MethodCallExpr` node: `{ object: Expr, method: string, args: Expr[] }`

#### CodeGenerator changes (codegen.ts):
- `beginCell()` → NEWC (pushes Builder)
- `builder.storeUint(value, bits)` → STU
- `builder.storeInt(value, bits)` → STI
- `builder.storeCoins(value)` → STVARUINT16
- `builder.storeRef(cell)` → STREF
- `builder.storeSlice(slice)` → STSLICER
- `builder.storeAddress(addr)` → STSLICE 267
- `builder.endCell()` → ENDC (Builder → Cell)
- `cell.beginParse()` → CTOS (Cell → Slice)
- `slice.loadUint(bits)` → LDU
- `slice.loadInt(bits)` → LDI
- `slice.loadCoins()` → LDVARUINT16
- `slice.loadRef()` → LDREF
- `slice.loadAddress()` → LDSLICE 267

Milestone: Contract that builds and sends internal message with complex layout.

### Phase 3: Address Computation (stateInit hashing)
**Complexity: High | ~3 days**

Critical for Jetton: Wallet A must compute address of Wallet B on-chain.

Changes:
- New builtin: `contractAddress(workchain, code, data)` or `stateInitHash(code, data)`
- TVM instructions: HASHCU (already in tvm.ts), NEWC/ENDC/STREF
- Compiler must support embedding one contract's code Cell as constant in another
- Need cross-compilation: compile Wallet first → get code Cell → embed in Master

Milestone: Compute wallet address from master, verify matches off-chain computation.

### Phase 4: Jetton Contracts + Testing
**Complexity: Medium | ~4 days**

Write actual contracts with phases 1-3 complete.

Simplified JettonMaster:
- Storage: totalSupply, admin, walletCode (Cell ref)
- Handlers: Mint, BurnNotification
- Getters: jettonData, walletAddress

Simplified JettonWallet:
- Storage: balance, owner, master
- Handlers: Transfer, InternalTransfer, Burn
- Getter: walletData

Simplifications from full TEP-74:
- No on-chain metadata (empty content cell)
- No custom_payload in transfers
- No forward_payload initially
- Skip query_id tracking (set to 0)

### Phase 5 (Optional): Full TEP-74 Compliance
- query_id support
- forward_payload / custom_payload
- Map type for on-chain metadata (TEP-64)
- Proper bounce handling
- Deploy to testnet

---

## Dependency Graph

```
Phase 1 (Multi-Contract) ──────────┐
                                    ├──> Phase 4 (Jetton Contracts)
Phase 2 (Cell/Builder API) ────────┤
                                    │
Phase 3 (Address Computation) ─────┘

Phase 5 (TEP-74 Polish) ── after Phase 4
```

## Critical Files

| File | Lines | Changes needed |
|------|-------|---------------|
| codegen.ts | 1074 | Multi-contract, Cell/Builder builtins, stateInit, raw messages |
| parser.ts | 705 | Method call chaining (`expr.method(args)`) |
| ast.ts | 256 | MethodCallExpr node |
| tvm.ts | 591 | Mostly complete, may need STDICT/LDDICT |
| compiler.ts | 78 | Multi-contract compilation, cross-contract embedding |

## Risk Assessment

1. **Phase 3 (Address Computation)** — highest risk. Hash must exactly match off-chain. One wrong bit → address mismatch. Mitigation: sandbox testing.
2. **Phase 2 (Method Calls)** — significant parser refactor. Method chaining needs careful implementation.
3. **Stack management** — Cell/Builder ops consume/produce different stack items. Each builtin must correctly update `ctx.stackDepth`.
4. **Cross-compilation** — embedding Wallet code in Master requires compile-order dependency.

## Message Opcodes Reference

| Message | Opcode | Direction |
|---------|--------|-----------|
| Transfer | 0x0f8a7ea5 | User → Wallet |
| Internal Transfer | 0x178d4519 | Wallet → Wallet |
| Transfer Notification | 0x7362d09c | Wallet → Owner |
| Burn | 0x595f07bc | User → Wallet |
| Burn Notification | 0x7bab48c3 | Wallet → Master |
| Mint | 0x642fcc9f | Admin → Master |
| Excesses | 0xd53276db | Wallet → Response dest |

# TonScript Roadmap

## Completed

### Sprint 1-4: Core Compiler
- [x] Lexer, Parser, AST
- [x] CodeGenerator: AST → TVM instructions
- [x] TVMAssembler: instructions → binary
- [x] BOC Builder: binary → deployable Cell/BOC
- [x] Method dispatch (SETCP 0 + selector branching)
- [x] Counter contract deployed on testnet
- [x] 59 unit tests + 12 sandbox E2E tests

### Sprint 5: Jetton Token (TEP-74)
- [x] Multi-contract compilation (compile by name, compileAll)
- [x] Cell/Builder/Slice API with method chaining
- [x] Address computation (computeStateInit, contractAddressHash, HASHCU)
- [x] JettonMaster + JettonWallet contracts
- [x] Jetton deployed on testnet (Mint + InternalTransfer verified)
- [x] 79 unit + 20 jetton sandbox = 99 tests

### Sprint 6: GitHub + README
- [x] README.md with examples, architecture, comparison table
- [x] LICENSE (MIT)
- [x] GitHub repo (public)

### Sprint 7: Wallet-to-Wallet Transfer
- [x] JettonWallet Transfer + InternalTransfer flow
- [x] Sandbox tests: mint → transfer A→B → verify balances
- [x] Bidirectional transfers, edge cases, conservation checks
- [x] 45 jetton sandbox tests total

### Sprint 8: NFT Contract — Full TEP-62
- [x] NftItem: access control, transfer, ownership_assigned notification, excess return, GetStaticData
- [x] NftCollection: access control, deploy item tracking
- [x] Compiler: sender() extraction from in_msg_cell, msgValue(), send() with body/addr_std
- [x] Bugfix: SENDRAWMSG opcode 0xFB04 (was SETCODE!) → 0xFB00
- [x] boc.ts: sub-dispatch for >3 getters (4-ref cell limit)
- [x] 37 NFT sandbox tests, testnet deployed
- [x] Gas: DeployNftItem 2,297 / TransferNft 5,826 (FunC level, below Tact)

### Sprint 9: CLI Tool
- [x] `tonscript build <file>` — compile to BOC (--contract, --output, --asm)
- [x] `tonscript info <file>` — fields, messages, getters, opcodes, method IDs
- [x] `tonscript test` — discover and run all test suites
- [x] `tonscript deploy <file> --testnet` — compile + show address + explorer link
- [x] `tonscript init [name]` — scaffold new project

### Sprint 10: Map/Dict Type
- [x] TVM opcodes: NEWDICT, STDICT, LDDICT, DICTUSET, DICTUGET, DICTUDEL, DICTISET, DICTIGET, DICTIDEL
- [x] map.set(key, value) and map.delete(key) in codegen
- [x] Map fields as cell refs in storage (LDDICT/STDICT)
- [x] Registry example contract
- [x] 28 registry sandbox tests

### Bug Fixes (8 total)
- [x] CRC16 init: 0xFFFF → 0
- [x] PUSHINT long form: missing 5-bit length field
- [x] THROW/THROWIF/THROWIFNOT: 16-bit → 13-bit prefix
- [x] Method dispatch: SETCP 0 + full selector
- [x] recv_internal: stack cleanup order
- [x] LDVARUINT16: 0xFA01 → 0xFA00 (signed vs unsigned)
- [x] PUSHCONT → PUSHREFCONT for large bodies
- [x] SENDRAWMSG: 0xFB04 (SETCODE!) → 0xFB00

### Stats
- 12 commits, 202 tests (92 unit + 45 jetton + 37 NFT + 28 registry)
- 4 example contracts: Counter, Jetton, NFT, Registry
- 7 contracts deployed on testnet

---

## Phase 2: Developer Tools (Priority: HIGH)

### Sprint 11: Gas Estimation

Goal: Know the cost of every operation before deploying.

- [ ] Gas cost table for all TVM opcodes (static lookup)
- [ ] `tonscript gas <file>` CLI command
- [ ] Per-handler gas breakdown: "receive(TransferNft) = 5,826 gas"
- [ ] Per-opcode cost annotation in --asm output
- [ ] Compare mode: show delta vs previous build
- [ ] Warn on expensive operations (>10K gas)

No existing TON tool does this. Developers currently deploy and pray.

### Sprint 12: Source-Mapped Errors

Goal: Human-readable errors instead of "exit code 7".

- [ ] Source map: TVM instruction index → source file:line:col
- [ ] Map AST positions through codegen pipeline
- [ ] Sandbox error interceptor: catch exit codes → show source location
- [ ] `tonscript test` shows: "Error at nft.ts:69 — require(sender() == this.ownerAddress) failed"
- [ ] Known error codes: 401=unauthorized, 402=insufficient balance, etc.
- [ ] Stack trace reconstruction from TVM vm_logs

### Sprint 13: Formal Verification (Lightweight)

Goal: Catch bugs before they cost money.

- [ ] Invariant annotations: `@invariant balance >= 0`
- [ ] Static analysis: detect unchecked sender(), unreachable code
- [ ] Auto-check: Coins fields never go negative (require before subtract)
- [ ] Auto-check: only owner patterns (sender() == this.owner before state change)
- [ ] Report: "3 invariants verified, 1 warning: no access control on receive(Reset)"

---

## Phase 3: Visualization & UX (Priority: MEDIUM)

### Sprint 14: Visual Contract Explorer

Goal: See your contracts, don't just read them.

- [ ] Web UI: upload .ts → interactive visualization
- [ ] Message flow graph: which contracts talk to which
- [ ] Storage layout diagram: fields, sizes, bit positions
- [ ] Handler flow: condition → action → send chains
- [ ] Gas heatmap: color-code expensive operations
- [ ] Shareable links for audit review

### Sprint 15: LSP + VS Code Extension

Goal: IDE-grade developer experience.

- [ ] Language Server Protocol implementation
- [ ] Syntax highlighting for .ton / .ts contracts
- [ ] Autocomplete: fields, methods, builtins
- [ ] Inline error diagnostics
- [ ] Hover: show gas cost, opcode, stack effect
- [ ] Go-to-definition for fields and messages

---

## Phase 4: Language Completeness (Priority: MEDIUM)

### Sprint 16: Missing Map Operations + Imports
- [ ] map.get(key) → DICTUGET + conditional value parsing
- [ ] map.has(key) → DICTUGET + flag only
- [ ] Import system: `import { Token } from "./token.ts"`
- [ ] Cross-file compilation

### Sprint 17: Types & Patterns
- [ ] Optional types (`Cell?`, `Address?`)
- [ ] String type + TEP-64 on-chain metadata
- [ ] Constants (`const FEE = toNano("0.05")`)
- [ ] Enum types
- [ ] Traits / interfaces (`trait Ownable { ... }`)

---

## Phase 5: Moonshot (Priority: LOW)

### Cross-Chain Compilation
- [ ] One .ts source → TVM (TON) + EVM (Ethereum) + WASM
- [ ] Shared type system across targets
- [ ] Cross-chain message bridges
- [ ] "Write once, deploy everywhere"

### Ecosystem
- [ ] Documentation site
- [ ] Example contracts library (DEX, multisig, auction, escrow)
- [ ] npm publish as `tonscript` package
- [ ] Integration with TON Connect
- [ ] Mainnet deployment support
- [ ] Community: Telegram group, tutorials

---

## Execution Order

```
Phase 1 (DONE)
  Sprints 1-10: Core compiler, Jetton, NFT, CLI, Map
  ↓
Phase 2 (NEXT)
  Sprint 11 (Gas estimation) ──→ Unique selling point
         │
  Sprint 12 (Source maps) ──→ Developer trust
         │
  Sprint 13 (Verification) ──→ Security story
  ↓
Phase 3
  Sprint 14 (Visual explorer) ──→ Wow factor
         │
  Sprint 15 (LSP/VS Code) ──→ Daily driver
  ↓
Phase 4
  Sprint 16 (map.get + imports) ──→ Real projects
         │
  Sprint 17 (Types) ──→ Language maturity
  ↓
Phase 5
  Cross-chain ──→ Moonshot
```

Phase 2 is the immediate priority: make TonScript the best debugging and analysis tool for TON smart contracts.

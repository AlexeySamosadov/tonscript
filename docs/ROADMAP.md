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

### Sprint 5: Jetton Token
- [x] Multi-contract compilation (compile by name, compileAll)
- [x] Cell/Builder/Slice API with method chaining
- [x] Address computation (computeStateInit, contractAddressHash, HASHCU)
- [x] JettonMaster + JettonWallet contracts
- [x] Jetton deployed on testnet (Mint + InternalTransfer verified)
- [x] 79 unit + 20 jetton sandbox = 99 tests

### Bug Fixes (7 total)
- [x] CRC16 init: 0xFFFF → 0
- [x] PUSHINT long form: missing 5-bit length field
- [x] THROW/THROWIF/THROWIFNOT: 16-bit → 13-bit prefix
- [x] Method dispatch: SETCP 0 + full selector
- [x] recv_internal: stack cleanup order
- [x] LDVARUINT16: 0xFA01 → 0xFA00 (signed vs unsigned)
- [x] PUSHCONT → PUSHREFCONT for large bodies

---

## Sprint 6: GitHub + README (Priority: HIGH)

Goal: Make project public and grant-ready.

- [ ] Write README.md with:
  - Project description (TypeScript-like → TVM compiler)
  - Quick start (install, compile, deploy)
  - Syntax examples (counter, jetton)
  - Architecture diagram
  - Testnet deployment links
  - Comparison with Tact/FunC
- [ ] Add LICENSE (MIT)
- [ ] Create GitHub repo (public)
- [ ] Push all 6 commits
- [ ] Add .github/workflows for CI (run tests on push)

Estimated: 1 session

---

## Sprint 7: Wallet-to-Wallet Transfer (Priority: HIGH)

Goal: Prove real Jetton transfer flow on-chain.

- [ ] JettonWallet Transfer handler: compute destination wallet address on-chain
- [ ] Build and send InternalTransfer message to computed address
- [ ] Transfer notification to destination owner
- [ ] Excess TON return to response_destination
- [ ] Sandbox test: mint to Wallet A → transfer from A to B → verify both balances
- [ ] Testnet test: full transfer flow with 2 wallets
- [ ] Bounce handling (failed transfers return tokens)

Dependencies: computeStateInit + contractAddressHash (done), send() enhancement (need full message envelope)

Estimated: 2 sessions

---

## Sprint 8: NFT Contract — TEP-62 (Priority: MEDIUM)

Goal: Show compiler handles multiple standards, not just Jetton.

- [ ] NFT Item contract (TEP-62)
  - Storage: index, collection_address, owner_address, content
  - Transfer handler
  - get_nft_data getter
- [ ] NFT Collection contract
  - Storage: next_item_index, content, owner
  - Deploy item handler
  - get_collection_data getter
  - get_nft_address_by_index getter
- [ ] Sandbox tests
- [ ] Testnet deploy

Dependencies: multi-contract (done), address computation (done)

Estimated: 2 sessions

---

## Sprint 9: CLI Tool (Priority: MEDIUM)

Goal: Developer-friendly command-line interface.

- [ ] `tonscript build <file>` — compile to BOC
- [ ] `tonscript build <file> --contract <name>` — compile specific contract
- [ ] `tonscript test <file>` — run sandbox tests
- [ ] `tonscript deploy <file> --testnet` — deploy to testnet
- [ ] `tonscript deploy <file> --mainnet` — deploy to mainnet (with confirmation)
- [ ] `tonscript init` — scaffold new project
- [ ] npm publish as `tonscript` package
- [ ] npx support: `npx tonscript build counter.ts`

Dependencies: none (build on existing compile/deploy scripts)

Estimated: 1-2 sessions

---

## Sprint 10: Map/Dict Type (Priority: MEDIUM)

Goal: Enable complex contracts (DEX, governance, registries).

- [ ] Parser: `map<K, V>` type (already parsed, needs codegen)
- [ ] CodeGenerator:
  - `map.set(key, value)` → DICTUSET / DICTISET
  - `map.get(key)` → DICTUGET / DICTIGET
  - `map.delete(key)` → DICTUDEL
  - `map.has(key)` → DICTUGET + null check
- [ ] Storage: serialize/deserialize dict as cell ref
- [ ] TVMAssembler: NEWDICT, DICTUSET, DICTUGET, DICTISET, DICTIGET, DICTUDEL
- [ ] Tests: set/get/delete/iterate
- [ ] Example: simple registry contract

Dependencies: Cell ref handling (done)

Estimated: 2-3 sessions

---

## Future (no timeline)

### Language Features
- [ ] Import system (`import { Token } from "./token.ts"`)
- [ ] Traits / interfaces (`trait Ownable { ... }`)
- [ ] Generics (`contract Vault<T> { ... }`)
- [ ] String type + TEP-64 on-chain metadata
- [ ] Optional types (`Cell?`, `Address?`)
- [ ] Enum types
- [ ] Tuple return from getters
- [ ] Constants (`const FEE = toNano("0.05")`)

### Developer Experience
- [ ] LSP (Language Server Protocol) for VS Code
- [ ] Syntax highlighting extension
- [ ] Source maps for debugging
- [ ] Gas estimation
- [ ] Formal verification integration
- [ ] Error messages with source positions

### Ecosystem
- [ ] TON Foundation grant application
- [ ] Documentation site
- [ ] Example contracts library (DEX, multisig, auction, etc.)
- [ ] Integration with TON Connect
- [ ] Mainnet deployment support

---

## Execution Order

```
Sprint 6 (GitHub+README) ──→ Grant application
         │
Sprint 7 (Wallet transfer) ──→ Full Jetton demo
         │
Sprint 8 (NFT) ──→ Multi-standard proof
         │
Sprint 9 (CLI) ──→ Developer adoption
         │
Sprint 10 (Map/Dict) ──→ Complex contracts
```

Sprints 6-7 are the immediate priority: make the project visible and prove the full token transfer flow.

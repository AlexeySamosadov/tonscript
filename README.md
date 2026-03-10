# TonScript

**TypeScript-like language that compiles directly to TVM bytecode for TON blockchain.**

[![Tests](https://img.shields.io/badge/tests-99%20passed-brightgreen)]()
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

---

## What is TonScript?

TonScript lets you write smart contracts for the [TON blockchain](https://ton.org/) using familiar TypeScript syntax. No FunC, no Fift -- just clean, readable code that compiles directly to TVM bytecode.

**Full pipeline:** Source --> Lexer --> Parser --> AST --> CodeGen --> TVM Instructions --> BOC --> Deploy

- Write contracts in TypeScript-like syntax developers already know
- Compiles directly to TVM bytecode -- no intermediate FunC or Fift stages
- Counter contract and Jetton (TEP-74 fungible token) deployed and verified on testnet
- 99 tests (79 unit + 20 sandbox E2E), 0 failures

## Quick Example -- Counter Contract

```typescript
message Increment { amount: uint32 }
message Decrement { amount: uint32 }
message Reset {}

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
```

## Quick Example -- Jetton (TEP-74 Token)

```typescript
message Mint {
  amount: Coins
  toOwner: uint256
}

message Transfer {
  queryId: uint64
  amount: Coins
  toOwner: uint256
  responseAddress: uint256
  forwardTonAmount: Coins
}

contract JettonMaster {
  totalSupply: Coins = 0
  admin: uint256 = 0

  init(admin: uint256) {
    this.admin = admin
  }

  receive(msg: Mint) {
    this.totalSupply += msg.amount
  }

  receive(msg: BurnNotification) {
    this.totalSupply -= msg.amount
  }

  get totalSupply(): Coins {
    return this.totalSupply
  }
}

contract JettonWallet {
  balance: Coins = 0
  ownerAddress: uint256 = 0
  masterAddress: uint256 = 0

  init(owner: uint256, master: uint256) {
    this.ownerAddress = owner
    this.masterAddress = master
  }

  receive(msg: Transfer) {
    require(this.balance >= msg.amount, 402)
    this.balance -= msg.amount
  }

  receive(msg: Burn) {
    require(this.balance >= msg.amount, 402)
    this.balance -= msg.amount
  }

  get balance(): Coins {
    return this.balance
  }
}
```

## Features

### Type System
- Integer types: `uint8` through `uint256`, `int8` through `int256`
- `bool`, `Coins`, `Address`
- `Cell`, `Slice`, `Builder` for low-level TVM operations
- `Map<K, V>` (parsing support, codegen planned)

### Contract Language
- **Messages** with auto-generated CRC32 opcodes (or explicit `message(0x01)`)
- **Receivers** for handling incoming messages (`receive(msg: Transfer)`)
- **Getters** for off-chain queries (`get balance(): Coins`)
- **Init constructors** for deploy-time initialization
- **Control flow:** `if/else`, `while`, `for`, ternary operator
- **Expressions:** arithmetic, comparison, logical, bitwise operators

### Cell/Builder/Slice API
```typescript
let cell = beginCell()
  .storeUint(0x18, 6)
  .storeCoins(amount)
  .storeRef(body)
  .endCell()

let slice = cell.beginParse()
let value = slice.loadUint(32)
```

### Multi-Contract Support
- Compile individual contracts by name or all contracts at once
- Address computation via `computeStateInit` and `contractAddressHash`
- Cross-contract messaging with `send()`

### Built-in Functions
| Function | Description |
|---|---|
| `require(condition, code)` | Assert with exit code |
| `sender()` | Address of message sender |
| `now()` | Current Unix timestamp |
| `myAddress()` | This contract's address |
| `balance()` | Contract's TON balance |
| `accept()` | Accept external message (ACCEPT) |
| `send(addr, amount, body)` | Send internal message |
| `beginCell()` | Create new Builder |
| `emptyCell()` | Create empty Cell |
| `computeStateInit(code, data)` | Build StateInit cell |
| `contractAddressHash(stateInit)` | Compute contract address hash |

## Testnet Deployments

All contracts are live on TON testnet:

| Contract | Address | Explorer |
|---|---|---|
| Counter | `EQAqj08mXzWKGnpR0lp81-oNgT5Z9LG5sdk7IFgQwh4RseIo` | [tonviewer](https://testnet.tonviewer.com/EQAqj08mXzWKGnpR0lp81-oNgT5Z9LG5sdk7IFgQwh4RseIo) |
| JettonMaster | `EQAFce4C31ee55-Z27oqPt-kexRDV4YjCedjbEiiz22H6EdF` | [tonviewer](https://testnet.tonviewer.com/EQAFce4C31ee55-Z27oqPt-kexRDV4YjCedjbEiiz22H6EdF) |
| JettonWallet | `EQAmadA1KJG0vUFqlA8Iyz6aSES9q15Ly6qw9zI0ZI1a6uHk` | [tonviewer](https://testnet.tonviewer.com/EQAmadA1KJG0vUFqlA8Iyz6aSES9q15Ly6qw9zI0ZI1a6uHk) |

## Getting Started

```bash
git clone https://github.com/AlexeySamosadov/tonscript.git
cd tonscript
npm install

# Run unit tests (79 tests)
npx tsx src/test.ts

# Run Counter sandbox E2E tests (12 tests)
npx tsx src/sandbox-test.ts

# Run Jetton sandbox tests (20 tests)
npx tsx src/jetton-sandbox-test.ts
```

## Architecture

```
Source (.ts)
    |
    v
  Lexer (lexer.ts)        -- Tokenizes source into keywords, operators, literals
    |
    v
  Parser (parser.ts)      -- Recursive descent parser produces AST
    |
    v
  AST (ast.ts)            -- Type definitions for all AST nodes
    |
    v
  CodeGen (codegen.ts)    -- Compiles AST to TVM instruction sequences
    |
    v
  TVM Assembler (tvm.ts)  -- Encodes instructions to binary, CRC16/CRC32 hashing
    |
    v
  BOC Builder (boc.ts)    -- Builds deployable Cell/BOC using @ton/core
    |
    v
  Deploy                  -- Send to TON network via toncenter API
```

### File Structure

```
tonscript/
  src/
    lexer.ts               # Tokenizer: source -> Token[]
    parser.ts              # Parser: Token[] -> AST
    ast.ts                 # AST node type definitions
    codegen.ts             # Code generator: AST -> TVM instructions
    tvm.ts                 # TVM instruction types + binary assembler
    boc.ts                 # BOC builder: instructions -> Cell -> BOC
    compiler.ts            # Pipeline orchestrator
    cli.ts                 # CLI entry point
    test.ts                # Unit tests (79 tests)
    sandbox-test.ts        # Counter E2E tests (12 tests)
    jetton-sandbox-test.ts # Jetton E2E tests (20 tests)
    deploy-testnet.ts      # Counter testnet deployment
    deploy-jetton-testnet.ts # Jetton testnet deployment
  examples/
    counter.ts             # Counter contract
    jetton.ts              # JettonMaster + JettonWallet contracts
  docs/
    ARCHITECTURE.md        # Detailed architecture documentation
    ROADMAP.md             # Development roadmap
```

For detailed architecture documentation, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Roadmap

**Completed:**
- Sprints 1-4: Core compiler (lexer, parser, codegen, TVM assembler, BOC builder)
- Sprint 5: Jetton token (multi-contract, Cell/Builder/Slice API, address computation)
- 7 critical bug fixes across the TVM instruction encoding

**Next:**
- Sprint 7: Wallet-to-wallet Jetton transfers on-chain
- Sprint 8: NFT contracts (TEP-62)
- Sprint 9: CLI tool (`tonscript build`, `tonscript deploy`)
- Sprint 10: Map/Dict type for complex contracts (DEX, governance)
- Future: Import system, traits, LSP for VS Code, documentation site

For the full roadmap, see [docs/ROADMAP.md](docs/ROADMAP.md).

## Comparison with Alternatives

| Feature | TonScript | Tact | FunC |
|---|---|---|---|
| Syntax | TypeScript-like | Swift-like | C-like |
| Learning curve | Low (familiar syntax) | Medium | High |
| Compilation | Direct to TVM | Via FunC | Direct to Fift |
| Type safety | Strong | Strong | Weak |
| Cell/Builder API | Method chaining | Method chaining | Manual |
| Multi-contract | Yes | Yes | Manual |
| Status | Alpha | Production | Production |

## License

[MIT](LICENSE) -- Copyright 2026 Alexey Samosadov

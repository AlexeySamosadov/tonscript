# TonScript Architecture

## Compiler Pipeline

```
Source (.ts) → Lexer → Tokens → Parser → AST → CodeGenerator → TVM Instructions → TVMAssembler → Binary → BOC Builder → Cell/BOC
```

## File Structure

```
tonscript/
├── src/
│   ├── lexer.ts          # Tokenizer: source → Token[]
│   ├── parser.ts         # Parser: Token[] → AST (Program)
│   ├── ast.ts            # AST node definitions (types, exprs, stmts, decls)
│   ├── codegen.ts        # Code generator: AST → TVMInst[]
│   ├── tvm.ts            # TVM instruction types + binary assembler (TVMAssembler)
│   ├── boc.ts            # BOC builder: TVMInst[] → Cell → BOC buffer
│   ├── compiler.ts       # Pipeline orchestrator: compile(source) → CompileResult
│   ├── cli.ts            # CLI entry point
│   ├── test.ts           # Unit tests (59 tests)
│   ├── sandbox-test.ts   # E2E tests with @ton/sandbox (12 tests)
│   └── deploy-testnet.ts # Testnet deployment script
├── examples/
│   └── counter.ts        # Counter contract example
├── docs/
│   ├── ARCHITECTURE.md   # This file
│   └── JETTON_PLAN.md    # Jetton implementation plan
└── package.json
```

## Key Components

### Lexer (lexer.ts)
- Tokenizes TonScript source into keyword, operator, literal, and punctuation tokens
- Keywords: contract, message, receive, get, let, if, else, while, for, return, init, require, send, etc.
- Types: uint8..uint256, int8..int256, bool, coins, address, Cell, Slice, Builder, Map

### Parser (parser.ts)
- Recursive descent parser
- Produces AST with: Program → Declaration[] (ContractDecl, MessageDecl)
- ContractDecl contains: fields, receivers, getters, init
- Expressions: NumberLit, BoolLit, BinaryExpr, UnaryExpr, CallExpr, FieldAccess, MemberExpr, etc.

### AST (ast.ts)
- Type definitions for all AST nodes
- TypeExpr: IntType, BoolType, CoinsType, AddressType, CellType, SliceType, BuilderType, MapType
- Expr: NumberLit, BoolLit, Ident, BinaryExpr, UnaryExpr, CallExpr, ThisFieldExpr, MemberExpr, etc.
- Stmt: ExprStmt, AssignStmt, LetStmt, ReturnStmt, IfStmt, WhileStmt, ForStmt

### CodeGenerator (codegen.ts)
- Compiles AST → TVMInst[] (TVM instruction sequences)
- Generates: recv_internal, getters, stateInit, full method dispatch
- Stack-based code generation with manual stackDepth tracking
- Storage: auto-serialization of contract fields to c4 register
- Method dispatch: SETCP 0 → DUP selector → EQINT/EQUAL → PUSHCONT/IFJMP

### TVM Assembler (tvm.ts)
- TVMInst union type — all supported TVM opcodes
- TVMAssembler class — encodes instructions to binary bits
- methodId() — CRC16-XMODEM based method ID computation
- messageOpcode() — CRC32 based message opcode computation
- Supported opcodes: arithmetic, stack, control flow, cell ops, crypto, send, etc.

### BOC Builder (boc.ts)
- instsToCell() — converts TVMInst[] → @ton/core Cell
- buildContractBoc() — builds complete contract: code cell + data cell + stateInit + address
- Handles PUSHCONT → PUSHREFCONT conversion for large continuations
- Produces deployable BOC buffer

## TVM Stack Convention

### recv_internal entry
Stack (top to bottom): `in_msg_body, in_msg_cell, bounce, msg_value`
After method dispatch drops selector (function_id = 0).

### Getter entry
Stack: empty (method_id passed out-of-band by TVM executor).
After method dispatch drops function_id.

### Storage on stack
After genLoadStorage(): `field_0, field_1, ..., field_N-1` (field_0 deepest).
CodeGenerator tracks stackDepth and baseOffset for correct field access.

## Testnet Deployment

- Wallet: `EQBqBoSul09tYmfCwgYjS_ecIKtCrUoyJuGojzhjE8O7AB9t` (V4R2, testnet)
- Counter contract: `EQAqj08mXzWKGnpR0lp81-oNgT5Z9LG5sdk7IFgQwh4RseIo`
- API: toncenter testnet (rate limited without API key, use 2.5s throttle)

## Known Bugs Fixed (Sprint 4)

1. CRC16 init: 0xFFFF → 0 (CRC16-XMODEM standard)
2. PUSHINT long form: added missing 5-bit length field
3. THROW/THROWIF/THROWIFNOT: 16-bit → 13-bit prefix (24-bit total)
4. Method dispatch: added SETCP 0 + full selector branching
5. recv_internal: fixed stack cleanup order

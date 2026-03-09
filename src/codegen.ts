// ============================================================
// TonScript Code Generator: AST → TVM Instructions
// Compiles contracts directly to TVM bytecode — no FunC, no Fift
// ============================================================

import * as AST from "./ast.js";
import { TVMInst, methodId, messageOpcode } from "./tvm.js";

type StorageField = {
  name: string;
  type: AST.TypeExpr;
  bits: number;        // bit width for serialization
  index: number;       // position in storage
};

type LocalVar = {
  name: string;
  stackPos: number;    // relative stack position
};

export class CodeGenerator {
  private contract!: AST.ContractDecl;
  private messages: Map<string, AST.MessageDecl> = new Map();
  private storageFields: StorageField[] = [];

  generate(program: AST.Program, contractName?: string): {
    recvInternal: TVMInst[];
    getters: { name: string; id: number; code: TVMInst[] }[];
    stateInit: TVMInst[];
    asmFull: TVMInst[];
  } {
    // Collect messages (shared across all contracts)
    for (const decl of program.declarations) {
      if (decl.kind === "MessageDecl") {
        this.messages.set(decl.name, decl);
      }
    }

    // Find contract by name, or first contract if no name given
    let contract: AST.ContractDecl | undefined;
    if (contractName) {
      contract = program.declarations.find(
        d => d.kind === "ContractDecl" && d.name === contractName
      ) as AST.ContractDecl | undefined;
      if (!contract) throw new Error(`Contract "${contractName}" not found`);
    } else {
      contract = program.declarations.find(d => d.kind === "ContractDecl") as AST.ContractDecl | undefined;
      if (!contract) throw new Error("No contract found");
    }
    this.contract = contract;

    // Build storage layout
    this.storageFields = contract.fields.map((f, i) => ({
      name: f.name,
      type: f.type,
      bits: this.typeBits(f.type),
      index: i,
    }));

    // Generate recv_internal
    const recvInternal = this.genRecvInternal();

    // Generate getters
    const getters = contract.getters.map(g => ({
      name: g.name,
      id: methodId(g.name),
      code: this.genGetter(g),
    }));

    // Generate state init (for deploy)
    const stateInit = this.genStateInit();

    // Generate full assembly with method dispatch
    const asmFull = this.genFullCode(recvInternal, getters);

    return { recvInternal, getters, stateInit, asmFull };
  }

  // ── Storage layout ───────────────────────────────────────

  private typeBits(type: AST.TypeExpr): number {
    switch (type.kind) {
      case "IntType": return type.bits;
      case "BoolType": return 1;
      case "CoinsType": return 0; // VarUInt16, handled specially
      case "AddressType": return 267; // MsgAddressInt
      default: return 256; // fallback
    }
  }

  private isVarLength(type: AST.TypeExpr): boolean {
    return type.kind === "CoinsType";
  }

  // ── Load all storage fields from c4 ──────────────────────

  private genLoadStorage(): TVMInst[] {
    const insts: TVMInst[] = [];
    insts.push({ op: "COMMENT", text: "Load storage from c4" });
    insts.push({ op: "PUSHCTR", reg: 4 });  // push c4
    insts.push({ op: "CTOS" });              // cell → slice

    for (const field of this.storageFields) {
      if (this.isVarLength(field.type)) {
        insts.push({ op: "LDVARUINT16" }); // stack: [... remaining_slice value]
      } else {
        if (field.type.kind === "BoolType") {
          insts.push({ op: "LDI", bits: 1 });
        } else if (field.type.kind === "IntType" && field.type.signed) {
          insts.push({ op: "LDI", bits: field.bits });
        } else {
          insts.push({ op: "LDU", bits: field.bits });
        }
      }
    }
    insts.push({ op: "ENDS" }); // assert end of slice (or just DROP)

    // After loading, stack has: [field_n, field_n-1, ..., field_0] (reversed order from LDx)
    // Actually LDU leaves [remaining_slice, value] so after all loads:
    // Stack: [value_0, value_1, ..., value_n] (top to bottom, last loaded on top)
    // We need to reorganize. Actually LDU pushes: old_stack... remaining_slice → old_stack... value remaining_slice
    // So after loading N fields: stack = [orig... val_0 val_1 ... val_N-1 remaining_slice]
    // After ENDS/DROP: stack = [orig... val_0 val_1 ... val_N-1]

    return insts;
  }

  // ── Save all storage fields to c4 ────────────────────────

  private genSaveStorage(localOffset: number): TVMInst[] {
    const insts: TVMInst[] = [];
    insts.push({ op: "COMMENT", text: "Save storage to c4" });
    insts.push({ op: "NEWC" }); // new builder

    // Fields are on stack. We need to access them by stack position.
    // After NEWC, builder is at s0.
    // Fields are at s(1 + i) where i is the field index from the bottom.
    // But we need to know their exact positions.

    for (let i = 0; i < this.storageFields.length; i++) {
      const field = this.storageFields[i];
      // Push the field value to top of stack
      // Field i is at stack position: (storageFields.length - i) + localOffset
      const stackIdx = this.storageFields.length - i + localOffset;
      insts.push({ op: "PUSH", i: stackIdx });
      // Swap with builder (which is now at s1 after the push)

      if (this.isVarLength(field.type)) {
        insts.push({ op: "STVARUINT16" });
      } else if (field.type.kind === "BoolType") {
        insts.push({ op: "STI", bits: 1 });
      } else if (field.type.kind === "IntType" && field.type.signed) {
        insts.push({ op: "XCHG", i: 1 }); // swap value and builder
        insts.push({ op: "STI", bits: field.bits });
      } else {
        insts.push({ op: "XCHG", i: 1 });
        insts.push({ op: "STU", bits: field.bits });
      }
    }

    insts.push({ op: "ENDC" });
    insts.push({ op: "POPCTR", reg: 4 });  // save to c4

    return insts;
  }

  // ── recv_internal ────────────────────────────────────────

  private genRecvInternal(): TVMInst[] {
    const insts: TVMInst[] = [];
    insts.push({ op: "COMMENT", text: "recv_internal" });

    // Stack at entry: [msg_value bounce in_msg_cell in_msg_body]
    // in_msg_body (Slice) is at s0

    if (this.contract.receivers.length === 0) {
      // No handlers — just return
      insts.push({ op: "POP", i: 0 }); // drop in_msg_body
      insts.push({ op: "POP", i: 0 }); // drop in_msg_cell
      insts.push({ op: "POP", i: 0 }); // drop bounce
      insts.push({ op: "POP", i: 0 }); // drop msg_value
      return insts;
    }

    // Load op code from message body
    insts.push({ op: "COMMENT", text: "Parse op from in_msg_body" });
    // in_msg_body is at s0
    insts.push({ op: "LDU", bits: 32 }); // stack: [msg_value bounce in_msg_cell op remaining_body]
    // Keep remaining_body — we'll need it to parse message fields

    // Drop unused args (but keep op and remaining_body)
    // stack: [msg_value bounce in_msg_cell op remaining_body]
    // We want to drop msg_value, bounce, in_msg_cell (positions s4, s3, s2)
    insts.push({ op: "XCHG", i: 4 }); // swap remaining_body(s0) and msg_value(s4)
    insts.push({ op: "POP", i: 0 });   // drop msg_value (was at s4, now at s0)
    // stack: [remaining_body bounce in_msg_cell op]
    insts.push({ op: "XCHG", i: 2 }); // swap op(s0) and bounce(s2)
    insts.push({ op: "POP", i: 0 });   // drop bounce
    // stack: [in_msg_cell op remaining_body]
    insts.push({ op: "POP", i: 0 });   // drop in_msg_cell (already at s0)
    // stack: [op remaining_body]

    // Load storage
    const loadStorage = this.genLoadStorage();
    insts.push(...loadStorage);
    // stack: [remaining_body, op, field_0, field_1, ..., field_N-1]

    // Generate handlers for each receiver
    for (let r = 0; r < this.contract.receivers.length; r++) {
      const receiver = this.contract.receivers[r];
      const msgDecl = this.messages.get(receiver.param.type.kind === "NamedType" ? receiver.param.type.name : "");
      const opcode = msgDecl?.opcode ?? messageOpcode(msgDecl?.name ?? `msg_${r}`);

      insts.push({ op: "COMMENT", text: `Handler: ${msgDecl?.name ?? receiver.param.name}` });

      // DUP op, compare with expected opcode
      insts.push({ op: "PUSH", i: this.storageFields.length }); // push op (it's below all fields)
      insts.push({ op: "PUSHINT", value: BigInt(opcode) });
      insts.push({ op: "EQUAL" });

      // Generate handler body
      const handlerBody = this.genHandlerBody(receiver);

      insts.push({ op: "PUSHCONT", body: handlerBody });
      insts.push({ op: "IFJMP" });
    }

    // No handler matched — save storage and return
    // localOffset = items above storage fields = 0 (op and remaining_body are below)
    const saveStorage = this.genSaveStorage(0);
    insts.push(...saveStorage);
    // Drop fields from stack
    for (let i = 0; i < this.storageFields.length; i++) {
      insts.push({ op: "POP", i: 0 });
    }
    insts.push({ op: "POP", i: 0 }); // drop op
    insts.push({ op: "POP", i: 0 }); // drop remaining_body

    return insts;
  }

  // ── Handler body generation ──────────────────────────────

  private genHandlerBody(receiver: AST.ReceiveDecl): TVMInst[] {
    const insts: TVMInst[] = [];
    const locals: Map<string, number> = new Map();

    // Stack entering handler:
    //   [remaining_body, op, field_0, field_1, ..., field_N-1]
    //   s(N+1)=remaining_body, sN=op, s(N-1)=field_0, ..., s0=field_N-1
    let stackDepth = this.storageFields.length + 2; // N fields + op + remaining_body

    // Look up the message declaration for this receiver
    const msgName = receiver.param.type.kind === "NamedType" ? receiver.param.type.name : "";
    const msgDecl = this.messages.get(msgName);
    const paramName = receiver.param.name; // e.g., "msg"

    if (msgDecl && msgDecl.fields.length > 0) {
      // Copy remaining_body to top of stack for parsing
      const rbPos = this.storageFields.length + 1;
      insts.push({ op: "PUSH", i: rbPos });
      stackDepth++;
      // s0 = remaining_body_copy (slice)

      // Parse each message field using LDU/LDI
      // TVM LDU n: Slice -> value Slice'  (value at s1, Slice' at s0)
      for (const field of msgDecl.fields) {
        const bits = this.typeBits(field.type);
        if (this.isVarLength(field.type)) {
          insts.push({ op: "LDVARUINT16" });
        } else if (field.type.kind === "BoolType") {
          insts.push({ op: "LDI", bits: 1 });
        } else if (field.type.kind === "IntType" && field.type.signed) {
          insts.push({ op: "LDI", bits });
        } else {
          insts.push({ op: "LDU", bits });
        }
        stackDepth++; // LDU: 1 in (slice) -> 2 out (value + slice'), net +1
      }

      // Drop the leftover slice
      insts.push({ op: "POP", i: 0 });
      stackDepth--;

      // Stack trace for 1 field (amount: uint32):
      //   PUSH rbPos:           s0=slice_copy, s1=field_N-1, ...
      //   LDU 32:               s0=slice', s1=amount, s2=field_N-1, ...
      //   POP 0 (drop slice'):  s0=amount, s1=field_N-1, ..., s(N+1)=op, s(N+2)=remaining_body
      //
      // For 2 fields (amount, other):
      //   PUSH rbPos:    s0=slice_copy
      //   LDU 32:        s0=slice', s1=amount
      //   LDU 32:        s0=slice'', s1=other, s2=amount
      //   POP 0:         s0=other, s1=amount, s2=field_N-1, ...
      //
      // Parsed msg fields are on top in REVERSE declaration order:
      //   s0 = last_field, ..., s(M-1) = first_field
      //   where M = msgDecl.fields.length

      // Register message field locals (absolute stack positions)
      const M = msgDecl.fields.length;
      for (let fi = 0; fi < M; fi++) {
        // Field fi (declaration order, 0=first) was parsed first, pushed deepest.
        // From top: s(M-1-fi) = field fi
        // Absolute position = stackDepth - 1 - (M - 1 - fi)
        const localName = `${paramName}.${msgDecl.fields[fi].name}`;
        locals.set(localName, stackDepth - 1 - (M - 1 - fi));
      }

      // The original remaining_body is still deep in the stack.
      // We leave it there and account for it via stackDepth.
    }

    // Generate code for each statement in the handler body
    const ctx: CodegenContext = {
      locals,
      storageFields: this.storageFields,
      stackDepth,
      baseOffset: 2, // op + remaining_body sit below storage fields
      isReceiver: true,
    };

    for (const stmt of receiver.body.stmts) {
      insts.push(...this.genStmt(stmt, ctx));
    }

    // Save storage
    const localOffset = ctx.stackDepth - this.storageFields.length - ctx.baseOffset;
    insts.push(...this.genSaveStorage(localOffset));

    // Clean up entire stack
    for (let i = 0; i < ctx.stackDepth; i++) {
      insts.push({ op: "POP", i: 0 });
    }

    return insts;
  }

  // ── Statement generation ─────────────────────────────────

  private genStmt(stmt: AST.Stmt, ctx: CodegenContext): TVMInst[] {
    switch (stmt.kind) {
      case "ExprStmt":
        return this.genExprStmt(stmt, ctx);
      case "AssignStmt":
        return this.genAssignStmt(stmt, ctx);
      case "LetStmt":
        return this.genLetStmt(stmt, ctx);
      case "ReturnStmt":
        return this.genReturnStmt(stmt, ctx);
      case "IfStmt":
        return this.genIfStmt(stmt, ctx);
      case "WhileStmt":
        return this.genWhileStmt(stmt, ctx);
      case "ForStmt":
        return this.genForStmt(stmt, ctx);
      default:
        return [{ op: "COMMENT", text: `TODO: ${stmt.kind}` }];
    }
  }

  private static VOID_BUILTINS = new Set(["require", "accept", "nativeReserve", "send"]);

  private genExprStmt(stmt: AST.ExprStmt, ctx: CodegenContext): TVMInst[] {
    const insts = this.genExpr(stmt.expr, ctx);
    // Drop result if expression produces a value
    const isVoidCall = stmt.expr.kind === "CallExpr" &&
      CodeGenerator.VOID_BUILTINS.has(stmt.expr.callee);
    if (!isVoidCall) {
      insts.push({ op: "POP", i: 0 });
      ctx.stackDepth--;
    }
    return insts;
  }

  private genAssignStmt(stmt: AST.AssignStmt, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];

    if (stmt.target.kind === "FieldAccess") {
      const fieldIdx = this.storageFields.findIndex(f => f.name === stmt.target.field);
      if (fieldIdx === -1) throw new Error(`Unknown field: ${stmt.target.field}`);

      // Field position on stack (fields are stored with field_0 at bottom)
      // s(N-1-fieldIdx) where N = storageFields.length
      const fieldStackPos = this.storageFields.length - 1 - fieldIdx;
      const actualPos = fieldStackPos + (ctx.stackDepth - this.storageFields.length - ctx.baseOffset);

      if (stmt.op === "=") {
        // Generate value
        insts.push(...this.genExpr(stmt.value, ctx));
        // Pop new value into field position
        insts.push({ op: "POP", i: actualPos + 1 }); // +1 because value is on top
        ctx.stackDepth--;
      } else {
        // Compound assignment: load, compute, store
        insts.push({ op: "PUSH", i: actualPos });
        ctx.stackDepth++;
        insts.push(...this.genExpr(stmt.value, ctx));
        switch (stmt.op) {
          case "+=": insts.push({ op: "ADD" }); break;
          case "-=": insts.push({ op: "SUB" }); break;
          case "*=": insts.push({ op: "MUL" }); break;
        }
        ctx.stackDepth--;
        insts.push({ op: "POP", i: actualPos + 1 });
        ctx.stackDepth--;
      }
    } else if (stmt.target.kind === "VarAccess") {
      const varPos = ctx.locals.get(stmt.target.name);
      if (varPos === undefined) throw new Error(`Unknown variable: ${stmt.target.name}`);

      const actualPos = ctx.stackDepth - 1 - varPos;

      if (stmt.op === "=") {
        insts.push(...this.genExpr(stmt.value, ctx));
        insts.push({ op: "POP", i: actualPos + 1 });
        ctx.stackDepth--;
      } else {
        insts.push({ op: "PUSH", i: actualPos });
        ctx.stackDepth++;
        insts.push(...this.genExpr(stmt.value, ctx));
        switch (stmt.op) {
          case "+=": insts.push({ op: "ADD" }); break;
          case "-=": insts.push({ op: "SUB" }); break;
          case "*=": insts.push({ op: "MUL" }); break;
        }
        ctx.stackDepth--;
        insts.push({ op: "POP", i: actualPos + 1 });
        ctx.stackDepth--;
      }
    }

    return insts;
  }

  private genLetStmt(stmt: AST.LetStmt, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];
    insts.push(...this.genExpr(stmt.value, ctx));
    // Value is now on top of stack
    ctx.locals.set(stmt.name, ctx.stackDepth - 1);
    // stackDepth already incremented by genExpr
    return insts;
  }

  private genReturnStmt(stmt: AST.ReturnStmt, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];
    if (stmt.value) {
      insts.push(...this.genExpr(stmt.value, ctx));
    }
    // For getters, the return value stays on stack (no RET needed)
    // For receivers, save storage and clean up stack before RET
    if (ctx.isReceiver) {
      const localOffset = ctx.stackDepth - this.storageFields.length - ctx.baseOffset;
      insts.push(...this.genSaveStorage(localOffset));
      // Clean up entire stack
      for (let i = 0; i < ctx.stackDepth; i++) {
        insts.push({ op: "POP", i: 0 });
      }
      insts.push({ op: "RET" });
    }
    return insts;
  }

  private genIfStmt(stmt: AST.IfStmt, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];

    // Generate condition
    insts.push(...this.genExpr(stmt.condition, ctx));

    // IF/IFELSE consumes the condition BEFORE executing branch bodies,
    // so decrement stackDepth before generating branches.
    ctx.stackDepth--;

    // Generate then branch
    const thenInsts: TVMInst[] = [];
    for (const s of stmt.then.stmts) {
      thenInsts.push(...this.genStmt(s, ctx));
    }

    if (stmt.else_) {
      // IF-ELSE
      const elseInsts: TVMInst[] = [];
      if (stmt.else_.kind === "IfStmt") {
        elseInsts.push(...this.genIfStmt(stmt.else_, ctx));
      } else {
        for (const s of stmt.else_.stmts) {
          elseInsts.push(...this.genStmt(s, ctx));
        }
      }
      insts.push({ op: "PUSHCONT", body: thenInsts });
      insts.push({ op: "PUSHCONT", body: elseInsts });
      insts.push({ op: "IFELSE" });
    } else {
      // IF only
      insts.push({ op: "PUSHCONT", body: thenInsts });
      insts.push({ op: "IF" });
    }

    return insts;
  }

  private genWhileStmt(stmt: AST.WhileStmt, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];

    // Generate condition continuation
    const condInsts: TVMInst[] = [];
    condInsts.push(...this.genExpr(stmt.condition, ctx));

    // Generate body continuation
    const bodyInsts: TVMInst[] = [];
    for (const s of stmt.body.stmts) {
      bodyInsts.push(...this.genStmt(s, ctx));
    }

    insts.push({ op: "PUSHCONT", body: condInsts });
    insts.push({ op: "PUSHCONT", body: bodyInsts });
    insts.push({ op: "WHILE" });

    return insts;
  }

  private genForStmt(stmt: AST.ForStmt, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];

    // Compile for(init; cond; update) { body } as:
    //   init; while(cond) { body; update; }
    insts.push(...this.genStmt(stmt.init, ctx));

    // Generate condition continuation
    const condInsts: TVMInst[] = [];
    condInsts.push(...this.genExpr(stmt.condition, ctx));

    // Generate body + update continuation
    const bodyInsts: TVMInst[] = [];
    for (const s of stmt.body.stmts) {
      bodyInsts.push(...this.genStmt(s, ctx));
    }
    bodyInsts.push(...this.genStmt(stmt.update, ctx));

    insts.push({ op: "PUSHCONT", body: condInsts });
    insts.push({ op: "PUSHCONT", body: bodyInsts });
    insts.push({ op: "WHILE" });

    return insts;
  }

  // ── Expression generation ────────────────────────────────
  // Each genExpr pushes exactly ONE value onto the stack

  private genExpr(expr: AST.Expr, ctx: CodegenContext): TVMInst[] {
    switch (expr.kind) {
      case "NumberLit":
        ctx.stackDepth++;
        return [{ op: "PUSHINT", value: expr.value }];

      case "BoolLit":
        ctx.stackDepth++;
        return [{ op: "PUSHINT", value: expr.value ? -1n : 0n }];
        // TVM uses -1 for true, 0 for false

      case "NullLit":
        ctx.stackDepth++;
        return [{ op: "PUSHINT", value: 0n }];

      case "ThisFieldExpr": {
        const fieldIdx = this.storageFields.findIndex(f => f.name === expr.field);
        if (fieldIdx === -1) throw new Error(`Unknown field: ${expr.field}`);
        const fieldStackPos = this.storageFields.length - 1 - fieldIdx;
        const actualPos = fieldStackPos + (ctx.stackDepth - this.storageFields.length - ctx.baseOffset);
        ctx.stackDepth++;
        return [{ op: "PUSH", i: actualPos }];
      }

      case "Ident": {
        const varPos = ctx.locals.get(expr.name);
        if (varPos !== undefined) {
          const actualPos = ctx.stackDepth - 1 - varPos;
          ctx.stackDepth++;
          return [{ op: "PUSH", i: actualPos }];
        }
        throw new Error(`Unknown variable: ${expr.name}`);
      }

      case "MemberExpr": {
        // Look up "object.field" (e.g., "msg.amount") in locals
        const key = `${expr.object}.${expr.field}`;
        const memberPos = ctx.locals.get(key);
        if (memberPos !== undefined) {
          const actualPos = ctx.stackDepth - 1 - memberPos;
          ctx.stackDepth++;
          return [{ op: "PUSH", i: actualPos }];
        }
        throw new Error(`Unknown member: ${key}`);
      }

      case "BinaryExpr":
        return this.genBinaryExpr(expr, ctx);

      case "UnaryExpr":
        return this.genUnaryExpr(expr, ctx);

      case "CallExpr":
        return this.genCallExpr(expr, ctx);

      case "MethodCallExpr":
        return this.genMethodCallExpr(expr, ctx);

      default:
        ctx.stackDepth++;
        return [
          { op: "COMMENT", text: `TODO: expr ${expr.kind}` },
          { op: "PUSHINT", value: 0n },
        ];
    }
  }

  private genBinaryExpr(expr: AST.BinaryExpr, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];

    // Optimization: x + 1, x - 1
    if ((expr.op === "+" || expr.op === "-") &&
        expr.right.kind === "NumberLit" &&
        expr.right.value >= -128n && expr.right.value <= 127n) {
      insts.push(...this.genExpr(expr.left, ctx));
      const val = Number(expr.right.value);
      if (expr.op === "+" && val === 1) {
        insts.push({ op: "INC" });
      } else if (expr.op === "-" && val === 1) {
        insts.push({ op: "DEC" });
      } else {
        insts.push({ op: "ADDCONST", value: expr.op === "+" ? val : -val });
      }
      return insts;
    }

    // Optimization: x == 0, x != 0
    if ((expr.op === "==" || expr.op === "!=") &&
        expr.right.kind === "NumberLit" &&
        expr.right.value >= -128n && expr.right.value <= 127n) {
      insts.push(...this.genExpr(expr.left, ctx));
      if (expr.op === "==") {
        insts.push({ op: "EQINT", value: Number(expr.right.value) });
      } else {
        insts.push({ op: "NEQINT", value: Number(expr.right.value) });
      }
      return insts;
    }

    // Short-circuit && and ||
    if (expr.op === "&&") {
      // Evaluate left; if falsy, result is 0; otherwise evaluate right
      insts.push(...this.genExpr(expr.left, ctx));
      // Left result is on stack. Save stackDepth for branches.
      const savedDepth = ctx.stackDepth;

      // Right branch: drop left, evaluate right
      ctx.stackDepth = savedDepth - 1; // IF consumes condition before executing
      const rightInsts: TVMInst[] = [];
      rightInsts.push(...this.genExpr(expr.right, ctx));
      // After right branch, stackDepth = savedDepth (one was consumed by IF, one was pushed by genExpr)

      // False branch: push 0
      const falseInsts: TVMInst[] = [{ op: "PUSHINT", value: 0n }];

      ctx.stackDepth = savedDepth; // net result: left consumed, one value produced
      insts.push({ op: "PUSHCONT", body: rightInsts });
      insts.push({ op: "PUSHCONT", body: falseInsts });
      insts.push({ op: "IFELSE" });
      // IFELSE consumes condition + 2 conts, one branch pushes result
      // Net: left was consumed, one value remains = same as before
      return insts;
    }

    if (expr.op === "||") {
      // Evaluate left; if truthy, result is -1 (true); otherwise evaluate right
      insts.push(...this.genExpr(expr.left, ctx));
      const savedDepth = ctx.stackDepth;

      // True branch: push -1 (TVM true)
      const trueInsts: TVMInst[] = [{ op: "PUSHINT", value: -1n }];

      // Right branch: evaluate right
      ctx.stackDepth = savedDepth - 1;
      const rightInsts: TVMInst[] = [];
      rightInsts.push(...this.genExpr(expr.right, ctx));

      ctx.stackDepth = savedDepth;
      insts.push({ op: "PUSHCONT", body: trueInsts });
      insts.push({ op: "PUSHCONT", body: rightInsts });
      insts.push({ op: "IFELSE" });
      return insts;
    }

    // General case: evaluate left, then right, then op
    insts.push(...this.genExpr(expr.left, ctx));
    insts.push(...this.genExpr(expr.right, ctx));

    const opMap: Partial<Record<AST.BinaryOp, TVMInst>> = {
      "+":  { op: "ADD" },
      "-":  { op: "SUB" },
      "*":  { op: "MUL" },
      "/":  { op: "DIV" },
      "%":  { op: "MOD" },
      "==": { op: "EQUAL" },
      "!=": { op: "NEQ" },
      "<":  { op: "LESS" },
      ">":  { op: "GREATER" },
      "<=": { op: "LEQ" },
      ">=": { op: "GEQ" },
      "&":  { op: "AND" },
      "|":  { op: "OR" },
      "^":  { op: "XOR" },
      "<<": { op: "LSHIFT" },
      ">>": { op: "RSHIFT" },
    };

    const tvmOp = opMap[expr.op];
    if (tvmOp) {
      insts.push(tvmOp);
      ctx.stackDepth--; // binary op consumes 2, produces 1
    } else {
      throw new Error(`Unsupported binary op: ${expr.op}`);
    }

    return insts;
  }

  private genUnaryExpr(expr: AST.UnaryExpr, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];
    insts.push(...this.genExpr(expr.operand, ctx));
    switch (expr.op) {
      case "-": insts.push({ op: "NEGATE" }); break;
      case "!": insts.push({ op: "NOT" }); break;
    }
    return insts;
  }

  private genCallExpr(expr: AST.CallExpr, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];

    switch (expr.callee) {
      case "require": {
        // require(condition, "error message")
        // → THROWIFNOT errorCode
        insts.push(...this.genExpr(expr.args[0], ctx));
        const errorCode = expr.args.length > 1 && expr.args[1].kind === "NumberLit"
          ? Number(expr.args[1].value)
          : 132; // default error code
        insts.push({ op: "THROWIFNOT", n: errorCode });
        ctx.stackDepth--; // condition consumed
        return insts;
      }

      case "sender": {
        // Load sender address from incoming message
        // In TVM: parse in_msg_cell to get sender
        // Simplified: we store sender in global 1
        ctx.stackDepth++;
        insts.push({ op: "GETGLOB", k: 1 });
        return insts;
      }

      case "now": {
        ctx.stackDepth++;
        insts.push({ op: "NOW" });
        return insts;
      }

      case "myAddress": {
        ctx.stackDepth++;
        insts.push({ op: "MYADDR" });
        return insts;
      }

      case "balance": {
        ctx.stackDepth++;
        insts.push({ op: "BALANCE" });
        return insts;
      }

      case "accept": {
        insts.push({ op: "ACCEPT" });
        return insts;
      }

      case "nativeReserve": {
        insts.push(...this.genExpr(expr.args[0], ctx)); // amount
        insts.push(...this.genExpr(expr.args[1], ctx)); // mode
        insts.push({ op: "RAWRESERVE" });
        ctx.stackDepth -= 2;
        return insts;
      }

      case "send": {
        // send(SendParameters { to, value, mode, body })
        // For now, simplified: send a raw message
        insts.push({ op: "COMMENT", text: "send message (simplified)" });
        // Generate the message body cell
        if (expr.args[0].kind === "StructLitExpr") {
          insts.push(...this.genSendMessage(expr.args[0] as AST.StructLitExpr, ctx));
        }
        return insts;
      }

      case "beginCell": {
        ctx.stackDepth++;
        insts.push({ op: "NEWC" });
        return insts;
      }

      case "emptyCell": {
        ctx.stackDepth++;
        insts.push({ op: "NEWC" });
        insts.push({ op: "ENDC" });
        return insts;
      }

      default:
        throw new Error(`Unknown function: ${expr.callee}`);
    }
  }

  private genMethodCallExpr(expr: AST.MethodCallExpr, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];

    switch (expr.method) {
      // ── Builder methods ──────────────────────────────────
      case "storeUint": {
        // .storeUint(value, bits) → STU bits
        // Stack before: [...], genExpr(object) pushes builder → [..., builder]
        // genExpr(value) pushes value → [..., builder, value]
        // STU expects: value(s1) builder(s0) → builder'(s0)
        // So we need SWAP before STU
        insts.push(...this.genExpr(expr.object, ctx));  // builder on stack
        insts.push(...this.genExpr(expr.args[0], ctx)); // value on stack
        const bitsU = expr.args[1];
        if (bitsU.kind !== "NumberLit") throw new Error("storeUint bits must be a literal");
        insts.push({ op: "XCHG", i: 1 }); // swap value and builder
        insts.push({ op: "STU", bits: Number(bitsU.value) });
        ctx.stackDepth--; // consumes value, builder remains as builder'
        return insts;
      }

      case "storeInt": {
        // .storeInt(value, bits) → STI bits
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push(...this.genExpr(expr.args[0], ctx));
        const bitsI = expr.args[1];
        if (bitsI.kind !== "NumberLit") throw new Error("storeInt bits must be a literal");
        insts.push({ op: "XCHG", i: 1 });
        insts.push({ op: "STI", bits: Number(bitsI.value) });
        ctx.stackDepth--;
        return insts;
      }

      case "storeCoins": {
        // .storeCoins(value) → STVARUINT16
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push(...this.genExpr(expr.args[0], ctx));
        insts.push({ op: "STVARUINT16" });
        ctx.stackDepth--;
        return insts;
      }

      case "storeRef": {
        // .storeRef(cell) → STREF
        // STREF: builder cell → builder' (stores cell as ref)
        insts.push(...this.genExpr(expr.object, ctx));  // builder
        insts.push(...this.genExpr(expr.args[0], ctx)); // cell
        insts.push({ op: "XCHG", i: 1 }); // swap so builder is on top
        insts.push({ op: "STREF" });
        ctx.stackDepth--;
        return insts;
      }

      case "storeSlice": {
        // .storeSlice(slice) → STSLICER
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push(...this.genExpr(expr.args[0], ctx));
        insts.push({ op: "STSLICER" });
        ctx.stackDepth--;
        return insts;
      }

      case "storeAddress": {
        // .storeAddress(addr) → STSLICER (address is stored as slice)
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push(...this.genExpr(expr.args[0], ctx));
        insts.push({ op: "STSLICER" });
        ctx.stackDepth--;
        return insts;
      }

      case "endCell": {
        // .endCell() → ENDC (builder → cell)
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push({ op: "ENDC" });
        // stackDepth unchanged: consumes builder, produces cell
        return insts;
      }

      // ── Cell methods ─────────────────────────────────────
      case "beginParse": {
        // .beginParse() → CTOS (cell → slice)
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push({ op: "CTOS" });
        // stackDepth unchanged: consumes cell, produces slice
        return insts;
      }

      case "hash": {
        // .hash() → HASHCU (cell → uint256)
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push({ op: "HASHCU" });
        return insts;
      }

      // ── Slice methods ────────────────────────────────────
      case "loadUint": {
        // .loadUint(bits) → LDU bits (slice → value slice')
        // Returns the value; the remaining slice is dropped
        insts.push(...this.genExpr(expr.object, ctx));
        const bitsLU = expr.args[0];
        if (bitsLU.kind !== "NumberLit") throw new Error("loadUint bits must be a literal");
        insts.push({ op: "LDU", bits: Number(bitsLU.value) });
        ctx.stackDepth++; // LDU: slice → value slice' (+1)
        // Swap to get value on top, then drop remaining slice
        insts.push({ op: "POP", i: 1 }); // drop remaining slice (s1, under value at s0)
        ctx.stackDepth--;
        // Net: object consumed, value produced = same as before + 0, but we started
        // by pushing object (+1 from genExpr), then LDU gives +1, POP gives -1
        // Total: genExpr pushed 1, net from LDU+POP = 0, so stackDepth = before + 1
        return insts;
      }

      case "loadInt": {
        // .loadInt(bits) → LDI bits
        insts.push(...this.genExpr(expr.object, ctx));
        const bitsLI = expr.args[0];
        if (bitsLI.kind !== "NumberLit") throw new Error("loadInt bits must be a literal");
        insts.push({ op: "LDI", bits: Number(bitsLI.value) });
        ctx.stackDepth++;
        insts.push({ op: "POP", i: 1 });
        ctx.stackDepth--;
        return insts;
      }

      case "loadCoins": {
        // .loadCoins() → LDVARUINT16
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push({ op: "LDVARUINT16" });
        ctx.stackDepth++;
        insts.push({ op: "POP", i: 1 });
        ctx.stackDepth--;
        return insts;
      }

      case "loadRef": {
        // .loadRef() → LDREF (slice → cell slice')
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push({ op: "LDREF" });
        ctx.stackDepth++;
        insts.push({ op: "POP", i: 1 });
        ctx.stackDepth--;
        return insts;
      }

      case "loadAddress": {
        // .loadAddress() → load 267-bit slice (MsgAddressInt)
        // LDSLICE 267 would work but is non-standard width
        // Use LDU 267 then convert — actually addresses are slices
        // For simplicity: LDSLICE 267 bits
        insts.push(...this.genExpr(expr.object, ctx));
        insts.push({ op: "LDSLICE", bits: 267 });
        ctx.stackDepth++;
        insts.push({ op: "POP", i: 1 });
        ctx.stackDepth--;
        return insts;
      }

      default:
        throw new Error(`Unknown method: ${expr.method}`);
    }
  }

  private genSendMessage(structLit: AST.StructLitExpr, ctx: CodegenContext): TVMInst[] {
    const insts: TVMInst[] = [];
    // Build internal message cell
    // For prototype: build a simple internal message
    insts.push({ op: "COMMENT", text: "Build message cell" });
    insts.push({ op: "NEWC" });
    ctx.stackDepth++;

    // Message flags: 0x18 = internal message, non-bounce
    insts.push({ op: "PUSHINT", value: 0x18n });
    ctx.stackDepth++;
    insts.push({ op: "STU", bits: 6 });
    ctx.stackDepth--;

    // Find 'to' field
    const toField = structLit.fields.find(f => f.name === "to");
    if (toField) {
      insts.push(...this.genExpr(toField.value, ctx));
      insts.push({ op: "STSLICER" }); // store address as slice
      ctx.stackDepth--;
    }

    // Value (Coins)
    const valueField = structLit.fields.find(f => f.name === "value");
    if (valueField) {
      insts.push(...this.genExpr(valueField.value, ctx));
      insts.push({ op: "STVARUINT16" });
      ctx.stackDepth--;
    }

    // Empty extra currencies, state init, etc.
    insts.push({ op: "PUSHINT", value: 0n });
    ctx.stackDepth++;
    insts.push({ op: "STU", bits: 107 }); // ihr_disabled+bounce+bounced+src+created_lt+created_at etc.
    ctx.stackDepth--;

    insts.push({ op: "ENDC" }); // builder → cell
    // cell is on stack

    // Mode
    const modeField = structLit.fields.find(f => f.name === "mode");
    let mode = 0;
    if (modeField && modeField.value.kind === "NumberLit") {
      mode = Number(modeField.value.value);
    }
    insts.push({ op: "PUSHINT", value: BigInt(mode) });
    ctx.stackDepth++;

    insts.push({ op: "SENDRAWMSG" });
    ctx.stackDepth -= 2; // consumes cell and mode

    return insts;
  }

  // ── Getter generation ────────────────────────────────────

  private genGetter(getter: AST.GetterDecl): TVMInst[] {
    const insts: TVMInst[] = [];
    insts.push({ op: "COMMENT", text: `Getter: ${getter.name}` });

    // Load storage
    insts.push(...this.genLoadStorage());

    // Set up context
    const ctx: CodegenContext = {
      locals: new Map(),
      storageFields: this.storageFields,
      stackDepth: this.storageFields.length,
      baseOffset: 0, // nothing below storage fields in getter context
    };

    // Map getter params (if any) to locals
    // Getter params are below storage fields on stack (pushed by caller)

    // Generate body
    for (const stmt of getter.body.stmts) {
      insts.push(...this.genStmt(stmt, ctx));
    }

    // Return value is on top of stack
    // Clean up storage fields below it
    // The return value is at s0, fields at s1..sN
    // We need to keep s0 and drop the rest
    if (this.storageFields.length > 0) {
      insts.push({ op: "XCHG", i: this.storageFields.length }); // move result down
      for (let i = 0; i < this.storageFields.length; i++) {
        insts.push({ op: "POP", i: 0 }); // drop fields
      }
    }

    return insts;
  }

  // ── State Init generation (for deploy) ───────────────────

  private genStateInit(): TVMInst[] {
    const insts: TVMInst[] = [];
    insts.push({ op: "COMMENT", text: "State init (deploy data)" });

    const initDecl = this.contract.init;

    if (initDecl && initDecl.body.stmts.length > 0) {
      // init() has a body — compile it.
      // Strategy:
      // 1. Push default field values onto stack (these are the initial storage)
      // 2. Set up context with init params (assumed on stack from caller, below fields)
      // 3. Execute init body (which does this.field = ... assignments)
      // 4. Serialize final field values into a cell

      // Push default values for all fields onto the stack
      for (const field of this.storageFields) {
        const defaultVal = this.contract.fields.find(f => f.name === field.name)?.defaultValue;
        let value = 0n;
        if (defaultVal?.kind === "NumberLit") {
          value = defaultVal.value;
        } else if (defaultVal?.kind === "BoolLit") {
          value = defaultVal.value ? -1n : 0n;
        }
        insts.push({ op: "PUSHINT", value });
      }
      // Stack: [param_N-1, ..., param_0, field_0, field_1, ..., field_N-1]
      // (params are below, pushed by caller)

      const numParams = initDecl.params.length;

      // Set up context
      const locals: Map<string, number> = new Map();
      let stackDepth = this.storageFields.length + numParams;

      // Register init params in locals
      // Params are below fields on stack. param_0 is at position numParams-1 (from bottom=0),
      // param_i is at position numParams-1-i
      for (let i = 0; i < numParams; i++) {
        locals.set(initDecl.params[i].name, numParams - 1 - i);
      }

      const ctx: CodegenContext = {
        locals,
        storageFields: this.storageFields,
        stackDepth,
        baseOffset: numParams, // params sit below storage fields
      };

      // Execute init body
      for (const stmt of initDecl.body.stmts) {
        insts.push(...this.genStmt(stmt, ctx));
      }

      // Clean up any locals that were created during init body
      const extraLocals = ctx.stackDepth - this.storageFields.length - numParams;
      for (let i = 0; i < extraLocals; i++) {
        insts.push({ op: "POP", i: 0 });
      }

      // Now serialize fields into a cell
      // Stack: [param_N-1, ..., param_0, field_0, field_1, ..., field_N-1]
      insts.push({ op: "NEWC" });

      for (let i = 0; i < this.storageFields.length; i++) {
        const field = this.storageFields[i];
        // Field i is at stack position: storageFields.length - i (relative to current top with NEWC builder at s0)
        const stackIdx = this.storageFields.length - i;
        insts.push({ op: "PUSH", i: stackIdx });

        if (this.isVarLength(field.type)) {
          insts.push({ op: "STVARUINT16" });
        } else if (field.type.kind === "BoolType") {
          insts.push({ op: "STI", bits: 1 });
        } else if (field.type.kind === "IntType" && field.type.signed) {
          insts.push({ op: "XCHG", i: 1 });
          insts.push({ op: "STI", bits: field.bits });
        } else {
          insts.push({ op: "XCHG", i: 1 });
          insts.push({ op: "STU", bits: field.bits });
        }
      }

      insts.push({ op: "ENDC" });

      // Drop the field values and params from stack
      for (let i = 0; i < this.storageFields.length + numParams; i++) {
        insts.push({ op: "POP", i: 0 });
      }
    } else {
      // No init body — just use default values (original behavior)
      insts.push({ op: "NEWC" });

      for (const field of this.storageFields) {
        const defaultVal = this.contract.fields.find(f => f.name === field.name)?.defaultValue;
        let value = 0n;
        if (defaultVal?.kind === "NumberLit") {
          value = defaultVal.value;
        } else if (defaultVal?.kind === "BoolLit") {
          value = defaultVal.value ? -1n : 0n;
        }

        insts.push({ op: "PUSHINT", value });
        if (this.isVarLength(field.type)) {
          insts.push({ op: "STVARUINT16" });
        } else if (field.type.kind === "BoolType") {
          insts.push({ op: "STI", bits: 1 });
        } else if (field.type.kind === "IntType" && field.type.signed) {
          insts.push({ op: "XCHG", i: 1 });
          insts.push({ op: "STI", bits: field.bits });
        } else {
          insts.push({ op: "XCHG", i: 1 });
          insts.push({ op: "STU", bits: field.bits });
        }
      }

      insts.push({ op: "ENDC" });
    }

    return insts;
  }

  // ── Full code assembly with method dispatch ──────────────

  private genFullCode(
    recvInternal: TVMInst[],
    getters: { name: string; id: number; code: TVMInst[] }[]
  ): TVMInst[] {
    const insts: TVMInst[] = [];

    // Code structure for TON contracts:
    // 1. SETCP 0
    // 2. Function selector: dispatch based on function_id
    //    - function_id == 0 → recv_internal
    //    - function_id == method_id → getter
    //    - else → THROW 11

    insts.push({ op: "COMMENT", text: "=== TonScript Compiled Contract ===" });

    // SETCP 0 — mandatory for TVM
    insts.push({ op: "SETCP", cp: 0 });

    // Function selector: function_id is on top of stack
    insts.push({ op: "COMMENT", text: "--- Function Selector ---" });

    // Check recv_internal (function_id == 0)
    insts.push({ op: "PUSH", i: 0 }); // DUP function_id
    insts.push({ op: "EQINT", value: 0 });
    const recvBody: TVMInst[] = [];
    recvBody.push({ op: "POP", i: 0 }); // DROP function_id
    recvBody.push({ op: "COMMENT", text: "--- recv_internal ---" });
    recvBody.push(...recvInternal);
    insts.push({ op: "PUSHCONT", body: recvBody });
    insts.push({ op: "IFJMP" });

    // Getter dispatch
    for (const getter of getters) {
      insts.push({ op: "PUSH", i: 0 }); // DUP function_id
      insts.push({ op: "PUSHINT", value: BigInt(getter.id) });
      insts.push({ op: "EQUAL" });
      const getterBody: TVMInst[] = [];
      getterBody.push({ op: "POP", i: 0 }); // DROP function_id
      getterBody.push({ op: "COMMENT", text: `--- getter: ${getter.name} (id=${getter.id}) ---` });
      getterBody.push(...getter.code);
      insts.push({ op: "PUSHCONT", body: getterBody });
      insts.push({ op: "IFJMP" });
    }

    // Unknown method
    insts.push({ op: "THROW", n: 11 });

    return insts;
  }
}

type CodegenContext = {
  locals: Map<string, number>; // variable name → stack position when defined
  storageFields: StorageField[];
  stackDepth: number;
  baseOffset: number; // number of items below storage fields (e.g., op + remaining_body)
  isReceiver?: boolean; // true for receiver handlers, false/undefined for getters
};

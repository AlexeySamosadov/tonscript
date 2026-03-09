// ============================================================
// TonScript BOC Builder
// Converts compiled TVM instructions into a deployable .boc file
// Uses @ton/core for proper Cell/Builder encoding
// ============================================================

import { beginCell, Cell, contractAddress, Address } from "@ton/core";
import type { CompileResult } from "./compiler.js";
import { TVMAssembler, TVMInst } from "./tvm.js";

// Helper: write a byte (8 bits) to a Builder
function storeByte(builder: ReturnType<typeof beginCell>, byte: number) {
  for (let i = 7; i >= 0; i--) {
    builder.storeBit((byte >> i) & 1);
  }
}

// Helper: write an array of bits to a Builder
function storeBits(builder: ReturnType<typeof beginCell>, bits: number[]) {
  for (const bit of bits) {
    builder.storeBit(bit);
  }
}

// Helper: convert raw bytes (Uint8Array) into a Cell
function bytesToCell(data: Uint8Array, bitLen?: number): Cell {
  const builder = beginCell();
  const totalBits = bitLen ?? data.length * 8;
  for (let i = 0; i < totalBits; i++) {
    const byteIdx = Math.floor(i / 8);
    const bitIdx = 7 - (i % 8);
    builder.storeBit((data[byteIdx] >> bitIdx) & 1);
  }
  return builder.endCell();
}

// Recursively encode TVM instructions into a Cell.
// Handles PUSHCONT/PUSHREF by building child cells as refs.
function instsToCell(insts: TVMInst[]): Cell {
  const builder = beginCell();
  const childCells: Cell[] = [];

  for (const inst of insts) {
    if (inst.op === "COMMENT") continue;

    if (inst.op === "PUSHCONT" && inst.body.length > 0) {
      // Encode the body to determine its bit length
      const subAsm = new TVMAssembler();
      const subResult = subAsm.encodeInstructions(inst.body);
      const subBitLen = subResult.bits.length;

      if (subBitLen <= 56 && subResult.refs.length === 0) {
        // Short form: 9_xxxx{bits} — inline in this cell
        // 4 bits: 0x9 prefix, 4 bits: byte length, then padded body bits
        const byteLen = Math.ceil(subBitLen / 8);

        // 0x9 nibble
        builder.storeBit(1); builder.storeBit(0);
        builder.storeBit(0); builder.storeBit(1);

        // byteLen nibble (4 bits)
        for (let i = 3; i >= 0; i--) {
          builder.storeBit((byteLen >> i) & 1);
        }

        // Body bits, padded to byteLen * 8
        for (let i = 0; i < byteLen * 8; i++) {
          builder.storeBit(i < subResult.bits.length ? subResult.bits[i] : 0);
        }
      } else {
        // Long form: PUSHREFCONT 0x8A + child cell ref
        // Recursively build the child cell to handle nested PUSHCONTs
        const childCell = instsToCell(inst.body);
        storeByte(builder, 0x8A);
        childCells.push(childCell);
      }
    } else if (inst.op === "PUSHREF" && inst.body.length > 0) {
      // PUSHREF: 0x88 + child cell ref
      const childCell = instsToCell(inst.body);
      storeByte(builder, 0x88);
      childCells.push(childCell);
    } else {
      // Regular instruction -- encode its bits inline
      const singleAsm = new TVMAssembler();
      const singleResult = singleAsm.encodeInstructions([inst]);
      storeBits(builder, singleResult.bits);

      // Handle any refs produced by the assembler (e.g., nested PUSHCONT in single-inst encode)
      // This shouldn't happen for non-PUSHCONT instructions, but handle for safety
      for (const refData of singleResult.refs) {
        childCells.push(bytesToCell(refData));
      }
    }
  }

  // Store all child cells as refs (max 4 per TVM cell)
  for (const child of childCells) {
    builder.storeRef(child);
  }

  return builder.endCell();
}

// Build the code cell with proper method dispatch
function buildCodeCell(
  recvInternal: TVMInst[],
  getters: { name: string; id: number; code: TVMInst[] }[]
): Cell {
  const fullInsts: TVMInst[] = [];

  // SETCP 0 -- mandatory start
  fullInsts.push({ op: "SETCP", cp: 0 });

  // recv_internal dispatch (function_id == 0)
  fullInsts.push({ op: "PUSH", i: 0 });  // DUP function_id
  fullInsts.push({ op: "EQINT", value: 0 });
  const recvBody: TVMInst[] = [];
  recvBody.push({ op: "POP", i: 0 }); // DROP function_id
  recvBody.push(...recvInternal);
  fullInsts.push({ op: "PUSHCONT", body: recvBody });
  fullInsts.push({ op: "IFJMP" });

  // Getter dispatch
  for (const getter of getters) {
    fullInsts.push({ op: "PUSH", i: 0 }); // DUP function_id
    fullInsts.push({ op: "PUSHINT", value: BigInt(getter.id) });
    fullInsts.push({ op: "EQUAL" });
    const getterBody: TVMInst[] = [];
    getterBody.push({ op: "POP", i: 0 }); // DROP function_id
    getterBody.push(...getter.code);
    fullInsts.push({ op: "PUSHCONT", body: getterBody });
    fullInsts.push({ op: "IFJMP" });
  }

  // Unknown method
  fullInsts.push({ op: "THROW", n: 11 });

  return instsToCell(fullInsts);
}

// Build the initial data cell from contract field defaults
function buildDataCell(fields: { name: string; type: any; defaultValue?: any }[]): Cell {
  const builder = beginCell();

  for (const field of fields) {
    let value = 0n;
    if (field.defaultValue?.kind === "NumberLit") {
      value = field.defaultValue.value;
    } else if (field.defaultValue?.kind === "BoolLit") {
      value = field.defaultValue.value ? -1n : 0n;
    }

    const type = field.type;
    if (type.kind === "CoinsType") {
      builder.storeCoins(value);
    } else if (type.kind === "BoolType") {
      builder.storeBit(value !== 0n);
    } else if (type.kind === "IntType" && type.signed) {
      builder.storeInt(value, type.bits);
    } else if (type.kind === "IntType") {
      builder.storeUint(value, type.bits);
    } else if (type.kind === "AddressType") {
      builder.storeUint(0, 2); // addr_none
    } else {
      builder.storeUint(value, 256); // fallback
    }
  }

  return builder.endCell();
}

export type BocResult = {
  code: Cell;
  data: Cell;
  stateInit: Cell;
  address: Address;
  boc: Buffer;
};

export function buildContractBoc(result: CompileResult): BocResult {
  // 1. Build code cell with method dispatch
  const code = buildCodeCell(
    result.instructions.recvInternal,
    result.instructions.getters
  );

  // 2. Build data cell from contract fields
  const contractDecl = result.ast.declarations.find(d => d.kind === "ContractDecl");
  if (!contractDecl || contractDecl.kind !== "ContractDecl") {
    throw new Error("No contract declaration found");
  }
  const data = buildDataCell(contractDecl.fields);

  // 3. Build StateInit cell (standard TON format)
  const stateInitCell = beginCell()
    .storeBit(0)  // no split_depth
    .storeBit(0)  // no special
    .storeBit(1)  // has code
    .storeRef(code)
    .storeBit(1)  // has data
    .storeRef(data)
    .storeBit(0)  // no library
    .endCell();

  // 4. Compute contract address (workchain 0)
  const address = contractAddress(0, { code, data });

  // 5. Serialize to BOC
  const boc = stateInitCell.toBoc();

  return { code, data, stateInit: stateInitCell, address, boc };
}

// ============================================================
// TVM Instruction Set & Binary Assembler
// Direct encoding — no Fift, no FunC
// ============================================================

// TVM instruction types
export type TVMInst =
  | { op: "NOP" }
  | { op: "XCHG"; i: number }                     // XCHG s0, s(i)
  | { op: "PUSH"; i: number }                     // PUSH s(i), DUP = PUSH 0
  | { op: "POP"; i: number }                      // POP s(i), DROP = POP 0
  | { op: "PUSHINT"; value: bigint }               // Push integer constant
  | { op: "PUSHCONT"; body: TVMInst[] }            // Push continuation
  | { op: "PUSHREF"; body: TVMInst[] }             // Push continuation from ref cell
  | { op: "ADD" }
  | { op: "SUB" }
  | { op: "MUL" }
  | { op: "DIV" }
  | { op: "MOD" }
  | { op: "NEGATE" }
  | { op: "INC" }
  | { op: "DEC" }
  | { op: "ADDCONST"; value: number }              // ADD small constant
  | { op: "MULCONST"; value: number }
  | { op: "AND" }
  | { op: "OR" }
  | { op: "XOR" }
  | { op: "NOT" }
  | { op: "LSHIFT"; n?: number }
  | { op: "RSHIFT"; n?: number }
  | { op: "EQUAL" }
  | { op: "LESS" }
  | { op: "GREATER" }
  | { op: "LEQ" }
  | { op: "NEQ" }
  | { op: "GEQ" }
  | { op: "CMP" }
  | { op: "EQINT"; value: number }
  | { op: "GTINT"; value: number }
  | { op: "LESSINT"; value: number }
  | { op: "NEQINT"; value: number }
  | { op: "ISNAN" }
  | { op: "ISNULL" }
  | { op: "NEWC" }
  | { op: "ENDC" }
  | { op: "STI"; bits: number }
  | { op: "STU"; bits: number }
  | { op: "STREF" }
  | { op: "STSLICE" }
  | { op: "STSLICER" }
  | { op: "STVARUINT16" }                          // Store Coins (VarUInteger 16)
  | { op: "CTOS" }
  | { op: "LDI"; bits: number }
  | { op: "LDU"; bits: number }
  | { op: "LDREF" }
  | { op: "LDSLICE"; bits: number }
  | { op: "LDVARUINT16" }                          // Load Coins
  | { op: "ENDS" }
  | { op: "BLESS" }
  | { op: "PUSHCTR"; reg: number }                 // Push control register (c0-c7)
  | { op: "POPCTR"; reg: number }                  // Pop control register
  | { op: "IF" }
  | { op: "IFNOT" }
  | { op: "IFELSE" }
  | { op: "IFJMP" }
  | { op: "IFNOTJMP" }
  | { op: "IFRET" }
  | { op: "IFNOTRET" }
  | { op: "WHILE" }                                // PUSHCONT cond, PUSHCONT body, WHILE
  | { op: "WHILEEND" }
  | { op: "REPEAT" }
  | { op: "REPEATEND" }
  | { op: "RET" }
  | { op: "RETALT" }
  | { op: "THROW"; n: number }
  | { op: "THROWIF"; n: number }
  | { op: "THROWIFNOT"; n: number }
  | { op: "SETCP"; cp: number }
  | { op: "DICTPUSHCONST"; n: number }             // Used for method dispatch
  | { op: "DICTIGETJMPZ" }
  | { op: "ACCEPT" }
  | { op: "NOW" }
  | { op: "MYADDR" }
  | { op: "BALANCE" }
  | { op: "GETGLOB"; k: number }
  | { op: "SETGLOB"; k: number }
  | { op: "SENDRAWMSG" }
  | { op: "HASHCU" }
  | { op: "HASHSU" }
  | { op: "CHKSIGNU" }
  | { op: "RAWRESERVE" }
  | { op: "SETCODE" }
  | { op: "BLKDROP"; n: number }
  | { op: "BLKPUSH"; count: number; startIdx: number }
  | { op: "ROLLREV"; n: number }
  | { op: "ROLL"; n: number }
  | { op: "SWAP2" }                                // XCHG s0,s2
  | { op: "COMMENT"; text: string };               // Not a real opcode, for asm output

// ── Pretty-printer: instructions → readable assembly ───────

export function tvmToAsm(insts: TVMInst[], indent = 0): string {
  const pad = "  ".repeat(indent);
  const lines: string[] = [];

  for (const inst of insts) {
    switch (inst.op) {
      case "COMMENT":
        lines.push(`${pad}; ${inst.text}`);
        break;
      case "PUSHINT":
        lines.push(`${pad}PUSHINT ${inst.value}`);
        break;
      case "PUSHCONT":
        lines.push(`${pad}PUSHCONT {`);
        lines.push(tvmToAsm(inst.body, indent + 1));
        lines.push(`${pad}}`);
        break;
      case "PUSHREF":
        lines.push(`${pad}PUSHREFCONT {`);
        lines.push(tvmToAsm(inst.body, indent + 1));
        lines.push(`${pad}}`);
        break;
      case "PUSH":
        if (inst.i === 0) lines.push(`${pad}DUP`);
        else if (inst.i === 1) lines.push(`${pad}OVER`);
        else lines.push(`${pad}PUSH s${inst.i}`);
        break;
      case "POP":
        if (inst.i === 0) lines.push(`${pad}DROP`);
        else if (inst.i === 1) lines.push(`${pad}NIP`);
        else lines.push(`${pad}POP s${inst.i}`);
        break;
      case "XCHG":
        if (inst.i === 1) lines.push(`${pad}SWAP`);
        else lines.push(`${pad}XCHG s${inst.i}`);
        break;
      case "PUSHCTR":
        lines.push(`${pad}PUSH c${inst.reg}`);
        break;
      case "POPCTR":
        lines.push(`${pad}POP c${inst.reg}`);
        break;
      case "STI":
        lines.push(`${pad}STI ${inst.bits}`);
        break;
      case "STU":
        lines.push(`${pad}STU ${inst.bits}`);
        break;
      case "LDI":
        lines.push(`${pad}LDI ${inst.bits}`);
        break;
      case "LDU":
        lines.push(`${pad}LDU ${inst.bits}`);
        break;
      case "LDSLICE":
        lines.push(`${pad}LDSLICE ${inst.bits}`);
        break;
      case "THROW":
        lines.push(`${pad}THROW ${inst.n}`);
        break;
      case "THROWIF":
        lines.push(`${pad}THROWIF ${inst.n}`);
        break;
      case "THROWIFNOT":
        lines.push(`${pad}THROWIFNOT ${inst.n}`);
        break;
      case "SETCP":
        lines.push(`${pad}SETCP ${inst.cp}`);
        break;
      case "DICTPUSHCONST":
        lines.push(`${pad}DICTPUSHCONST ${inst.n}`);
        break;
      case "ADDCONST":
        lines.push(`${pad}ADDCONST ${inst.value}`);
        break;
      case "MULCONST":
        lines.push(`${pad}MULCONST ${inst.value}`);
        break;
      case "EQINT":
        lines.push(`${pad}EQINT ${inst.value}`);
        break;
      case "GTINT":
        lines.push(`${pad}GTINT ${inst.value}`);
        break;
      case "LESSINT":
        lines.push(`${pad}LESSINT ${inst.value}`);
        break;
      case "NEQINT":
        lines.push(`${pad}NEQINT ${inst.value}`);
        break;
      case "LSHIFT":
        if (inst.n !== undefined) lines.push(`${pad}LSHIFT ${inst.n}`);
        else lines.push(`${pad}LSHIFT`);
        break;
      case "RSHIFT":
        if (inst.n !== undefined) lines.push(`${pad}RSHIFT ${inst.n}`);
        else lines.push(`${pad}RSHIFT`);
        break;
      case "GETGLOB":
        lines.push(`${pad}GETGLOB ${inst.k}`);
        break;
      case "SETGLOB":
        lines.push(`${pad}SETGLOB ${inst.k}`);
        break;
      case "BLKDROP":
        lines.push(`${pad}BLKDROP ${inst.n}`);
        break;
      case "BLKPUSH":
        lines.push(`${pad}BLKPUSH ${inst.count},${inst.startIdx}`);
        break;
      case "ROLL":
        lines.push(`${pad}ROLL ${inst.n}`);
        break;
      case "ROLLREV":
        lines.push(`${pad}ROLLREV ${inst.n}`);
        break;
      default:
        lines.push(`${pad}${inst.op}`);
    }
  }

  return lines.join("\n");
}

// ── Binary encoder: instructions → Buffer ──────────────────
// Encoding follows TVM spec (Appendix A, tvm.pdf)
// Each opcode is encoded as a specific bit pattern.

export class TVMAssembler {
  private bits: number[] = []; // array of 0/1
  private refs: Uint8Array[] = []; // child cells

  private writeBits(value: number, count: number) {
    for (let i = count - 1; i >= 0; i--) {
      this.bits.push((value >> i) & 1);
    }
  }

  private writeBigBits(value: bigint, count: number) {
    for (let i = count - 1; i >= 0; i--) {
      this.bits.push(Number((value >> BigInt(i)) & 1n));
    }
  }

  encodeInstructions(insts: TVMInst[]): { bits: number[]; refs: Uint8Array[] } {
    for (const inst of insts) {
      this.encodeOne(inst);
    }
    return { bits: [...this.bits], refs: [...this.refs] };
  }

  private encodeOne(inst: TVMInst) {
    switch (inst.op) {
      case "COMMENT": break; // skip

      // Stack manipulation
      case "NOP":     this.writeBits(0x00, 8); break;
      case "XCHG":
        if (inst.i >= 1 && inst.i <= 15) {
          this.writeBits(inst.i, 8); // 0x01..0x0F
        }
        break;
      case "PUSH":
        if (inst.i >= 0 && inst.i <= 15) {
          this.writeBits(0x20 + inst.i, 8); // 0x20..0x2F
        } else {
          this.writeBits(0x56, 8); // long form
          this.writeBits(inst.i, 8);
        }
        break;
      case "POP":
        if (inst.i >= 0 && inst.i <= 15) {
          this.writeBits(0x30 + inst.i, 8); // 0x30..0x3F
        } else {
          this.writeBits(0x57, 8);
          this.writeBits(inst.i, 8);
        }
        break;
      case "BLKDROP":
        // 5F0n where n = count (1..15)
        this.writeBits(0x5F, 8);
        this.writeBits(0, 4);
        this.writeBits(inst.n & 0x0F, 4);
        break;

      // Constants
      case "PUSHINT":
        this.encodePushInt(inst.value);
        break;
      case "PUSHCONT": {
        // Encode continuation body into a sub-assembler
        const sub = new TVMAssembler();
        const { bits: subBits } = sub.encodeInstructions(inst.body);
        if (subBits.length <= 7 * 8) {
          // Short form: 9Xrrr..r where X = (len_bits / 8) * 8, short continuation
          // Actually: 9_xxx{x} where the 4 bits after 9 = byte length, then the data
          const byteLen = Math.ceil(subBits.length / 8);
          this.writeBits(0x9, 4);
          this.writeBits(byteLen, 4);
          // Pad subBits to byteLen * 8
          const padded = [...subBits];
          while (padded.length < byteLen * 8) padded.push(0);
          for (const b of padded) this.bits.push(b);
        } else {
          // Use PUSHREFCONT — store continuation in ref
          this.writeBits(0x8A, 8); // PUSHREFCONT
          const cellData = bitsToBytes(subBits);
          this.refs.push(cellData);
        }
        break;
      }
      case "PUSHREF": {
        this.writeBits(0x88, 8); // PUSHREF
        const sub = new TVMAssembler();
        const { bits: subBits } = sub.encodeInstructions(inst.body);
        this.refs.push(bitsToBytes(subBits));
        break;
      }

      // Arithmetic
      case "ADD":     this.writeBits(0xA0, 8); break;
      case "SUB":     this.writeBits(0xA1, 8); break;
      case "MUL":     this.writeBits(0xA8, 8); break;
      case "DIV":     this.writeBits(0xA904, 16); break;
      case "MOD":     this.writeBits(0xA908, 16); break;
      case "NEGATE":  this.writeBits(0xA3, 8); break;
      case "INC":     this.writeBits(0xA4, 8); break;
      case "DEC":     this.writeBits(0xA5, 8); break;
      case "ADDCONST":
        this.writeBits(0xA6, 8);
        this.writeBits(inst.value & 0xFF, 8);
        break;
      case "MULCONST":
        this.writeBits(0xA7, 8);
        this.writeBits(inst.value & 0xFF, 8);
        break;
      case "AND":     this.writeBits(0xB0, 8); break;
      case "OR":      this.writeBits(0xB1, 8); break;
      case "XOR":     this.writeBits(0xB2, 8); break; // May need verification
      case "NOT":     this.writeBits(0xB3, 8); break;
      case "LSHIFT":
        if (inst.n !== undefined) {
          this.writeBits(0xAA, 8);
          this.writeBits(inst.n & 0xFF, 8);
        } else {
          this.writeBits(0xAC, 8); // variable LSHIFT (from stack)
        }
        break;
      case "RSHIFT":
        if (inst.n !== undefined) {
          this.writeBits(0xAB, 8);
          this.writeBits(inst.n & 0xFF, 8);
        } else {
          this.writeBits(0xAD, 8); // variable RSHIFT (from stack)
        }
        break;

      // Comparison (TVM spec: B9=LESS, BA=EQUAL, BB=LEQ, BC=GREATER, BD=NEQ, BE=GEQ, BF=CMP)
      case "LESS":    this.writeBits(0xB9, 8); break;
      case "EQUAL":   this.writeBits(0xBA, 8); break;
      case "LEQ":     this.writeBits(0xBB, 8); break;
      case "GREATER": this.writeBits(0xBC, 8); break;
      case "NEQ":     this.writeBits(0xBD, 8); break;
      case "GEQ":     this.writeBits(0xBE, 8); break;
      case "CMP":     this.writeBits(0xBF, 8); break;
      case "EQINT":
        this.writeBits(0xC0, 8);
        this.writeBits(inst.value & 0xFF, 8);
        break;

      // Cell operations
      case "NEWC":    this.writeBits(0xC8, 8); break;
      case "ENDC":    this.writeBits(0xC9, 8); break;
      case "STI":
        this.writeBits(0xCA, 8);
        this.writeBits(inst.bits - 1, 8);
        break;
      case "STU":
        this.writeBits(0xCB, 8);
        this.writeBits(inst.bits - 1, 8);
        break;
      case "STREF":   this.writeBits(0xCC, 8); break;
      case "STSLICE": this.writeBits(0xCF08, 16); break; // STSLICER
      case "STSLICER": this.writeBits(0xCF08, 16); break;

      // Slice operations
      case "CTOS":    this.writeBits(0xD0, 8); break;
      case "LDU":
        this.writeBits(0xD3, 8);
        this.writeBits(inst.bits - 1, 8); // cc = bits - 1
        // TODO: verify. The encoding might be D3xx where xx = cc
        break;
      case "LDI":
        this.writeBits(0xD2, 8);
        this.writeBits(inst.bits - 1, 8);
        break;
      case "LDREF":   this.writeBits(0xD4, 8); break;
      case "ENDS":    this.writeBits(0xD1, 8); break;
      case "LDVARUINT16": this.writeBits(0xFA00, 16); break;
      case "STVARUINT16": this.writeBits(0xFA02, 16); break;

      // Control flow
      case "IF":      this.writeBits(0xDE, 8); break;
      case "IFNOT":   this.writeBits(0xDF, 8); break;
      case "IFELSE":  this.writeBits(0xE2, 8); break;
      case "IFJMP":   this.writeBits(0xE0, 8); break;
      case "IFNOTJMP": this.writeBits(0xE1, 8); break;
      case "IFRET":   this.writeBits(0xDC, 8); break;
      case "IFNOTRET": this.writeBits(0xDD, 8); break;
      case "RET":     this.writeBits(0xDB, 8); this.writeBits(0x30, 8); break;

      // Exceptions
      case "THROW":
        if (inst.n >= 0 && inst.n <= 63) {
          this.writeBits(0xF2, 8);
          this.writeBits(0x00 | (inst.n & 0x3F), 8); // F2 00..3F
        } else {
          // Long form: 13-bit prefix (0xf2c0 >> 3) + 11-bit exception = 24 bits
          this.writeBits(0xF2C0 >> 3, 13);
          this.writeBits(inst.n & 0x7FF, 11);
        }
        break;
      case "THROWIF":
        if (inst.n >= 0 && inst.n <= 63) {
          this.writeBits(0xF2, 8);
          this.writeBits(0x40 | (inst.n & 0x3F), 8);
        } else {
          // Long form: 13-bit prefix (0xf2d0 >> 3) + 11-bit exception = 24 bits
          this.writeBits(0xF2D0 >> 3, 13);
          this.writeBits(inst.n & 0x7FF, 11);
        }
        break;
      case "THROWIFNOT":
        if (inst.n >= 0 && inst.n <= 63) {
          this.writeBits(0xF2, 8);
          this.writeBits(0x80 | (inst.n & 0x3F), 8);
        } else {
          // Long form: 13-bit prefix (0xf2e0 >> 3) + 11-bit exception = 24 bits
          this.writeBits(0xF2E0 >> 3, 13);
          this.writeBits(inst.n & 0x7FF, 11);
        }
        break;

      // Continuation / register ops
      case "BLESS":   this.writeBits(0xED00, 16); break;
      case "PUSHCTR":
        this.writeBits(0xED, 8);
        this.writeBits(0x40 | (inst.reg & 0x0F), 8);
        break;
      case "POPCTR":
        this.writeBits(0xED, 8);
        this.writeBits(0x50 | (inst.reg & 0x0F), 8);
        break;

      // Config/special
      case "SETCP":
        if (inst.cp === 0) {
          this.writeBits(0xFF, 8);
          this.writeBits(0x00, 8);
        }
        break;
      case "ACCEPT":    this.writeBits(0xF800, 16); break;
      case "NOW":       this.writeBits(0xF823, 16); break;
      case "MYADDR":    this.writeBits(0xF840, 16); break;
      case "BALANCE":   this.writeBits(0xF827, 16); break;
      case "SENDRAWMSG": this.writeBits(0xFB00, 16); break;
      case "RAWRESERVE": this.writeBits(0xFB02, 16); break;
      case "HASHCU":    this.writeBits(0xF900, 16); break;
      case "HASHSU":    this.writeBits(0xF901, 16); break;
      case "CHKSIGNU":  this.writeBits(0xF910, 16); break;
      case "SETCODE":   this.writeBits(0xFB04, 16); break;

      // Global variables
      case "GETGLOB":
        if (inst.k >= 1 && inst.k <= 31) {
          this.writeBits(0xF8, 8);
          this.writeBits(0x40 | inst.k, 8);
        }
        break;
      case "SETGLOB":
        if (inst.k >= 1 && inst.k <= 31) {
          this.writeBits(0xF8, 8);
          this.writeBits(0x60 | inst.k, 8);
        }
        break;

      // Dict operations
      case "DICTPUSHCONST":
        // F4A0..F4A4xx — various dict push opcodes
        // For method dispatch we need: DICTPUSHCONST n
        // This is typically done via PUSHINT n + DICTIGETJMPZ
        this.writeBits(0xF4, 8);
        this.writeBits(0xA4, 8);
        break;
      case "DICTIGETJMPZ":
        this.writeBits(0xF4, 8);
        this.writeBits(0xA1, 8); // TODO: verify exact opcode
        break;

      // Loops
      case "WHILE":     this.writeBits(0xE8, 8); break;
      case "WHILEEND":  this.writeBits(0xE9, 8); break;
      case "REPEAT":    this.writeBits(0xE4, 8); break;
      case "REPEATEND": this.writeBits(0xE5, 8); break;
    }
  }

  private encodePushInt(value: bigint) {
    // Small integers: -5..10 → single byte 0x70..0x7F
    if (value >= -5n && value <= 10n) {
      const n = Number(value);
      const encoded = n >= 0 ? n : n + 16;
      this.writeBits(0x70 + encoded, 8);
      return;
    }

    // 8-bit: -128..127 → 0x80 + byte
    if (value >= -128n && value <= 127n) {
      this.writeBits(0x80, 8);
      this.writeBits(Number(value) & 0xFF, 8);
      return;
    }

    // 16-bit: 0x81 + 2 bytes
    if (value >= -32768n && value <= 32767n) {
      this.writeBits(0x81, 8);
      const v = Number(value) & 0xFFFF;
      this.writeBits(v, 16);
      return;
    }

    // Long form: 0x82 + r(5 bits) + data(8*r+19 bits), signed big-endian
    // Find minimum r such that 8*r+19 bits can represent the value as signed
    let bitsNeeded: number;
    if (value >= 0n) {
      bitsNeeded = value === 0n ? 1 : value.toString(2).length + 1; // +1 for sign bit
    } else {
      bitsNeeded = (-value - 1n).toString(2).length + 1; // +1 for sign bit
    }
    const r = Math.max(0, Math.ceil((bitsNeeded - 19) / 8));
    const dataBits = 8 * r + 19;
    this.writeBits(0x82, 8);
    this.writeBits(r, 5);
    // Write value as signed big-endian in dataBits bits
    const encoded = value >= 0n ? value : (1n << BigInt(dataBits)) + value;
    this.writeBigBits(encoded, dataBits);
  }
}

function bitsToBytes(bits: number[]): Uint8Array {
  const byteLen = Math.ceil(bits.length / 8);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) {
      bytes[Math.floor(i / 8)] |= (0x80 >> (i % 8));
    }
  }
  return bytes;
}

// ── Method ID calculation (CRC16 like FunC) ────────────────

export function methodId(name: string): number {
  // FunC/Tact use (crc16(name) & 0xFFFF) | 0x10000 for getters
  // For recv_internal: 0
  // For recv_external: -1
  let crc = 0;
  for (let i = 0; i < name.length; i++) {
    crc ^= name.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return (crc & 0xFFFF) | 0x10000;
}

// ── Opcode generation for messages ─────────────────────────

export function messageOpcode(name: string): number {
  // Simple hash for message opcodes, similar to Tact
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = ((hash << 5) - hash + name.charCodeAt(i)) & 0xFFFFFFFF;
  }
  return hash >>> 0;
}

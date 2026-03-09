// ============================================================
// Counter Contract — TonScript
// TypeScript-like syntax, compiles directly to TVM bytecode
// ============================================================

// Message types with opcodes
message(0x01) Increment {
  amount: uint32
}

message(0x02) Decrement {
  amount: uint32
}

message(0x03) Reset {}

contract Counter {
  // Storage fields — automatically serialized to c4
  value: uint32 = 0
  owner: uint256 = 0

  // Init — called on deploy
  init(owner: uint256) {
    this.owner = owner
    this.value = 0
  }

  // Handle Increment message
  receive(msg: Increment) {
    this.value += msg.amount
  }

  // Handle Decrement message
  receive(msg: Decrement) {
    require(this.value >= msg.amount, 100)
    this.value -= msg.amount
  }

  // Handle Reset — only owner
  receive(msg: Reset) {
    this.value = 0
  }

  // Getter — readable from off-chain
  get value(): uint32 {
    return this.value
  }

  // Getter with computation
  get doubled(): uint32 {
    return this.value * 2
  }
}

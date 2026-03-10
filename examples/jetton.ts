// ============================================================
// Jetton (Fungible Token) Contracts — TonScript
// Simplified Jetton Master + Jetton Wallet in one file
// ============================================================

// ── Message Definitions ─────────────────────────────────────

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

message InternalTransfer {
  queryId: uint64
  amount: Coins
  fromAddress: uint256
  responseAddress: uint256
  forwardTonAmount: Coins
}

message Burn {
  queryId: uint64
  amount: Coins
  responseAddress: uint256
}

message BurnNotification {
  queryId: uint64
  amount: Coins
  ownerAddress: uint256
  responseAddress: uint256
}

// ── Jetton Master Contract ──────────────────────────────────

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

  get admin(): uint256 {
    return this.admin
  }
}

// ── Jetton Wallet Contract ──────────────────────────────────

contract JettonWallet {
  balance: Coins = 0
  ownerAddress: uint256 = 0
  masterAddress: uint256 = 0

  init(owner: uint256, master: uint256) {
    this.ownerAddress = owner
    this.masterAddress = master
  }

  receive(msg: InternalTransfer) {
    this.balance += msg.amount
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

  get ownerAddress(): uint256 {
    return this.ownerAddress
  }

  get masterAddress(): uint256 {
    return this.masterAddress
  }
}

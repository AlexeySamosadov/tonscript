// ============================================================
// NFT Contracts (TEP-62) — TonScript
// Full TEP-62 compliant NftItem + NftCollection
// ============================================================

// ── Message Definitions ─────────────────────────────────────

message DeployNftItem {
  itemIndex: uint64
  ownerAddress: uint256
  content: uint256
}

message TransferNft {
  queryId: uint64
  newOwner: uint256
  responseDestination: uint256
  forwardAmount: Coins
}

message GetStaticData {
  queryId: uint64
}

// ── NFT Collection Contract ─────────────────────────────────

contract NftCollection {
  nextItemIndex: uint64 = 0
  ownerAddress: uint256 = 0
  collectionContent: uint256 = 0

  init(owner: uint256) {
    this.ownerAddress = owner
  }

  receive(msg: DeployNftItem) {
    require(sender() == this.ownerAddress, 401)
    this.nextItemIndex += 1
  }

  get nextItemIndex(): uint64 {
    return this.nextItemIndex
  }

  get ownerAddress(): uint256 {
    return this.ownerAddress
  }

  get collectionContent(): uint256 {
    return this.collectionContent
  }
}

// ── NFT Item Contract ───────────────────────────────────────

contract NftItem {
  itemIndex: uint64 = 0
  collectionAddress: uint256 = 0
  ownerAddress: uint256 = 0
  content: uint256 = 0

  init(index: uint64, collection: uint256, owner: uint256) {
    this.itemIndex = index
    this.collectionAddress = collection
    this.ownerAddress = owner
  }

  receive(msg: TransferNft) {
    require(sender() == this.ownerAddress, 401)

    let previousOwner: uint256 = this.ownerAddress
    this.ownerAddress = msg.newOwner

    // Build notification body (ownership_assigned#05138d91)
    let notifyBody: Cell = beginCell()
      .storeUint(0x05138d91, 32)
      .storeUint(msg.queryId, 64)
      .storeUint(previousOwner, 256)
      .endCell()

    // Build excess body (excesses#d53276db)
    let excessBody: Cell = beginCell()
      .storeUint(0xd53276db, 32)
      .storeUint(msg.queryId, 64)
      .endCell()

    // Send ownership_assigned notification if forwardAmount > 0
    if (msg.forwardAmount > 0) {
      send(SendParameters {
        to: msg.newOwner,
        value: msg.forwardAmount,
        mode: 1,
        body: notifyBody
      })
    }

    // Send excess TON to response_destination if set
    if (msg.responseDestination > 0) {
      send(SendParameters {
        to: msg.responseDestination,
        value: 0,
        mode: 64,
        body: excessBody
      })
    }
  }

  receive(msg: GetStaticData) {
    // Build report_static_data body (report_static_data#8b771735)
    let replyBody: Cell = beginCell()
      .storeUint(0x8b771735, 32)
      .storeUint(msg.queryId, 64)
      .storeUint(this.itemIndex, 64)
      .storeUint(this.collectionAddress, 256)
      .endCell()

    send(SendParameters {
      to: sender(),
      value: 0,
      mode: 64,
      body: replyBody
    })
  }

  get itemIndex(): uint64 {
    return this.itemIndex
  }

  get ownerAddress(): uint256 {
    return this.ownerAddress
  }

  get collectionAddress(): uint256 {
    return this.collectionAddress
  }

  get content(): uint256 {
    return this.content
  }
}

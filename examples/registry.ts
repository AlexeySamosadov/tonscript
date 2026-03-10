// Simple Key-Value Registry Contract
// Demonstrates Map<K, V> type

message SetValue {
  key: uint256
  value: uint256
}

message DeleteValue {
  key: uint256
}

contract Registry {
  entries: Map<uint256, uint256>
  owner: uint256 = 0
  count: uint64 = 0

  init(owner: uint256) {
    this.owner = owner
  }

  receive(msg: SetValue) {
    this.entries.set(msg.key, msg.value)
    this.count += 1
  }

  receive(msg: DeleteValue) {
    this.entries.delete(msg.key)
    if (this.count > 0) {
      this.count -= 1
    }
  }

  get count(): uint64 {
    return this.count
  }

  get owner(): uint256 {
    return this.owner
  }
}

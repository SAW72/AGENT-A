// SPDX-License-Identifier: MIT
// Insurance fund backstop for Agent A (Agent Auditor) liability.
// Funded by vault fees. Pays out when owner/auditor cannot.
// Not audited. For illustration.
pragma solidity ^0.8.20;

contract InsuranceFund {
    address public owner;
    /// @notice Immutable ACL: only this Liability may call `payout`.
    address public immutable liability;
    uint256 public balance;

    event Funded(address indexed from, uint256 amount);
    event PaidOut(address indexed to, uint256 amount, bytes32 indexed claimId);
    event OwnerUpdated(address indexed previous, address indexed next);

    constructor(address _liability) {
        require(_liability != address(0), "zero liability");
        owner = msg.sender;
        liability = _liability;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyLiability() {
        require(msg.sender == liability, "not liability");
        _;
    }

    function fund() external payable {
        require(msg.value > 0, "zero");
        balance += msg.value;
        emit Funded(msg.sender, msg.value);
    }

    /// @notice Called only by the bound Liability contract to pay a claim.
    function payout(address payable recipient, uint256 amount, bytes32 claimId) external onlyLiability {
        require(amount <= balance, "insufficient fund");
        balance -= amount;
        (bool ok,) = recipient.call{value: amount}("");
        require(ok, "payout failed");
        emit PaidOut(recipient, amount, claimId);
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner zero");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }
}

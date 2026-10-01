// SPDX-License-Identifier: MIT
// Liability waterfall for Agent A (Agent Auditor).
// Owner -> Auditor -> InsuranceFund. Not audited. For illustration.
pragma solidity ^0.8.20;

interface IInsuranceFund {
    function payout(address payable recipient, uint256 amount, bytes32 claimId) external;
    function balance() external view returns (uint256);
}

contract Liability {
    address public owner;
    IInsuranceFund public insurance;

    enum Party {
        None,
        Owner,
        Auditor,
        Insurance
    }

    struct Claim {
        bytes32 botId;
        bytes32 incidentHash;
        address payable claimant;
        uint256 amount;
        Party liable;
        bool paid;
        uint256 createdAt;
    }

    mapping(bytes32 => Claim) public claims; // claimId => Claim
    mapping(bytes32 => bool) public incidentKnown; // prevent double claims

    event ClaimFiled(bytes32 indexed claimId, bytes32 indexed botId, Party liable, uint256 amount);
    event ClaimPaid(bytes32 indexed claimId, Party liable, uint256 amount);
    event InsuranceBound(address indexed insurance);
    event OwnerUpdated(address indexed previous, address indexed next);

    /// @param _insurance InsuranceFund address, or address(0) if binding after
    /// InsuranceFund is constructed with this Liability as its immutable caller.
    constructor(address _insurance) {
        owner = msg.sender;
        if (_insurance != address(0)) {
            insurance = IInsuranceFund(_insurance);
        }
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    /// @notice One-shot bind so InsuranceFund can take this contract as an
    /// immutable `liability` before the reverse pointer is set.
    function bindInsurance(address _insurance) external onlyOwner {
        require(address(insurance) == address(0), "insurance already bound");
        require(_insurance != address(0), "zero insurance");
        insurance = IInsuranceFund(_insurance);
        emit InsuranceBound(_insurance);
    }

    function setOwner(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner zero");
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    /// @notice File a claim. liableParty is determined off-chain from audit trail,
    /// but recorded here for on-chain settlement. A claimId cannot be overwritten.
    function fileClaim(
        bytes32 claimId,
        bytes32 botId,
        bytes32 incidentHash,
        address payable claimant,
        uint256 amount,
        Party liable
    ) external onlyOwner {
        // createdAt == 0 is the empty slot. Timestamp 0 would collide with that sentinel.
        require(block.timestamp != 0, "timestamp unset");
        require(claims[claimId].createdAt == 0, "claim exists");
        require(!incidentKnown[incidentHash], "incident already claimed");
        require(amount > 0, "zero amount");
        claims[claimId] = Claim({
            botId: botId,
            incidentHash: incidentHash,
            claimant: claimant,
            amount: amount,
            liable: liable,
            paid: false,
            createdAt: block.timestamp
        });
        incidentKnown[incidentHash] = true;
        emit ClaimFiled(claimId, botId, liable, amount);
    }

    /// @notice Settle a claim following the waterfall: Owner, then Auditor, then Insurance.
    /// Owner path pays from this contract's ETH balance.
    /// Auditor path reverts until a slash/escrow hook exists (no silent settle).
    /// Insurance path calls InsuranceFund.payout (onlyLiability).
    function settle(bytes32 claimId) external onlyOwner {
        Claim storage c = claims[claimId];
        require(!c.paid, "already paid");
        require(c.amount > 0, "no claim");

        if (c.liable == Party.Owner) {
            (bool ok,) = c.claimant.call{value: c.amount}("");
            require(ok, "owner payout failed");
        } else if (c.liable == Party.Auditor) {
            // Claim has no auditor identity; ETH amounts do not map to BVT stake.
            // Wiring IAuditorSlash would be a larger redesign. Fail closed.
            revert("Liability: auditor slash/escrow unset");
        } else if (c.liable == Party.Insurance) {
            require(address(insurance) != address(0), "insurance unset");
            insurance.payout(c.claimant, c.amount, claimId);
        } else {
            revert("unknown liable party");
        }

        c.paid = true;
        emit ClaimPaid(claimId, c.liable, c.amount);
    }

    receive() external payable {}
}

// SPDX-License-Identifier: MIT
// Tests for BotAttestationEscrow using Foundry (forge test).
pragma solidity ^0.8.20;

import { Test } from "forge-std/Test.sol";
import { BotAttestationEscrow } from "../contracts/BotAttestationEscrow.sol";
import { Denylist } from "../contracts/Denylist.sol";
import { Vault } from "../contracts/Vault.sol";
import { DisputePanel } from "../contracts/DisputePanel.sol";
import { DeployBotAttestationEscrow } from "../script/DeployBotAttestationEscrow.s.sol";

contract EtherSink {
    function pull(
        BotAttestationEscrow escrow
    ) external {
        escrow.withdraw();
    }

    receive() external payable { }
}

contract ReenteringPayee {
    BotAttestationEscrow public escrow;
    bytes32 public escrowId;
    bool public tried;

    constructor(
        BotAttestationEscrow _escrow
    ) {
        escrow = _escrow;
    }

    function setEscrowId(
        bytes32 id
    ) external {
        escrowId = id;
    }

    function pull() external {
        escrow.withdraw();
    }

    receive() external payable {
        if (!tried) {
            tried = true;
            // Reenter should fail: credit already zeroed / nonReentrant.
            try escrow.withdraw() { } catch { }
            try escrow.release(escrowId) { } catch { }
            try escrow.refund(escrowId) { } catch { }
        }
    }
}

contract BotAttestationEscrowTest is Test {
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event DenylistUpdated(
        address indexed previousDenylist, address indexed newDenylist, address indexed actor, uint256 timestamp
    );
    event VaultUpdated(
        address indexed previousVault, address indexed newVault, address indexed actor, uint256 timestamp
    );
    event DisputePanelUpdated(
        address indexed previousPanel, address indexed newPanel, address indexed actor, uint256 timestamp
    );

    Denylist denylist;
    Vault vault;
    DisputePanel panel;
    BotAttestationEscrow escrow;

    address governance;
    address payer;
    address payee;
    address arb1;
    address arb2;
    address arb3;

    bytes32 payerBot = keccak256("payer-bot");
    bytes32 payeeBot = keccak256("payee-bot");

    function setUp() public {
        denylist = new Denylist();
        vault = new Vault(address(denylist));
        panel = new DisputePanel();
        governance = makeAddr("governance");
        escrow = new BotAttestationEscrow(address(denylist), address(vault), address(panel), governance);
        escrow.transferOwnership(governance);
        vm.prank(governance);
        escrow.acceptOwnership();

        payer = makeAddr("payer");
        payee = makeAddr("payee");
        arb1 = makeAddr("arb1");
        arb2 = makeAddr("arb2");
        arb3 = makeAddr("arb3");
        panel.setArbitrator(arb1, true);
        panel.setArbitrator(arb2, true);
        panel.setArbitrator(arb3, true);

        vault.register(payerBot, keccak256("w1"), keccak256("b1"), keccak256("p1"), Vault.Tier.Financial, payer);
        vault.register(payeeBot, keccak256("w2"), keccak256("b2"), keccak256("p2"), Vault.Tier.Financial, payee);

        vm.deal(payer, 10 ether);
    }

    function _create(
        bytes32 escrowId,
        uint256 amount,
        uint256 duration
    ) internal {
        vm.prank(payer);
        escrow.createEscrow{ value: amount }(escrowId, payee, payerBot, payeeBot, duration);
    }

    /// @dev Release and refund credit `account`. Pull so balance assertions see the ETH.
    function _claim(
        address account
    ) internal {
        vm.prank(account);
        escrow.withdraw();
    }

    function _openPanel(
        bytes32 escrowId,
        bytes32 disputeId
    ) internal {
        // Challenger must be a party. The test contract is neither payer nor payee.
        vm.prank(payer);
        panel.openDispute(disputeId, escrowId, "attestation stale");
    }

    function _panelRule(
        bytes32 disputeId,
        bool uphold
    ) internal {
        // upheld == votesFor >= votesAgainst. support=true counts as votesFor.
        vm.prank(arb1);
        panel.vote(disputeId, uphold);
        vm.prank(arb2);
        panel.vote(disputeId, uphold);
        vm.prank(arb3);
        panel.vote(disputeId, false);
    }

    function _disputeAndUphold(
        bytes32 escrowId,
        bytes32 disputeId
    ) internal {
        _openPanel(escrowId, disputeId);
        vm.prank(payee);
        escrow.dispute(escrowId, disputeId);
        _panelRule(disputeId, true);
    }

    function test_createAndRelease() public {
        bytes32 escrowId = keccak256("deal-1");
        uint256 amount = 1 ether;

        _create(escrowId, amount, 3600);

        uint256 before = payee.balance;
        assertEq(escrow.lockedValue(), amount);
        vm.prank(payer);
        escrow.release(escrowId);
        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.pendingWithdrawals(payee), amount);
        assertEq(escrow.totalOwed(), amount);
        assertEq(payee.balance, before);
        _claim(payee);
        assertEq(payee.balance, before + amount);
        assertEq(escrow.totalOwed(), 0);
        (,,,,,,, BotAttestationEscrow.EscrowState state,) = _escrowTuple(escrowId);
        assertEq(uint256(state), uint256(BotAttestationEscrow.EscrowState.Released));
    }

    function test_refundOnExpiry() public {
        bytes32 escrowId = keccak256("deal-2");
        uint256 amount = 1 ether;

        _create(escrowId, amount, 100);

        vm.warp(block.timestamp + 101);

        uint256 before = payer.balance;
        assertEq(escrow.lockedValue(), amount);
        vm.prank(payer);
        escrow.refund(escrowId);
        assertEq(escrow.lockedValue(), 0);
        assertEq(escrow.pendingWithdrawals(payer), amount);
        assertEq(escrow.totalOwed(), amount);
        assertEq(payer.balance, before);
        _claim(payer);
        assertEq(payer.balance, before + amount);
        assertEq(escrow.totalOwed(), 0);
    }

    function test_blocksReleaseWhenDenylistedAfterCreate() public {
        bytes32 escrowId = keccak256("deal-3");
        _create(escrowId, 1 ether, 3600);

        // Denylist after lock — release must still fail closed.
        denylist.addExact(keccak256("w2"));

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot denylisted"));
        escrow.release(escrowId);
    }

    function test_createRejectsAlreadyDenylistedPayee() public {
        denylist.addExact(keccak256("w2"));

        bytes32 escrowId = keccak256("deal-3b");
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot denylisted"));
        escrow.createEscrow{ value: 1 ether }(escrowId, payee, payerBot, payeeBot, 3600);
        assertFalse(escrow.usedEscrowIds(escrowId));
    }

    function test_replayRejected() public {
        bytes32 escrowId = keccak256("deal-4");
        _create(escrowId, 1 ether, 3600);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.Replay.selector);
        escrow.createEscrow{ value: 1 ether }(escrowId, payee, payerBot, payeeBot, 3600);
    }

    function test_replayRejectedAfterRefund() public {
        bytes32 escrowId = keccak256("deal-4b");
        _create(escrowId, 1 ether, 100);
        vm.warp(block.timestamp + 101);
        vm.prank(payer);
        escrow.refund(escrowId);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.Replay.selector);
        escrow.createEscrow{ value: 1 ether }(escrowId, payee, payerBot, payeeBot, 3600);
    }

    function test_blocksReleaseWhenBurned() public {
        bytes32 escrowId = keccak256("deal-burn");
        _create(escrowId, 1 ether, 3600);

        vault.burn(payeeBot);

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot inactive"));
        escrow.release(escrowId);
    }

    function test_createRejectsChatTier() public {
        bytes32 chatBot = keccak256("chat-bot");
        vault.register(chatBot, keccak256("w3"), keccak256("b3"), keccak256("p3"), Vault.Tier.Chat, payee);

        bytes32 escrowId = keccak256("deal-tier");
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot below Financial tier"));
        escrow.createEscrow{ value: 1 ether }(escrowId, payee, payerBot, chatBot, 3600);
    }

    function test_releaseRevertsAfterExpiry() public {
        bytes32 escrowId = keccak256("deal-exp");
        _create(escrowId, 1 ether, 100);
        vm.warp(block.timestamp + 101);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.EscrowExpired.selector);
        escrow.release(escrowId);
    }

    function test_disputeDoesNotAllowInstantRefund() public {
        bytes32 escrowId = keccak256("deal-disp-pending");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 3600);

        bytes32 disputeId = keccak256("d-pending");
        _openPanel(escrowId, disputeId);
        vm.prank(payer);
        escrow.dispute(escrowId, disputeId);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        escrow.refund(escrowId);
        assertEq(address(escrow).balance, amount);
    }

    function test_refundAfterPanelUnwind() public {
        bytes32 escrowId = keccak256("deal-disp-unwind");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 3600);

        bytes32 disputeId = keccak256("d-unwind");
        _openPanel(escrowId, disputeId);
        vm.prank(payer);
        escrow.dispute(escrowId, disputeId);
        _panelRule(disputeId, false); // do not uphold — unwind

        uint256 before = payer.balance;
        vm.prank(payer);
        escrow.refund(escrowId);
        _claim(payer);
        assertEq(payer.balance, before + amount);
    }

    function test_refundAfterDisputeOnExpiryTimelock() public {
        bytes32 escrowId = keccak256("deal-disp-tl");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 100);

        bytes32 disputeId = keccak256("d-tl");
        _openPanel(escrowId, disputeId);
        vm.prank(payer);
        escrow.dispute(escrowId, disputeId);

        vm.warp(block.timestamp + 101);
        uint256 before = payer.balance;
        vm.prank(payer);
        escrow.refund(escrowId);
        _claim(payer);
        assertEq(payer.balance, before + amount);
    }

    /// @notice H-1: upheld + past expiresAt pays the payee. Expiry must not refund the payer.
    function test_upheldPastExpiryRefundRevertsReleaseSucceeds() public {
        bytes32 escrowId = keccak256("deal-uphold-expired");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 100);

        bytes32 disputeId = keccak256("d-uphold-expired");
        _openPanel(escrowId, disputeId);
        vm.prank(payee);
        escrow.dispute(escrowId, disputeId);
        _panelRule(disputeId, true);

        vm.warp(block.timestamp + 101);

        uint256 payerBefore = payer.balance;
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        escrow.refund(escrowId);
        assertEq(payer.balance, payerBefore);
        assertEq(address(escrow).balance, amount);

        uint256 payeeBefore = payee.balance;
        vm.prank(payee);
        escrow.release(escrowId);
        assertEq(payee.balance, payeeBefore);
        assertEq(escrow.pendingWithdrawals(payee), amount);
        assertEq(address(escrow).balance, amount);
        _claim(payee);
        assertEq(payee.balance, payeeBefore + amount);
        assertEq(address(escrow).balance, 0);
        (,,,,,,, BotAttestationEscrow.EscrowState state,) = _escrowTuple(escrowId);
        assertEq(uint256(state), uint256(BotAttestationEscrow.EscrowState.Released));
    }

    /// @notice Unwind after expiry still refunds. Panel gating for a non-upheld ruling stays.
    function test_unwindPastExpiryStillRefunds() public {
        bytes32 escrowId = keccak256("deal-unwind-expired");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 100);

        bytes32 disputeId = keccak256("d-unwind-expired");
        _openPanel(escrowId, disputeId);
        vm.prank(payer);
        escrow.dispute(escrowId, disputeId);
        _panelRule(disputeId, false);

        vm.warp(block.timestamp + 101);

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        escrow.release(escrowId);

        uint256 before = payer.balance;
        vm.prank(payer);
        escrow.refund(escrowId);
        _claim(payer);
        assertEq(payer.balance, before + amount);
        assertEq(address(escrow).balance, 0);
    }

    /// @notice H-1 (post-ruling): denylist after uphold must not lock ETH. Release credits e.payee.
    function test_upheldReleaseSucceedsWhenPayeeDenylisted() public {
        bytes32 escrowId = keccak256("deal-uphold-deny");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 3600);
        _disputeAndUphold(escrowId, keccak256("d-uphold-deny"));

        denylist.addExact(keccak256("w2"));

        // Refund stays closed. The only exit is release to the create-time payee.
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        escrow.refund(escrowId);

        uint256 before = payee.balance;
        vm.prank(payer);
        escrow.release(escrowId);
        _claim(payee);
        assertEq(payee.balance, before + amount);
        assertEq(address(escrow).balance, 0);
        (,,,,,,, BotAttestationEscrow.EscrowState state,) = _escrowTuple(escrowId);
        assertEq(uint256(state), uint256(BotAttestationEscrow.EscrowState.Released));
    }

    /// @notice H-1 (post-ruling): burning the payee bot after uphold must not lock ETH.
    function test_upheldReleaseSucceedsWhenPayeeBurned() public {
        bytes32 escrowId = keccak256("deal-uphold-burn");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 3600);
        _disputeAndUphold(escrowId, keccak256("d-uphold-burn"));

        vault.burn(payeeBot);

        uint256 before = payee.balance;
        vm.prank(payee);
        escrow.release(escrowId);
        _claim(payee);
        assertEq(payee.balance, before + amount);
        assertEq(address(escrow).balance, 0);
    }

    /// @notice H-1 (post-ruling): operator rotation after uphold credits the original e.payee.
    function test_upheldReleasePaysOriginalPayeeAfterOperatorRotate() public {
        bytes32 escrowId = keccak256("deal-uphold-rotate");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 3600);
        _disputeAndUphold(escrowId, keccak256("d-uphold-rotate"));

        address rotated = makeAddr("rotated-payee");
        vault.setOperator(payeeBot, rotated);

        uint256 payeeBefore = payee.balance;
        uint256 rotatedBefore = rotated.balance;
        vm.prank(payer);
        escrow.release(escrowId);
        _claim(payee);
        assertEq(payee.balance, payeeBefore + amount);
        assertEq(rotated.balance, rotatedBefore);
        assertEq(address(escrow).balance, 0);
    }

    /// @notice Same strand on the payer side: a post-uphold denylist must not block release.
    function test_upheldReleaseSucceedsWhenPayerDenylisted() public {
        bytes32 escrowId = keccak256("deal-uphold-payer-deny");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 3600);
        _disputeAndUphold(escrowId, keccak256("d-uphold-payer-deny"));

        denylist.addExact(keccak256("w1"));

        uint256 before = payee.balance;
        vm.prank(payee);
        escrow.release(escrowId);
        _claim(payee);
        assertEq(payee.balance, before + amount);
    }

    function test_panelUpholdBlocksRefundAllowsRelease() public {
        bytes32 escrowId = keccak256("deal-disp-uphold");
        uint256 amount = 1 ether;
        _create(escrowId, amount, 3600);

        bytes32 disputeId = keccak256("d-uphold");
        _openPanel(escrowId, disputeId);
        vm.prank(payee);
        escrow.dispute(escrowId, disputeId);
        _panelRule(disputeId, true); // original deal stands

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputePending.selector);
        escrow.refund(escrowId);

        uint256 before = payee.balance;
        vm.prank(payer);
        escrow.release(escrowId);
        _claim(payee);
        assertEq(payee.balance, before + amount);
    }

    function test_disputeRequiresPanelCaseForThisEscrow() public {
        bytes32 escrowId = keccak256("deal-bad-id");
        _create(escrowId, 1 ether, 3600);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidDispute.selector);
        escrow.dispute(escrowId, keccak256("never-opened"));

        bytes32 other = keccak256("other-escrow");
        bytes32 disputeId = keccak256("d-wrong-subject");
        panel.openDispute(disputeId, other, "wrong subject");
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidDispute.selector);
        escrow.dispute(escrowId, disputeId);
    }

    function test_unboundEoaCannotCreateUnderForeignBotId() public {
        address eve = makeAddr("eve");
        vm.deal(eve, 1 ether);
        vm.prank(eve);
        vm.expectRevert(BotAttestationEscrow.InvalidParties.selector);
        escrow.createEscrow{ value: 1 ether }(keccak256("steal"), payee, payerBot, payeeBot, 3600);
    }

    function test_unboundPayeeRejected() public {
        address evePayee = makeAddr("evePayee");
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidParties.selector);
        escrow.createEscrow{ value: 1 ether }(keccak256("bad-payee"), evePayee, payerBot, payeeBot, 3600);
    }

    function test_createRejectsUnboundBot() public {
        bytes32 unbound = keccak256("no-operator");
        vault.register(unbound, keccak256("w4"), keccak256("b4"), keccak256("p4"), Vault.Tier.Financial);
        assertEq(vault.operator(unbound), address(0));

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidParties.selector);
        escrow.createEscrow{ value: 1 ether }(keccak256("unbound"), payee, payerBot, unbound, 3600);
    }

    function test_releaseRevertsIfOperatorRotated() public {
        bytes32 escrowId = keccak256("deal-rotate");
        _create(escrowId, 1 ether, 3600);
        vault.setOperator(payeeBot, makeAddr("new-payee"));

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidParties.selector);
        escrow.release(escrowId);
    }

    function test_strangerCannotDispute() public {
        bytes32 escrowId = keccak256("deal-stranger");
        _create(escrowId, 1 ether, 3600);
        bytes32 disputeId = keccak256("x");
        _openPanel(escrowId, disputeId);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(bytes("not a party"));
        escrow.dispute(escrowId, disputeId);
    }

    function test_zeroValueRejected() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "zero amount"));
        escrow.createEscrow{ value: 0 }(keccak256("zero"), payee, payerBot, payeeBot, 3600);
    }

    function test_selfPayeeRejected() public {
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidParties.selector);
        escrow.createEscrow{ value: 1 ether }(keccak256("self"), payer, payerBot, payeeBot, 3600);
    }

    function test_zeroBotIdRejected() public {
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.InvalidParties.selector);
        escrow.createEscrow{ value: 1 ether }(keccak256("zbot"), payee, bytes32(0), payeeBot, 3600);
    }

    function test_signatureDenylistBlocksRelease() public {
        bytes32 escrowId = keccak256("deal-sig");
        _create(escrowId, 1 ether, 3600);
        denylist.addSignature(keccak256("b2"));

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot denylisted"));
        escrow.release(escrowId);
    }

    function test_promptDenylistBlocksRelease() public {
        bytes32 escrowId = keccak256("deal-prompt");
        _create(escrowId, 1 ether, 3600);
        denylist.addPrompt(keccak256("p2"));
        assertEq(
            uint256(denylist.check(keccak256("w2"), keccak256("b2"), keccak256("p2"))),
            uint256(Denylist.MatchLevel.PromptBlock)
        );

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot denylisted"));
        escrow.release(escrowId);
    }

    function test_promptUnbanRestoresRelease() public {
        bytes32 escrowId = keccak256("deal-prompt-unban");
        _create(escrowId, 1 ether, 3600);
        denylist.addPrompt(keccak256("p2"));

        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot denylisted"));
        escrow.release(escrowId);

        denylist.remove(keccak256("p2"), uint8(Denylist.Bucket.Prompt));
        assertEq(
            uint256(denylist.check(keccak256("w2"), keccak256("b2"), keccak256("p2"))),
            uint256(Denylist.MatchLevel.None)
        );
        assertTrue(denylist.everListed(uint8(Denylist.Bucket.Prompt), keccak256("p2")));

        vm.prank(payer);
        escrow.release(escrowId);
        _claim(payee);
        assertEq(payee.balance, 1 ether);
        assertEq(escrow.lockedValue(), 0);
    }

    function test_releaseToReceivingContract() public {
        EtherSink sink = new EtherSink();
        vault.setOperator(payeeBot, address(sink));
        bytes32 escrowId = keccak256("deal-sink");
        uint256 amount = 1 ether;

        vm.prank(payer);
        escrow.createEscrow{ value: amount }(escrowId, address(sink), payerBot, payeeBot, 3600);

        vm.prank(payer);
        escrow.release(escrowId);
        assertEq(escrow.pendingWithdrawals(address(sink)), amount);
        sink.pull(escrow);
        assertEq(address(sink).balance, amount);
    }

    function test_reenteringPayeeCannotDoublePay() public {
        ReenteringPayee evil = new ReenteringPayee(escrow);
        vault.setOperator(payeeBot, address(evil));
        bytes32 escrowId = keccak256("deal-reenter");
        uint256 amount = 1 ether;

        vm.prank(payer);
        escrow.createEscrow{ value: amount }(escrowId, address(evil), payerBot, payeeBot, 3600);
        evil.setEscrowId(escrowId);

        vm.prank(payer);
        escrow.release(escrowId);
        assertEq(address(evil).balance, 0);
        assertEq(escrow.pendingWithdrawals(address(evil)), amount);
        evil.pull();
        assertTrue(evil.tried());
        assertEq(address(evil).balance, amount);
        assertEq(address(escrow).balance, 0);
        assertEq(escrow.pendingWithdrawals(address(evil)), 0);
    }

    function test_doubleReleaseReverts() public {
        bytes32 escrowId = keccak256("deal-dbl");
        _create(escrowId, 1 ether, 3600);
        vm.prank(payer);
        escrow.release(escrowId);
        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.EscrowNotOpen.selector);
        escrow.release(escrowId);
    }

    function test_refundBeforeExpiryWithoutDisputeReverts() public {
        bytes32 escrowId = keccak256("deal-early");
        _create(escrowId, 1 ether, 3600);
        vm.prank(payer);
        vm.expectRevert(bytes("not expired"));
        escrow.refund(escrowId);
    }

    function test_constructorRejectsZeroPanel() public {
        vm.expectRevert(BotAttestationEscrow.ZeroAddress.selector);
        new BotAttestationEscrow(address(denylist), address(vault), address(0), makeAddr("gov-panel"));
    }

    function test_constructorRejectsZeroVault() public {
        vm.expectRevert(BotAttestationEscrow.ZeroAddress.selector);
        new BotAttestationEscrow(address(denylist), address(0), address(panel), makeAddr("gov-vault"));
    }

    function test_constructorRejectsDeployerAsGovernance() public {
        vm.expectRevert(BotAttestationEscrow.InvalidGovernance.selector);
        new BotAttestationEscrow(address(denylist), address(vault), address(panel), address(this));
    }

    function test_constructorRejectsZeroGovernance() public {
        vm.expectRevert(BotAttestationEscrow.ZeroAddress.selector);
        new BotAttestationEscrow(address(denylist), address(vault), address(panel), address(0));
    }

    function test_governanceCanRepointDepsWhenUnfunded() public {
        Denylist d2 = new Denylist();
        Vault v2 = new Vault(address(d2));
        DisputePanel p2 = new DisputePanel();
        vm.startPrank(governance);
        escrow.setDenylist(address(d2));
        escrow.setVault(address(v2));
        escrow.setDisputePanel(address(p2));
        vm.stopPrank();
        assertEq(address(escrow.denylist()), address(d2));
        assertEq(address(escrow.vault()), address(v2));
        assertEq(address(escrow.disputePanel()), address(p2));
        assertEq(escrow.lockedValue(), 0);
    }

    function test_strangerCannotRepointDeps() public {
        address eve = makeAddr("eve");
        vm.startPrank(eve);
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        escrow.setDenylist(address(denylist));
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        escrow.setVault(address(vault));
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        escrow.setDisputePanel(address(panel));
        vm.stopPrank();
        assertEq(address(escrow.denylist()), address(denylist));
        assertEq(address(escrow.vault()), address(vault));
        assertEq(address(escrow.disputePanel()), address(panel));
    }

    function test_constructorEmitsInitialDependencyEvents() public {
        address gov = makeAddr("gov-ctor-events");
        vm.expectEmit(true, true, true, true);
        emit OwnershipTransferred(address(0), address(this));
        vm.expectEmit(true, true, true, true);
        emit DenylistUpdated(address(0), address(denylist), address(this), block.timestamp);
        vm.expectEmit(true, true, true, true);
        emit VaultUpdated(address(0), address(vault), address(this), block.timestamp);
        vm.expectEmit(true, true, true, true);
        emit DisputePanelUpdated(address(0), address(panel), address(this), block.timestamp);
        BotAttestationEscrow fresh = new BotAttestationEscrow(address(denylist), address(vault), address(panel), gov);
        assertEq(fresh.governance(), gov);
        assertEq(address(fresh.vault()), address(vault));
        assertEq(address(fresh.disputePanel()), address(panel));
        assertEq(fresh.lockedValue(), 0);
    }

    function test_governanceVaultAndPanelEventsWhenUnfunded() public {
        Vault v2 = new Vault(address(denylist));
        DisputePanel p2 = new DisputePanel();
        uint256 ts = block.timestamp;

        vm.expectEmit(true, true, true, true, address(escrow));
        emit VaultUpdated(address(vault), address(v2), governance, ts);
        vm.prank(governance);
        escrow.setVault(address(v2));
        assertEq(address(escrow.vault()), address(v2));

        vm.expectEmit(true, true, true, true, address(escrow));
        emit DisputePanelUpdated(address(panel), address(p2), governance, ts);
        vm.prank(governance);
        escrow.setDisputePanel(address(p2));
        assertEq(address(escrow.disputePanel()), address(p2));
        assertEq(escrow.governance(), governance);
        assertEq(escrow.lockedValue(), 0);
    }

    function test_sameVaultAndPanelRevert() public {
        vm.startPrank(governance);
        vm.expectRevert(BotAttestationEscrow.ZeroAddress.selector);
        escrow.setVault(address(0));
        vm.expectRevert(BotAttestationEscrow.ZeroAddress.selector);
        escrow.setDisputePanel(address(0));
        vm.expectRevert(BotAttestationEscrow.VaultUnchanged.selector);
        escrow.setVault(address(vault));
        vm.expectRevert(BotAttestationEscrow.DisputePanelUnchanged.selector);
        escrow.setDisputePanel(address(panel));
        vm.stopPrank();
        assertEq(address(escrow.vault()), address(vault));
        assertEq(address(escrow.disputePanel()), address(panel));
        assertEq(escrow.governance(), governance);
    }

    function test_setDenylistPolicy() public {
        address gov = makeAddr("gov-policy");
        BotAttestationEscrow fresh = new BotAttestationEscrow(address(denylist), address(vault), address(panel), gov);
        Denylist other = new Denylist();

        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        fresh.setDenylist(address(other));

        vm.prank(gov);
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        fresh.setDenylist(address(other));
        vm.prank(gov);
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        fresh.setVault(address(vault));
        vm.prank(gov);
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        fresh.setDisputePanel(address(panel));

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.FundingBeforeGovernance.selector);
        fresh.createEscrow{ value: 1 ether }(keccak256("before-accept"), payee, payerBot, payeeBot, 3600);

        fresh.transferOwnership(gov);
        vm.prank(gov);
        fresh.acceptOwnership();
        assertEq(fresh.owner(), gov);
        assertEq(fresh.governance(), gov);

        vm.expectEmit(true, true, true, true, address(fresh));
        emit DenylistUpdated(address(denylist), address(other), gov, block.timestamp);
        vm.prank(gov);
        fresh.setDenylist(address(other));
        assertEq(address(fresh.denylist()), address(other));

        vm.prank(gov);
        fresh.setDenylist(address(denylist));

        vm.prank(address(this));
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        fresh.setDenylist(address(other));

        bytes32 fundedId = keccak256("funded-policy");
        vm.prank(payer);
        fresh.createEscrow{ value: 1 ether }(fundedId, payee, payerBot, payeeBot, 3600);
        assertEq(fresh.lockedValue(), 1 ether);

        vm.startPrank(gov);
        vm.expectRevert(BotAttestationEscrow.DependencyChangeWhileFunded.selector);
        fresh.setDenylist(address(other));
        vm.expectRevert(BotAttestationEscrow.DependencyChangeWhileFunded.selector);
        fresh.setVault(address(vault));
        vm.expectRevert(BotAttestationEscrow.DependencyChangeWhileFunded.selector);
        fresh.setDisputePanel(address(panel));
        vm.stopPrank();
        assertEq(address(fresh.denylist()), address(denylist));
        assertEq(address(fresh.vault()), address(vault));
        assertEq(address(fresh.disputePanel()), address(panel));
        assertEq(fresh.governance(), gov);

        vm.prank(payer);
        fresh.release(fundedId);
        assertEq(fresh.lockedValue(), 0);
        // Credited ETH is not an open escrow. Setters ignore totalOwed.
        assertEq(fresh.totalOwed(), 1 ether);
        assertEq(fresh.pendingWithdrawals(payee), 1 ether);

        vm.prank(gov);
        fresh.setDenylist(address(other));
        assertEq(address(fresh.denylist()), address(other));
    }

    function test_vaultOperatorBindAndRotate() public {
        bytes32 botId = keccak256("op-bot");
        vault.register(botId, keccak256("w5"), keccak256("b5"), keccak256("p5"), Vault.Tier.Financial);
        assertEq(vault.operator(botId), address(0));
        vault.setOperator(botId, payer);
        assertEq(vault.operator(botId), payer);
        vault.setOperator(botId, payee);
        assertEq(vault.operator(botId), payee);
    }

    // -------------------------------------------------------------------------
    // ESC-M-1. On unfixed main (300fbae) `dispute()` accepted any existing panel
    // case whose subject equalled the caller-chosen escrowId. `forge test
    // --match-contract EscM1Repro` against that tree (temporary reproduction,
    // not kept) passed all five attacks: payee balance increased by 1 ether on
    // (1) post-expiry upheld release, (2) denylist bypass release, (4) a second
    // escrow sharing the panel, and (5) two pre-create uphold votes then a
    // third vote plus denylist; (3) refunded the payer 1 ether before expiry.
    // -------------------------------------------------------------------------

    /// @notice (1) A pre-upheld dispute cannot be linked after expiry to steal the refund.
    function test_escM1_preUpheldAfterExpiryCannotStealRefund() public {
        bytes32 escrowId = keccak256("esc-m1-expiry-steal");
        bytes32 disputeId = keccak256("esc-m1-expiry-steal-d");
        uint256 amount = 1 ether;

        vm.prank(payee);
        panel.openDispute(disputeId, escrowId, "pre-opened");
        _panelRule(disputeId, true);

        _create(escrowId, amount, 100);
        vm.warp(block.timestamp + 101);

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.DisputeAlreadyResolved.selector);
        escrow.dispute(escrowId, disputeId);

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.EscrowExpired.selector);
        escrow.release(escrowId);

        uint256 before = payer.balance;
        vm.prank(payer);
        escrow.refund(escrowId);
        _claim(payer);
        assertEq(payer.balance, before + amount);
        assertEq(address(escrow).balance, 0);
    }

    /// @notice (2) A pre-upheld dispute cannot bypass a post-create denylist.
    function test_escM1_preUpheldDenylistBypassRejected() public {
        bytes32 escrowId = keccak256("esc-m1-denylist");
        bytes32 disputeId = keccak256("esc-m1-denylist-d");
        uint256 amount = 1 ether;

        vm.prank(payee);
        panel.openDispute(disputeId, escrowId, "pre-opened");
        _panelRule(disputeId, true);

        _create(escrowId, amount, 3600);
        denylist.addExact(keccak256("w2"));

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.DisputeAlreadyResolved.selector);
        escrow.dispute(escrowId, disputeId);

        vm.prank(payee);
        vm.expectRevert(abi.encodeWithSignature("AttestationFailed(string)", "payee bot denylisted"));
        escrow.release(escrowId);
        assertEq(address(escrow).balance, amount);
        (,,,,,,, BotAttestationEscrow.EscrowState state,) = _escrowTuple(escrowId);
        assertEq(uint256(state), uint256(BotAttestationEscrow.EscrowState.Open));
    }

    /// @notice (3) A resolved unwind on the same subject cannot instant-refund a new escrow.
    function test_escM1_resolvedUnwindCannotInstantRefund() public {
        bytes32 escrowId = keccak256("esc-m1-unwind");
        bytes32 disputeId = keccak256("esc-m1-unwind-d");
        uint256 amount = 1 ether;

        vm.prank(payer);
        panel.openDispute(disputeId, escrowId, "pre-unwound");
        _panelRule(disputeId, false);

        _create(escrowId, amount, 3600);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputeAlreadyResolved.selector);
        escrow.dispute(escrowId, disputeId);

        vm.prank(payer);
        vm.expectRevert(bytes("not expired"));
        escrow.refund(escrowId);
        assertEq(address(escrow).balance, amount);
    }

    /// @notice (4) A second escrow deployment sharing the panel rejects an old ruling.
    function test_escM1_secondDeploymentRejectsOldRuling() public {
        bytes32 escrowId = keccak256("esc-m1-second");
        bytes32 disputeId = keccak256("esc-m1-second-d");
        uint256 amount = 1 ether;

        vm.prank(payee);
        panel.openDispute(disputeId, escrowId, "old ruling");
        _panelRule(disputeId, true);

        BotAttestationEscrow escrow2 = _secondEscrow();
        vm.prank(payer);
        escrow2.createEscrow{ value: amount }(escrowId, payee, payerBot, payeeBot, 3600);

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.DisputeAlreadyResolved.selector);
        escrow2.dispute(escrowId, disputeId);

        (,,,,,,, BotAttestationEscrow.EscrowState state,) = escrow2.escrows(escrowId);
        assertEq(uint256(state), uint256(BotAttestationEscrow.EscrowState.Open));
        assertEq(address(escrow2).balance, amount);
    }

    /// @notice (5) Two uphold votes before create, still unresolved, same timestamp.
    /// @dev `resolved` is false and `createdAt` is equal, so checks 2 and 4 pass.
    ///      The vote total is what rejects the link.
    function test_escM1_twoUpholdVotesBeforeCreateRejected() public {
        bytes32 escrowId = keccak256("esc-m1-two-votes");
        bytes32 disputeId = keccak256("esc-m1-two-votes-d");
        uint256 openedAt = block.timestamp;

        vm.prank(payee);
        panel.openDispute(disputeId, escrowId, "pre-voted");
        vm.prank(arb1);
        panel.vote(disputeId, true);
        vm.prank(arb2);
        panel.vote(disputeId, true);

        _create(escrowId, 1 ether, 3600);

        (,,, uint256 votesFor, uint256 votesAgainst, bool resolved,, uint256 disputeCreatedAt) =
            panel.disputes(disputeId);
        (,,,,, uint256 escrowCreatedAt,,,) = escrow.escrows(escrowId);
        assertEq(disputeCreatedAt, openedAt);
        assertEq(escrowCreatedAt, openedAt);
        assertFalse(resolved);
        assertEq(votesFor, 2);
        assertEq(votesAgainst, 0);

        vm.prank(payee);
        vm.expectRevert(BotAttestationEscrow.DisputeVotesCast.selector);
        escrow.dispute(escrowId, disputeId);
    }

    function test_escM1_thirdPartyChallengerRejected() public {
        bytes32 escrowId = keccak256("esc-m1-challenger");
        _create(escrowId, 1 ether, 3600);
        bytes32 disputeId = keccak256("esc-m1-challenger-d");
        vm.prank(makeAddr("stranger-challenger"));
        panel.openDispute(disputeId, escrowId, "not a party");

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputeChallengerNotParty.selector);
        escrow.dispute(escrowId, disputeId);
    }

    function test_escM1_disputePredatesEscrowRejected() public {
        bytes32 escrowId = keccak256("esc-m1-predates");
        bytes32 disputeId = keccak256("esc-m1-predates-d");
        vm.prank(payer);
        panel.openDispute(disputeId, escrowId, "early");
        vm.warp(block.timestamp + 1);
        _create(escrowId, 1 ether, 3600);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputePredatesEscrow.selector);
        escrow.dispute(escrowId, disputeId);
    }

    function test_escM1_disputeAfterExpiryRejected() public {
        bytes32 escrowId = keccak256("esc-m1-after-expiry");
        _create(escrowId, 1 ether, 100);
        bytes32 disputeId = keccak256("esc-m1-after-expiry-d");
        vm.prank(payer);
        panel.openDispute(disputeId, escrowId, "in window");
        vm.warp(block.timestamp + 101);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputeAfterExpiry.selector);
        escrow.dispute(escrowId, disputeId);
    }

    function test_escM1_alreadyResolvedRejected() public {
        bytes32 escrowId = keccak256("esc-m1-resolved");
        _create(escrowId, 1 ether, 3600);
        bytes32 disputeId = keccak256("esc-m1-resolved-d");
        vm.prank(payer);
        panel.openDispute(disputeId, escrowId, "then ruled");
        _panelRule(disputeId, true);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputeAlreadyResolved.selector);
        escrow.dispute(escrowId, disputeId);
    }

    function test_escM1_votesAlreadyCastRejected() public {
        bytes32 escrowId = keccak256("esc-m1-one-vote");
        _create(escrowId, 1 ether, 3600);
        bytes32 disputeId = keccak256("esc-m1-one-vote-d");
        vm.prank(payee);
        panel.openDispute(disputeId, escrowId, "voted");
        vm.prank(arb1);
        panel.vote(disputeId, true);

        (,,, uint256 votesFor, uint256 votesAgainst, bool resolved,,) = panel.disputes(disputeId);
        assertEq(votesFor, 1);
        assertEq(votesAgainst, 0);
        assertFalse(resolved);

        vm.prank(payer);
        vm.expectRevert(BotAttestationEscrow.DisputeVotesCast.selector);
        escrow.dispute(escrowId, disputeId);
    }

    /// @notice Same-block open is allowed: dispute.createdAt >= escrow.createdAt.
    function test_escM1_sameBlockDisputeLinks() public {
        bytes32 escrowId = keccak256("esc-m1-same-block");
        bytes32 disputeId = keccak256("esc-m1-same-block-d");
        _create(escrowId, 1 ether, 3600);
        vm.prank(payee);
        panel.openDispute(disputeId, escrowId, "same block");

        (,,,,, uint256 escrowCreatedAt,,,) = escrow.escrows(escrowId);
        (,,,,,,, uint256 disputeCreatedAt) = panel.disputes(disputeId);
        assertEq(disputeCreatedAt, escrowCreatedAt);

        vm.prank(payee);
        escrow.dispute(escrowId, disputeId);
        (,,,,,,, BotAttestationEscrow.EscrowState state, bytes32 linked) = _escrowTuple(escrowId);
        assertEq(uint256(state), uint256(BotAttestationEscrow.EscrowState.Disputed));
        assertEq(linked, disputeId);
    }

    /// @notice Linking is allowed at the exact expiry timestamp (`block.timestamp <= expiresAt`).
    function test_escM1_disputeAllowedAtExactExpiry() public {
        bytes32 escrowId = keccak256("esc-m1-exact-expiry");
        _create(escrowId, 1 ether, 100);
        bytes32 disputeId = keccak256("esc-m1-exact-expiry-d");
        vm.prank(payer);
        panel.openDispute(disputeId, escrowId, "at edge");

        (,,,,,, uint256 expiresAt,,) = escrow.escrows(escrowId);
        vm.warp(expiresAt);
        vm.prank(payer);
        escrow.dispute(escrowId, disputeId);

        (,,,,,,, BotAttestationEscrow.EscrowState state,) = _escrowTuple(escrowId);
        assertEq(uint256(state), uint256(BotAttestationEscrow.EscrowState.Disputed));
    }

    function _secondEscrow() internal returns (BotAttestationEscrow escrow2) {
        escrow2 = new BotAttestationEscrow(address(denylist), address(vault), address(panel), governance);
        escrow2.transferOwnership(governance);
        vm.prank(governance);
        escrow2.acceptOwnership();
    }

    function _escrowTuple(
        bytes32 escrowId
    )
        internal
        view
        returns (
            address,
            address,
            bytes32,
            bytes32,
            uint256,
            uint256,
            uint256,
            BotAttestationEscrow.EscrowState,
            bytes32
        )
    {
        return escrow.escrows(escrowId);
    }
}

contract DeployEscrowGuardTest is Test {
    DeployBotAttestationEscrow internal deploy;

    function setUp() public {
        deploy = new DeployBotAttestationEscrow();
    }

    function test_allowsBaseSepolia() public {
        vm.chainId(84532);
        deploy.requireAllowedChain();
    }

    function test_refusesMainnet() public {
        vm.chainId(1);
        vm.expectRevert(bytes("DeployEscrow: mainnet forbidden"));
        deploy.requireAllowedChain();
    }

    function test_refusesEthSepoliaByDefault() public {
        vm.chainId(11155111);
        vm.expectRevert(
            bytes("DeployEscrow: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)")
        );
        deploy.requireAllowedChain();
    }

    function test_refusesAnvil() public {
        vm.chainId(31337);
        vm.expectRevert(
            bytes("DeployEscrow: Base Sepolia (84532) only; see README to switch to ETH Sepolia (11155111)")
        );
        deploy.requireAllowedChain();
    }

    function test_constantsDocumentEthSepolia() public view {
        assertEq(deploy.ETH_SEPOLIA_CHAIN_ID(), 11155111);
        assertEq(deploy.ALLOWED_CHAIN_ID(), 84532);
        assertEq(deploy.ETH_MAINNET_CHAIN_ID(), 1);
    }

    function test_timelockMustBeSetAndNotDeployer() public {
        address deployer = address(this);
        vm.expectRevert(bytes("DeployEscrow: CORE_TIMELOCK unset"));
        deploy.requireTimelock(deployer, address(0));
        vm.expectRevert(bytes("DeployEscrow: CORE_TIMELOCK must not be deployer"));
        deploy.requireTimelock(deployer, deployer);
        deploy.requireTimelock(deployer, address(0x71C0));
    }

    function test_depsMustBeSet() public {
        address ok = address(0xBEEF);
        vm.expectRevert(bytes("DeployEscrow: DENYLIST unset"));
        deploy.requireDeps(address(0), ok, ok);
        vm.expectRevert(bytes("DeployEscrow: VAULT unset"));
        deploy.requireDeps(ok, address(0), ok);
        vm.expectRevert(bytes("DeployEscrow: DISPUTE_PANEL unset"));
        deploy.requireDeps(ok, ok, address(0));
        deploy.requireDeps(ok, ok, ok);
    }

    function test_readAddressUnsetReverts() public {
        vm.expectRevert(bytes("DeployEscrow: DENYLIST unset"));
        deploy.readAddress("DENYLIST", "DeployEscrow: DENYLIST unset");
    }

    function test_readAddressZeroReverts() public {
        vm.setEnv("DENYLIST", vm.toString(address(0)));
        vm.expectRevert(bytes("DeployEscrow: DENYLIST unset"));
        deploy.readAddress("DENYLIST", "DeployEscrow: DENYLIST unset");
    }

    function test_liveStackOnly() public {
        address denylist = deploy.LIVE_DENYLIST();
        address vault = deploy.LIVE_VAULT();
        address panel = deploy.LIVE_DISPUTE_PANEL();
        address timelock = deploy.LIVE_TIMELOCK();
        address other = address(0x1234);
        deploy.requireLiveStack(denylist, vault, panel, timelock);
        vm.expectRevert(bytes("DeployEscrow: DENYLIST is not the live Base Sepolia Denylist"));
        deploy.requireLiveStack(other, vault, panel, timelock);
        vm.expectRevert(bytes("DeployEscrow: VAULT is not the live Base Sepolia Vault"));
        deploy.requireLiveStack(denylist, other, panel, timelock);
        vm.expectRevert(bytes("DeployEscrow: DISPUTE_PANEL is not the live Base Sepolia DisputePanel"));
        deploy.requireLiveStack(denylist, vault, other, timelock);
        vm.expectRevert(bytes("DeployEscrow: CORE_TIMELOCK is not the live owner"));
        deploy.requireLiveStack(denylist, vault, panel, other);
        assertEq(deploy.SIMULATE_SENDER(), 0xDeaDDEaDDeAdDeAdDEAdDEaddeAddEAdDEAd0001);
        assertTrue(deploy.SIMULATE_SENDER() != timelock);
        assertEq(deploy.FOUNDRY_DEFAULT_SENDER(), 0x1804c8AB1F12E6bbf3894d4083f33e07309d1f38);
    }

    /// @dev `run` calls this only when `broadcasting()` is true. A Foundry unit test
    ///      runs as `ForgeContext.Test`, so `vm.isContext(ScriptBroadcast)` stays false
    ///      and `run()` cannot be driven into the broadcast branch.
    function test_broadcastSenderRejectsDefaultAndSimulate() public {
        address foundryDefault = deploy.FOUNDRY_DEFAULT_SENDER();
        address simulateSender = deploy.SIMULATE_SENDER();
        vm.expectRevert(bytes("DeployEscrow: pass --account and --sender"));
        deploy.requireBroadcastSender(foundryDefault);
        vm.expectRevert(bytes("DeployEscrow: pass --account and --sender"));
        deploy.requireBroadcastSender(simulateSender);
        deploy.requireBroadcastSender(address(0x5D46));
    }

    function test_deployWiresDepsAndHandsOffToTimelock() public {
        Denylist denylist = new Denylist();
        Vault vault = new Vault(address(denylist));
        DisputePanel panel = new DisputePanel();
        address timelock = address(0x71C0);

        BotAttestationEscrow escrow = deploy.deploy(address(denylist), address(vault), address(panel), timelock);
        assertEq(address(escrow.denylist()), address(denylist));
        assertEq(address(escrow.vault()), address(vault));
        assertEq(address(escrow.disputePanel()), address(panel));
        assertEq(escrow.governance(), timelock);
        assertEq(escrow.owner(), address(deploy));
        assertEq(escrow.pendingOwner(), timelock);

        Denylist swapped = new Denylist();
        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        escrow.setDenylist(address(swapped));

        vm.prank(timelock);
        escrow.acceptOwnership();
        assertEq(escrow.owner(), timelock);
        assertEq(escrow.pendingOwner(), address(0));

        vm.expectRevert(BotAttestationEscrow.NotGovernance.selector);
        escrow.setDenylist(address(swapped));

        vm.prank(timelock);
        escrow.setDenylist(address(swapped));
        assertEq(address(escrow.denylist()), address(swapped));
    }
}

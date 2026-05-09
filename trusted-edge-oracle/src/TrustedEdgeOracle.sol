// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract TrustedEdgeOracle {
    address public owner;

    struct Attestation {
        string deviceId;
        string result;
        uint256 timestamp;
        string imageHash;
        bytes32 payloadHash;
        address relayer;
    }

    Attestation[] public attestations;

    mapping(address => bool) public authorizedRelayers;

    event InferenceAttested(
        uint256 indexed id,
        string deviceId,
        string result,
        uint256 timestamp,
        bytes32 payloadHash,
        address relayer
    );

    constructor() {
        owner = msg.sender;

        authorizedRelayers[msg.sender] = true;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyRelayer() {
        require(
            authorizedRelayers[msg.sender],
            "unauthorized relayer"
        );
        _;
    }

    function authorizeRelayer(address relayer)
        external
        onlyOwner
    {
        authorizedRelayers[relayer] = true;
    }

    function submitInference(
        string memory deviceId,
        string memory result,
        uint256 timestamp,
        string memory imageHash,
        bytes32 payloadHash
    ) external onlyRelayer {
        attestations.push(
            Attestation({
                deviceId: deviceId,
                result: result,
                timestamp: timestamp,
                imageHash: imageHash,
                payloadHash: payloadHash,
                relayer: msg.sender
            })
        );

        emit InferenceAttested(
            attestations.length - 1,
            deviceId,
            result,
            timestamp,
            payloadHash,
            msg.sender
        );
    }

    function getAttestationCount()
        external
        view
        returns (uint256)
    {
        return attestations.length;
    }
}

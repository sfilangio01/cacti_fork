import "jest-extended";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  BesuTestEnvironment,
  FabricTestEnvironment,
  EthereumTestEnvironment, // Added Ethereum environment
  getTransactRequest,
} from "../../test-utils";
import { IBesuConnectionConfig } from "../../environments/besu-test-environment";
import { IFabricConnectionConfig } from "../../environments/fabric-test-environment";
import { IEthereumConnectionConfig } from "../../environments/ethereum-test-environment"; // Added Ethereum config interface
import * as fs from "fs-extra";
import { SATPGateway, TokenType } from "../../../../main/typescript";
import { v4 as uuidv4 } from "uuid";
import * as assert from "assert";

const LOG_LEVEL: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "SATP - Integration Test",
});

const TIMEOUT = 9000000; // 15 minutes for tests

let besuEnv: BesuTestEnvironment;
let fabricEnv: FabricTestEnvironment;
let ethereumEnv: EthereumTestEnvironment; // Added Ethereum environment variable
let gateway: SATPGateway;

/**
 * Interface representing the combined ledger configurations loaded from a temporary file.
 */
interface ICombinedLedgerConfigs {
  besu: IBesuConnectionConfig;
  fabric: IFabricConnectionConfig;
  ethereum: IEthereumConnectionConfig; // Added Ethereum config
  knexLocalConfig: any;
  knexRemoteConfig: any;
  gatewayIdentity: any;
  gatewayApiHost: string;
}

/**
 * Global setup for this test file: Connects to the already running ledgers and SATP Gateway.
 * This runs once before any tests in this file.
 */
beforeAll(async () => {
  const configPath = process.env.TEST_ENV_CONFIG_PATH;
  if (!configPath) {
    throw new Error(
      "TEST_ENV_CONFIG_PATH environment variable not set. Global setup likely failed or wasn't run.",
    );
  }

  const loadedLedgerConfigs: ICombinedLedgerConfigs =
    await fs.readJson(configPath);
  log.info(`Loaded ledger configurations from ${configPath}`); // Connect to existing Besu, Fabric, and Ethereum environments

  besuEnv = await BesuTestEnvironment.connectToExistingEnvironment(
    loadedLedgerConfigs.besu,
  );
  log.info("Connected to existing Besu Ledger successfully.");

  fabricEnv = await FabricTestEnvironment.connectToExistingEnvironment(
    loadedLedgerConfigs.fabric,
  );
  log.info("Connected to existing Fabric Ledger successfully."); // Connect to existing Ethereum environment

  ethereumEnv = await EthereumTestEnvironment.connectToExistingEnvironment(
    loadedLedgerConfigs.ethereum,
  );
  log.info("Connected to existing Ethereum Ledger successfully."); // Access the globally initialized SATP Gateway instance

  gateway = (global as any).__SATP_GATEWAY__;
  if (!gateway) {
    throw new Error(
      "SATP Gateway instance not found in global context. Global setup likely failed.",
    );
  }
  log.info("Connected to existing SATP Gateway successfully.");
}, TIMEOUT);

/**
 * Describes the test suite for SATP Gateway token transfers.
 * Tests within this suite assume ledgers and the SATP Gateway are already running.
 */
describe("SATP Gateway Token Transfer Tests", () => {
  jest.setTimeout(TIMEOUT); /**
   * Test scenario: Initial mint of tokens on the Besu owner account.
   */

  it("should mint 100 tokens to the Besu owner account (initial check)", async () => {
    await besuEnv.mintTokens("100");
    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "100",
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info("Besu owner account balance verified after minting.");
  }); /**
   * Test scenario: Transfer tokens from Besu to Fabric using SATP Gateway.
   */

  it("should realize a transfer from Besu to Fabric", async () => {
    const dispatcher = gateway.BLODispatcherInstance;
    assert.ok(dispatcher, "SATP Gateway Dispatcher not initialized."); // Retrieve approve addresses

    const reqApproveBesuAddress = await dispatcher.GetApproveAddress({
      networkId: besuEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    assert.ok(
      reqApproveBesuAddress?.approveAddress,
      "Besu approve address is undefined",
    );

    await besuEnv.giveRoleToBridge(reqApproveBesuAddress.approveAddress);
    await besuEnv.approveAmount(reqApproveBesuAddress.approveAddress, "100");
    log.debug("Approved 100 amount to the Besu Bridge Address");

    const reqApproveFabricAddress = await dispatcher.GetApproveAddress({
      networkId: fabricEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    assert.ok(
      reqApproveFabricAddress?.approveAddress,
      "Fabric approve address is undefined",
    );

    await fabricEnv.giveRoleToBridge(fabricEnv.getBridgeMSPID());

    const req = getTransactRequest(
      `besu_to_fabric_${uuidv4()}`,
      besuEnv,
      fabricEnv,
      "100",
      "100",
    );

    const res = await dispatcher.Transact(req);
    log.info(`SATP Transact Response (Besu to Fabric): ${res?.statusResponse}`);
    assert.ok(res?.statusResponse, `SATP Transact failed (Besu to Fabric)"}`); // Verify balances after transfer

    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount transferred correctly from Besu Owner account.");

    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      reqApproveBesuAddress?.approveAddress,
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transfer correctly to the Wrapper account");

    await fabricEnv.checkBalance(
      fabricEnv.getTestContractName(),
      fabricEnv.getTestChannelName(),
      reqApproveFabricAddress?.approveAddress,
      "0",
      fabricEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transfer correctly from the Bridge account");

    await fabricEnv.checkBalance(
      fabricEnv.getTestContractName(),
      fabricEnv.getTestChannelName(),
      fabricEnv.getTestOwnerAccount(),
      "100",
      fabricEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transfer correctly to the Owner account");
  }); /**
   * Test scenario: Transfer tokens from Fabric to Besu using SATP Gateway.
   */

  it("should realize a transfer from Fabric to Besu", async () => {
    const dispatcher = gateway.BLODispatcherInstance;
    assert.ok(dispatcher, "SATP Gateway Dispatcher not initialized.");

    await fabricEnv.giveRoleToBridge(fabricEnv.getBridgeMSPID());
    log.debug("Given bridge role on Fabric.");

    const reqApproveFabricAddress = await dispatcher.GetApproveAddress({
      networkId: fabricEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    assert.ok(
      reqApproveFabricAddress?.approveAddress,
      "Fabric approve address is undefined",
    );

    await fabricEnv.approveAmount(
      reqApproveFabricAddress.approveAddress,
      "100",
    );
    log.debug("Approved 100 amount to the Fabric Bridge Address.");

    const reqApproveBesuAddress = await dispatcher.GetApproveAddress({
      networkId: besuEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    assert.ok(
      reqApproveBesuAddress?.approveAddress,
      "Besu approve address is undefined",
    );

    await besuEnv.giveRoleToBridge(reqApproveBesuAddress.approveAddress);
    log.debug("Given bridge role on Besu.");

    const req = getTransactRequest(
      `fabric_to_besu_${uuidv4()}`,
      fabricEnv,
      besuEnv,
      "100",
      "100",
    );

    const res = await dispatcher.Transact(req);
    log.info(`SATP Transact Response (Fabric to Besu): ${res?.statusResponse}`);
    assert.ok(res?.statusResponse, `SATP Transact failed (Fabric to Besu)"}`); // Verify balances after transfer (Fabric side)

    await fabricEnv.checkBalance(
      fabricEnv.getTestContractName(),
      fabricEnv.getTestChannelName(),
      fabricEnv.getTestOwnerAccount(),
      "0",
      fabricEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount transferred correctly from Fabric Owner account.");

    await fabricEnv.checkBalance(
      fabricEnv.getTestContractName(),
      fabricEnv.getTestChannelName(),
      reqApproveFabricAddress.approveAddress,
      "0",
      fabricEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount transferred correctly from Fabric Wrapper account."); // Verify balances after transfer (Besu side)

    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "100",
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount transferred correctly to Besu Owner account.");

    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      reqApproveBesuAddress.approveAddress,
      "0",
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info(
      "Amount transferred correctly from Besu Bridge account (or as expected).",
    );
  }); /**
   * Test scenario: Transfer tokens from Besu to Ethereum using SATP Gateway.
   */

  it("should realize a transfer from Besu to Ethereum", async () => {
    const dispatcher = gateway.BLODispatcherInstance;
    assert.ok(dispatcher, "SATP Gateway Dispatcher not initialized."); // Besu side setup (Assuming initial minting was already handled)

    const reqApproveBesuAddress = await dispatcher.GetApproveAddress({
      networkId: besuEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    assert.ok(
      reqApproveBesuAddress?.approveAddress,
      "Besu approve address is undefined",
    );
    await besuEnv.giveRoleToBridge(reqApproveBesuAddress.approveAddress);
    await besuEnv.approveAmount(reqApproveBesuAddress.approveAddress, "100");
    log.debug("Approved 100 amount to the Besu Bridge Address."); // Ethereum side setup

    const reqApproveEthereumAddress = await dispatcher.GetApproveAddress({
      networkId: ethereumEnv.network,
      tokenType: TokenType.NonstandardFungible,
    });
    assert.ok(
      reqApproveEthereumAddress?.approveAddress,
      "Ethereum approve address is undefined",
    );
    await ethereumEnv.giveRoleToBridge(
      reqApproveEthereumAddress.approveAddress,
    );
    log.debug("Given bridge role on Ethereum.");

    const req = getTransactRequest(
      `besu_to_ethereum_${uuidv4()}`,
      besuEnv,
      ethereumEnv,
      "100",
      "100",
    );

    const res = await dispatcher.Transact(req);
    log.info(
      `SATP Transact Response (Besu to Ethereum): ${res?.statusResponse}`,
    );
    assert.ok(res?.statusResponse, `SATP Transact failed (Besu to Ethereum)`); // Verify balances after transfer (Besu side)
    // We expect the Besu owner balance to decrease by 100

    await besuEnv.checkBalance(
      besuEnv.getTestContractName(),
      besuEnv.getTestContractAddress(),
      besuEnv.getTestContractAbi(),
      besuEnv.getTestOwnerAccount(),
      "0", // Assuming initial balance was 100, now 0 after transfer
      besuEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount transferred correctly from Besu Owner account."); // Verify balances after transfer (Ethereum side)
    // We expect the Ethereum owner balance to increase by 100

    await ethereumEnv.checkBalance(
      ethereumEnv.getTestContractName(),
      ethereumEnv.getTestContractAddress(),
      ethereumEnv.getTestContractAbi(),
      ethereumEnv.getTestOwnerAccount(),
      "100", // Assuming initial balance was 0, now 100
      ethereumEnv.getTestOwnerSigningCredential(),
    );
    log.info("Amount was transferred correctly to the Ethereum Owner account.");
  });
});

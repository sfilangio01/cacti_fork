import * as fs from "fs-extra";
import * as path from "path";
import { randomUUID as uuidv4 } from "node:crypto";
import {
  BesuTestEnvironment,
  IBesuConnectionConfig,
} from "./environments/besu-test-environment";
import {
  FabricTestEnvironment,
  IFabricConnectionConfig,
} from "./environments/fabric-test-environment";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  pruneDockerAllIfGithubAction,
  Containers,
} from "@hyperledger/cactus-test-tooling";
import { ClaimFormat } from "../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
// ADDED: Import FabricContractInvocationType
import { FabricContractInvocationType } from "@hyperledger/cactus-plugin-ledger-connector-fabric";
// ADDED: Import assert module
import * as assert from "assert";

const LOG_LEVEL: LogLevelDesc = "INFO";
const log = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "JestGlobalSetup",
});

const TEMP_CONFIG_FILE = path.join(process.cwd(), ".test-env-config.json");

/**
 * Jest Global Setup function.
 * This function is executed once before all test suites.
 * It is responsible for starting ALL ledgers (Besu, Fabric) and saving their connection details.
 */
module.exports = async function globalSetup() {
  log.info("Jest Global Setup: Starting ALL Ledgers (Besu, Fabric)...");

  try {
    await pruneDockerAllIfGithubAction({ logLevel: LOG_LEVEL });
    log.info("Docker pruning successful.");
  } catch (error: any) {
    log.error(`Docker pruning failed: ${error.message}`);
    await Containers.logDiagnostics({ logLevel: LOG_LEVEL });
    throw error;
  }

  // --- Start Besu Test Environment ---
  const besuContractName = "SATPContract";
  const besuEnv = await BesuTestEnvironment.setupTestEnvironment({
    contractName: besuContractName,
    logLevel: LOG_LEVEL,
    network: `besu_test_network_${uuidv4()}`,
  });
  log.info("Besu Ledger started successfully.");

  await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE, besuContractName); // Deploy contract here

  // Extract Besu connection details
  const besuConfig: IBesuConnectionConfig = {
    rpcApiHttpHost: besuEnv.connectorOptions.rpcApiHttpHost,
    rpcApiWsHost: besuEnv.connectorOptions.rpcApiWsHost,
    firstHighNetWorthAccount: besuEnv.firstHighNetWorthAccount,
    bridgeEthAccount: besuEnv.bridgeEthAccount,
    assigneeEthAccount: besuEnv.assigneeEthAccount!,
    besuKeyPair: besuEnv.besuKeyPair,
    keychainEntryKey: besuEnv.keychainEntryKey,
    keychainEntryValue: besuEnv.keychainEntryValue,
    erc20TokenContract: besuContractName,
    assetContractAddress: besuEnv.assetContractAddress, // Crucial: Capture after deployment
    networkId: besuEnv.network,
    logLevel: LOG_LEVEL,
  };

  // --- Start Fabric Test Environment (Network Up) ---
  const fabricContractName = "satp-contract";
  const fabricEnv = await FabricTestEnvironment.setupTestEnvironment({
    contractName: fabricContractName,
    logLevel: LOG_LEVEL,
    claimFormat: ClaimFormat.BUNGEE,
    network: `fabric_test_network_${uuidv4()}`,
  });
  log.info(
    "Fabric Ledger network started successfully. Now deploying chaincode...",
  );

  // --- DEPLOY FABRIC CHAINCODE GLOBALLY ---
  await fabricEnv.deployAndSetupContracts(); // Call without overrides to use default set during setup
  log.info(
    `Fabric Chaincode '${fabricEnv.satpContractName}' deployed successfully on channel '${fabricEnv.fabricChannelName}'.`,
  );

  // --- Get Fabric ClientID after chaincode deployment ---
  const responseClientId = await fabricEnv.connector.transact({
    contractName: fabricEnv.satpContractName,
    channelName: fabricEnv.fabricChannelName,
    params: [],
    methodName: "ClientAccountID",
    invocationType: FabricContractInvocationType.Send,
    signingCredential: fabricEnv.fabricSigningCredential,
  });

  assert.ok(
    responseClientId.functionOutput,
    "Fabric ClientAccountID did not return a valid output.",
  );
  const clientId: string = responseClientId.functionOutput.toString();

  fabricEnv.clientId = clientId;

  log.info(`Fabric Client ID obtained: ${clientId}`);

  // Extract Fabric connection details
  const fabricConfig: IFabricConnectionConfig = {
    connectionProfileOrg1: fabricEnv.connectionProfile,
    connectionProfileOrg2: fabricEnv.bridgeProfile,
    sshConfig: fabricEnv.sshConfig,
    userIdentity: fabricEnv.userIdentity,
    bridgeIdentity: fabricEnv.bridgeIdentity!,
    fabricChannelName: fabricEnv.fabricChannelName,
    satpContractName: fabricEnv.satpContractName, // Use name set during deployment
    clientId: clientId,
    keychainEntryKeyBridge: fabricEnv.keychainEntryKeyBridge,
    keychainEntryValueBridge: fabricEnv.keychainEntryValueBridge,
    // Store the actual keychain IDs that were generated
    fabricSigningCredential: {
      keychainId: fabricEnv.fabricSigningCredential.keychainId, // Store the UUID
      keychainRef: fabricEnv.fabricSigningCredential.keychainRef,
    },
    bridgeFabricSigningCredential: {
      keychainId: fabricEnv.bridgeFabricSigningCredential.keychainId, // Store the UUID
      keychainRef: fabricEnv.bridgeFabricSigningCredential.keychainRef,
    },
    claimFormat: ClaimFormat.BUNGEE,
    bridgeMSPID: fabricEnv.getBridgeMSPID(),
    logLevel: LOG_LEVEL,
    networkId: fabricEnv.network,
  };

  // --- Store Ledger Instances for Teardown ---
  (global as any).__FABRIC_LEDGER_ENV__ = fabricEnv;

  // --- Compile All Connection Configurations ---
  const allLedgerConfigs = {
    besu: besuConfig,
    fabric: fabricConfig,
  };

  await fs.writeJson(TEMP_CONFIG_FILE, allLedgerConfigs);
  process.env.TEST_ENV_CONFIG_PATH = TEMP_CONFIG_FILE;

  log.info(`All ledger configurations written to: ${TEMP_CONFIG_FILE}`);
};

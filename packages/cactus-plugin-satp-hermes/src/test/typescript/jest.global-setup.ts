// jest.global-setup.ts
import * as fs from "fs-extra";
import * as path from "path";
import { randomUUID as uuidv4 } from "node:crypto";
import { LogLevelDesc, LoggerProvider } from "@hyperledger/cactus-common";
import {
  pruneDockerAllIfGithubAction,
  Containers,
} from "@hyperledger/cactus-test-tooling";
import { ClaimFormat } from "../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import {
  BesuTestEnvironment,
  IBesuConnectionConfig,
} from "./environments/besu-test-environment";
import {
  FabricTestEnvironment,
  IFabricConnectionConfig,
  IFabricTestEnvironmentOptions,
} from "./environments/fabric-test-environment";
import {
  EthereumTestEnvironment,
  IEthereumConnectionConfig,
  IEthereumTestEnvironment,
} from "./environments/ethereum-test-environment";
import {
  SATPGatewayConfig,
  SATPGateway,
  PluginFactorySATPGateway,
} from "../../main/typescript";
import { GatewayIdentity, Address } from "../../main/typescript/core/types";
import {
  SATP_ARCHITECTURE_VERSION,
  SATP_CORE_VERSION,
  SATP_CRASH_VERSION,
} from "../../main/typescript/core/constants";
import { Knex, knex } from "knex";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { createMigrationSource } from "../../main/typescript/database/knex-migration-source";
import { knexLocalInstance } from "../../main/typescript/database/knexfile";
import { knexRemoteInstance } from "../../main/typescript/database/knexfile-remote";

const LOG_LEVEL: LogLevelDesc = "DEBUG";
const log = LoggerProvider.getOrCreate({
  level: LOG_LEVEL,
  label: "JestGlobalSetup",
});

const TEMP_CONFIG_FILE = path.join(process.cwd(), ".test-env-config.json");

/**
 * Jest Global Setup function.
 * This function is executed once before all test suites.
 * It is responsible for starting ALL ledgers (Besu, Fabric, Ethereum) and the SATP Gateway,
 * then saving their connection details for individual tests.
 * These instances are stored in the global object and written to a temporary file
 * for access by individual test files.
 */
module.exports = async function globalSetup() {
  log.info(
    "Jest Global Setup: Starting ALL Ledgers (Besu, Fabric, Ethereum) and SATP Gateway...",
  );

  // Attempt to prune Docker containers before starting new ones
  try {
    await pruneDockerAllIfGithubAction({ logLevel: LOG_LEVEL });
    log.info("Docker pruning successful.");
  } catch (error: any) {
    log.error(`Docker pruning failed: ${error.message}`);
    await Containers.logDiagnostics({ logLevel: LOG_LEVEL });
    throw error; // Re-throw to fail setup if pruning fails
  }

  // --- Start Besu Test Environment ---
  const besuContractName = "SATPContract";
  const besuEnv = await BesuTestEnvironment.setupTestEnvironment({
    logLevel: LOG_LEVEL,
    network: `besu_test_network_${uuidv4()}`, // Unique network ID for isolation
  });
  log.info("Besu Ledger started successfully.");
  await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  log.info("Besu contract deployed and set up successfully.");

  // --- Start Fabric Test Environment ---
  // Uncommented as per the previous instruction to include Fabric in global setup

  const satpFabricChaincodeName = "satp-contract";
  const oracleFabricChaincodeName = "oracle-bl-contract";

  const fabricEnvOptions: IFabricTestEnvironmentOptions = {
    contractName: satpFabricChaincodeName,
    logLevel: LOG_LEVEL,
    network: `fabric_test_network_${uuidv4()}`, // Unique network ID for isolation
    claimFormat: ClaimFormat.DEFAULT,
  };

  const fabricEnv =
    await FabricTestEnvironment.setupTestEnvironment(fabricEnvOptions);
  log.info("Fabric Ledger started successfully. Now deploying chaincodes...");

  // Deploy SATP Fabric chaincode
  await fabricEnv.deployAndSetupChaincode(
    satpFabricChaincodeName,
    "./../fabric/contracts/satp-contract/chaincode-typescript",
    "1.0.0",
  );
  log.info(
    `Fabric SATP chaincode '${satpFabricChaincodeName}' deployed and initialized.`,
  );

  // Deploy Oracle Fabric chaincode
  await fabricEnv.deployAndSetupChaincode(
    oracleFabricChaincodeName,
    "./../fabric/contracts/oracle-bl-contract/chaincode-typescript",
    "1.0.0",
  );
  log.info(
    `Fabric Oracle chaincode '${oracleFabricChaincodeName}' deployed and initialized.`,
  );

  // --- Start Ethereum Test Environment ---
  const ethereumContractName = "SATPContract";
  const ethereumEnvOptions: IEthereumTestEnvironment = {
    contractName: ethereumContractName,
    logLevel: LOG_LEVEL,
    network: `ethereum_test_network_${uuidv4()}`, // Unique network ID for isolation
  };

  const ethereumEnv =
    await EthereumTestEnvironment.setupTestEnvironment(ethereumEnvOptions);
  log.info("Ethereum Ledger started successfully.");
  await ethereumEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  log.info("Ethereum contract deployed and set up successfully.");

  // --- Setup SATPGateway (Once Globally) ---
  const factoryOptions = {
    pluginImportType: "LOCAL" as any, // Type assertion for local plugin import
  };
  const factory = new PluginFactorySATPGateway(factoryOptions);

  const gatewayIdentity: GatewayIdentity = {
    id: "mockID",
    name: "CustomGateway",
    version: [
      {
        Core: SATP_CORE_VERSION,
        Architecture: SATP_ARCHITECTURE_VERSION,
        Crash: SATP_CRASH_VERSION,
      },
    ],
    proofID: "mockProofID10",
    address: "http://localhost" as Address, // Assuming gateway runs on localhost
  };

  // Setup Knex clients and run migrations once
  const migrationSource = await createMigrationSource();
  const knexLocalClient = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource: migrationSource },
  });
  const knexSourceRemoteClient = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource: migrationSource },
  });

  await knexLocalClient.migrate.latest();
  await knexSourceRemoteClient.migrate.latest();
  log.info("SATP Gateway databases migrated successfully.");

  // Create network configurations for the gateway
  const fabricNetworkOptions = fabricEnv.createFabricConfig(); // Fabric related line
  const besuNetworkOptions = besuEnv.createBesuConfig();
  const ethereumNetworkOptions = ethereumEnv.createEthereumConfig();

  const ontologiesPath = path.join(__dirname, "../ontologies"); // Path to ontologies

  const gatewayOptions: SATPGatewayConfig = {
    instanceId: uuidv4(), // Unique instance ID for the gateway
    logLevel: LOG_LEVEL,
    gid: gatewayIdentity,
    ccConfig: {
      // Include all three ledgers in the bridge configuration
      bridgeConfig: [
        fabricNetworkOptions, // Fabric related line
        besuNetworkOptions,
        ethereumNetworkOptions,
      ],
    },
    localRepository: knexLocalInstance.default,
    remoteRepository: knexRemoteInstance.default,
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    ontologyPath: ontologiesPath,
  };
  const gateway = await factory.create(gatewayOptions);
  await gateway.startup();
  log.info("SATP Gateway started successfully.");

  // --- Save ALL Ledger and Gateway Configs to Temp File ---
  // These configurations can be loaded by individual test files if needed
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
    assetContractAddress: besuEnv.assetContractAddress,
    networkId: besuEnv.network,
    logLevel: LOG_LEVEL,
  };

  const fabricConfig: IFabricConnectionConfig = {
    connectionProfileOrg1: fabricEnv.connectionProfile,
    connectionProfileOrg2: fabricEnv.bridgeProfile,
    sshConfig: fabricEnv.sshConfig,
    userIdentityCert: fabricEnv.userIdentity.credentials.certificate,
    userIdentityPrivateKey: fabricEnv.userIdentity.credentials.privateKey,
    userIdentityMspId: fabricEnv.userIdentity.mspId,
    bridgeIdentityCert: fabricEnv.bridgeIdentity!.credentials.certificate,
    bridgeIdentityPrivateKey: fabricEnv.bridgeIdentity!.credentials.privateKey,
    bridgeIdentityMspId: fabricEnv.bridgeIdentity!.mspId,
    fabricChannelName: fabricEnv.fabricChannelName,
    satpContractName: satpFabricChaincodeName,
    clientId: fabricEnv.clientId,
    claimFormat: fabricEnvOptions.claimFormat!,
    bridgeMSPID: fabricEnv.getBridgeMSPID(),
    logLevel: LOG_LEVEL,
    networkId: fabricEnv.network,
  };

  const ethereumConfig: IEthereumConnectionConfig = {
    rpcApiHttpHost: ethereumEnv.rpcApiHttpHost,
    rpcApiWsHost: ethereumEnv.rpcApiWsHost,
    bridgeEthAccount: ethereumEnv.bridgeEthAccount,
    keychainEntryKey: ethereumEnv.keychainEntryKey,
    keychainEntryValue: ethereumEnv.keychainEntryValue,
    erc20TokenContract: ethereumContractName,
    assetContractAddress: ethereumEnv.assetContractAddress,
    networkId: ethereumEnv.network,
    logLevel: LOG_LEVEL,
    chainId: ethereumEnv.chainId.toString() as any, // Convert BigInt to string for serialization
  };

  const allLedgerConfigs = {
    besu: besuConfig,
    fabric: fabricConfig, // Fabric related line
    ethereum: ethereumConfig,
    knexLocalConfig: knexLocalInstance.default,
    knexRemoteConfig: knexRemoteInstance.default,
    gatewayIdentity: gatewayIdentity,
    gatewayApiHost: "http://localhost:3010", // Assuming this is the gateway's API host
  };

  await fs.writeJson(TEMP_CONFIG_FILE, allLedgerConfigs);
  process.env.TEST_ENV_CONFIG_PATH = TEMP_CONFIG_FILE; // Store path in environment variable

  // Store environments and gateway instances in Jest's global object for direct access by tests
  (global as any).__BESU_LEDGER_ENV__ = besuEnv;
  (global as any).__FABRIC_LEDGER_ENV__ = fabricEnv; // Fabric related line
  (global as any).__ETHEREUM_LEDGER_ENV__ = ethereumEnv;
  (global as any).__SATP_GATEWAY__ = gateway;
  (global as any).__KNEX_LOCAL_CLIENT__ = knexLocalClient;
  (global as any).__KNEX_REMOTE_CLIENT__ = knexSourceRemoteClient;

  log.info(
    `All ledger and gateway configurations written to: ${TEMP_CONFIG_FILE}`,
  );
  log.info("Jest Global Setup: Completed successfully.");
};

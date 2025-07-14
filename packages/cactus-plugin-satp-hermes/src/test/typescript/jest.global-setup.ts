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
  SATPGatewayConfig,
  SATPGateway,
  PluginFactorySATPGateway,
} from "../../main/typescript"; // Adjust path to SATPGateway
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
 * It is responsible for starting ALL ledgers (Besu, Fabric) and the SATP Gateway,
 * then saving their connection details for individual tests.
 */
module.exports = async function globalSetup() {
  log.info(
    "Jest Global Setup: Starting ALL Ledgers (Besu, Fabric) and SATP Gateway...",
  );

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
  await besuEnv.deployAndSetupContracts(ClaimFormat.BUNGEE);
  log.info("Besu contract deployed and set up successfully.");

  // --- Start Fabric Test Environment ---
  const satpFabricChaincodeName = "satp-contract";
  const oracleFabricChaincodeName = "oracle-bl-contract";

  const fabricEnvOptions: IFabricTestEnvironmentOptions = {
    contractName: satpFabricChaincodeName,
    logLevel: LOG_LEVEL,
    network: `fabric_test_network_${uuidv4()}`,
    claimFormat: ClaimFormat.DEFAULT,
  };

  const fabricEnv =
    await FabricTestEnvironment.setupTestEnvironment(fabricEnvOptions);
  log.info("Fabric Ledger started successfully. Now deploying chaincodes...");

  await fabricEnv.deployAndSetupChaincode(
    satpFabricChaincodeName,
    "./../fabric/contracts/satp-contract/chaincode-typescript",
    "1.0.0",
  );
  log.info(
    `Fabric SATP chaincode '${satpFabricChaincodeName}' deployed and initialized.`,
  );

  await fabricEnv.deployAndSetupChaincode(
    oracleFabricChaincodeName,
    "./../fabric/contracts/oracle-bl-contract/chaincode-typescript",
    "1.0.0",
  );
  log.info(
    `Fabric Oracle chaincode '${oracleFabricChaincodeName}' deployed and initialized.`,
  );

  // --- Setup SATPGateway (Once Globally) ---
  const factoryOptions = {
    pluginImportType: "LOCAL" as any, // Cast to any to avoid strict type issues with PluginImportType
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
    address: "http://localhost" as Address,
  };

  const migrationSource = await createMigrationSource();
  const knexLocalClient = knex({
    ...knexLocalInstance.default,
    migrations: { migrationSource: migrationSource },
  });
  const knexSourceRemoteClient = knex({
    ...knexRemoteInstance.default,
    migrations: { migrationSource: migrationSource },
  });

  // Run migrations once for both local and remote DBs
  await knexLocalClient.migrate.latest();
  await knexSourceRemoteClient.migrate.latest();
  log.info("SATP Gateway databases migrated successfully.");

  const fabricNetworkOptions = fabricEnv.createFabricConfig();
  const besuNetworkOptions = besuEnv.createBesuConfig();

  const ontologiesPath = path.join(__dirname, "../ontologies"); // Assuming relative path from test-utils

  const gatewayOptions: SATPGatewayConfig = {
    instanceId: uuidv4(),
    logLevel: LOG_LEVEL,
    gid: gatewayIdentity,
    ccConfig: {
      bridgeConfig: [fabricNetworkOptions, besuNetworkOptions],
    },
    localRepository: knexLocalInstance.default, // Pass connection configs, not clients
    remoteRepository: knexRemoteInstance.default,
    pluginRegistry: new PluginRegistry({ plugins: [] }),
    ontologyPath: ontologiesPath,
  };
  const gateway = await factory.create(gatewayOptions);
  await gateway.startup();
  log.info("SATP Gateway started successfully.");

  // --- Save ALL Ledger and Gateway Configs to Temp File ---
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

  const allLedgerConfigs = {
    besu: besuConfig,
    fabric: fabricConfig,
    // Store Knex client configurations, not the clients themselves
    knexLocalConfig: knexLocalInstance.default,
    knexRemoteConfig: knexRemoteInstance.default,
    gatewayIdentity: gatewayIdentity, // The GatewayIdentity object
    // You might need to store gateway endpoint if accessed via client,
    // but if `gateway` object is passed directly, then not strictly necessary.
    // For now, storing a placeholder.
    gatewayApiHost: "http://localhost:3010", // Assuming default gateway server port
  };

  await fs.writeJson(TEMP_CONFIG_FILE, allLedgerConfigs);
  process.env.TEST_ENV_CONFIG_PATH = TEMP_CONFIG_FILE;

  // Store environments and gateway for teardown in global-teardown.ts
  (global as any).__BESU_LEDGER_ENV__ = besuEnv;
  (global as any).__FABRIC_LEDGER_ENV__ = fabricEnv;
  (global as any).__SATP_GATEWAY__ = gateway;
  (global as any).__KNEX_LOCAL_CLIENT__ = knexLocalClient;
  (global as any).__KNEX_REMOTE_CLIENT__ = knexSourceRemoteClient;

  log.info(
    `All ledger and gateway configurations written to: ${TEMP_CONFIG_FILE}`,
  );
};

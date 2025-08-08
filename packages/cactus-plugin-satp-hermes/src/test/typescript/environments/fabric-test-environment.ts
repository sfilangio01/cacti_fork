import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import {
  AssetTokenTypeEnum,
  Configuration,
} from "../../../main/typescript/generated/gateway-client/typescript-axios";
import {
  FABRIC_25_LTS_AIO_FABRIC_VERSION,
  FABRIC_25_LTS_AIO_IMAGE_VERSION,
  FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
  FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
  FabricTestLedgerV1,
  IFabricOrgEnvInfo,
} from "@hyperledger/cactus-test-tooling";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import {
  ConnectionProfile,
  DefaultEventHandlerStrategy,
  FabricSigningCredential,
  PluginLedgerConnectorFabric,
  FabricContractInvocationType,
  FileBase64,
  ChainCodeProgrammingLanguage,
  RunTransactionResponse,
  IPluginLedgerConnectorFabricOptions,
} from "@hyperledger/cactus-plugin-ledger-connector-fabric";
import { DiscoveryOptions, X509Identity } from "fabric-network";
import { Config } from "node-ssh";
import { randomUUID as uuidv4 } from "node:crypto";
import fs from "fs-extra";
import path from "path";
import * as assert from "assert";
import { ClaimFormat } from "../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import { Asset, NetworkId } from "../../../main/typescript";
import { LedgerType } from "@hyperledger/cactus-core-api";
import { IFabricLeafOptions } from "../../../main/typescript/cross-chain-mechanisms/bridge/leafs/fabric-leaf";
import ExampleOntology from "../../ontologies/ontology-satp-erc20-interact-fabric.json";
import { OntologyManager } from "../../../main/typescript/cross-chain-mechanisms/bridge/ontology/ontology-manager";
import { INetworkOptions } from "../../../main/typescript/cross-chain-mechanisms/bridge/bridge-types";
import Docker from "dockerode";

/**
 * Interface for serializable Fabric connection configuration.
 * This is used to pass ledger details between global setup and individual test files.
 */
export interface IFabricConnectionConfig {
  connectionProfileOrg1: ConnectionProfile;
  connectionProfileOrg2: ConnectionProfile;
  sshConfig: Config;
  userIdentityCert: string;
  userIdentityPrivateKey: string;
  userIdentityMspId: string;
  bridgeIdentityCert: string;
  bridgeIdentityPrivateKey: string;
  bridgeIdentityMspId: string;
  fabricChannelName: string;
  satpContractName: string;
  clientId: string;
  claimFormat: ClaimFormat;
  bridgeMSPID: string;
  logLevel: LogLevelDesc;
  networkId: NetworkId;
}

/**
 * Options for setting up a new Fabric test environment.
 */
export interface IFabricTestEnvironmentOptions {
  contractName: string;
  logLevel: LogLevelDesc;
  claimFormat?: ClaimFormat;
  network?: string;
}

/**
 * Manages a Hyperledger Fabric test environment, supporting both
 * initial setup (starting a new ledger) and reconnection to an existing one.
 */
export class FabricTestEnvironment {
  public static readonly FABRIC_ASSET_ID: string = "FabricExampleAsset";
  public static readonly FABRIC_REFERENCE_ID: string = ExampleOntology.id;
  public static readonly FABRIC_NETWORK_ID: string = "FabricLedgerTestNetwork";
  public readonly network: NetworkId = {
    id: FabricTestEnvironment.FABRIC_NETWORK_ID,
    ledgerType: LedgerType.Fabric2,
  };
  public ledger?: FabricTestLedgerV1;
  public connector!: PluginLedgerConnectorFabric;
  public userIdentity!: X509Identity;
  public bridgeProfile!: ConnectionProfile;
  public connectionProfile!: ConnectionProfile;
  public keychainPluginUser!: PluginKeychainMemory;
  public keychainPluginBridge!: PluginKeychainMemory;
  public fabricSigningCredential!: FabricSigningCredential;
  public bridgeFabricSigningCredential!: FabricSigningCredential;
  public pluginRegistryUser!: PluginRegistry;
  public pluginRegistryBridge!: PluginRegistry;
  public sshConfig!: Config;
  public discoveryOptions!: DiscoveryOptions;
  public configFabric!: Configuration; // This property appears unused
  public fabricChannelName!: string;
  public satpContractName!: string;
  public clientId!: string;
  public wrapperContractName?: string; // This property appears unused
  private dockerNetwork: string = "fabric";
  private dockerContainerIP?: string;
  private readonly log: Logger;
  private initialLogLevel: LogLevelDesc;
  private startedNetwork: boolean = false; // Flag to indicate if this instance started the ledger

  public bridgeMSPID?: string;
  public bridgeIdentity?: X509Identity;
  private claimFormat: number;

  /**
   * Private constructor to enforce static factory methods for setup and connection.
   * @param satpContractName The primary contract name for this environment.
   * @param logLevel The logging level.
   * @param network The Docker network name.
   * @param claimFormat The claim format.
   * @param existingConfig Optional configuration to connect to an existing ledger.
   */
  private constructor(
    satpContractName: string,
    logLevel: LogLevelDesc,
    network?: string,
    claimFormat?: ClaimFormat,
    existingConfig?: IFabricConnectionConfig,
  ) {
    if (network) {
      this.dockerNetwork = network;
    }
    this.satpContractName = satpContractName;
    this.claimFormat = claimFormat || ClaimFormat.DEFAULT;
    this.initialLogLevel = logLevel || "INFO";
    this.log = LoggerProvider.getOrCreate({
      level: this.initialLogLevel,
      label: "FabricTestEnvironment",
    });

    if (existingConfig) {
      this.log.debug(
        "FabricTestEnvironment: Reconnecting to existing environment.",
      );
      this.startedNetwork = false;

      this.network = existingConfig.networkId;
      this.connectionProfile = existingConfig.connectionProfileOrg1;
      this.bridgeProfile = existingConfig.connectionProfileOrg2;
      this.sshConfig = existingConfig.sshConfig;
      this.fabricChannelName = existingConfig.fabricChannelName;
      this.satpContractName = existingConfig.satpContractName;
      this.clientId = existingConfig.clientId;
      this.claimFormat = existingConfig.claimFormat;
      this.bridgeMSPID = existingConfig.bridgeIdentityMspId;

      // Reconstruct identities from serializable components
      this.userIdentity = {
        credentials: {
          certificate: existingConfig.userIdentityCert,
          privateKey: existingConfig.userIdentityPrivateKey,
        },
        mspId: existingConfig.userIdentityMspId,
        type: "X.509",
      };
      this.bridgeIdentity = {
        credentials: {
          certificate: existingConfig.bridgeIdentityCert,
          privateKey: existingConfig.bridgeIdentityPrivateKey,
        },
        mspId: existingConfig.bridgeIdentityMspId,
        type: "X.509",
      };

      // Recreate keychains with new UUIDs for isolation in current process
      const keychainUserInstanceId = uuidv4();
      const keychainUserId = uuidv4();
      const keychainUserEntryKey = "user1";
      this.keychainPluginUser = new PluginKeychainMemory({
        instanceId: keychainUserInstanceId,
        keychainId: keychainUserId,
        logLevel: this.initialLogLevel,
        backend: new Map([
          [keychainUserEntryKey, JSON.stringify(this.userIdentity)],
        ]),
      });
      this.pluginRegistryUser = new PluginRegistry({
        plugins: [this.keychainPluginUser],
      });

      const keychainBridgeInstanceId = uuidv4();
      const keychainBridgeId = uuidv4();
      const keychainBridgeEntryKey = "user2";
      this.keychainPluginBridge = new PluginKeychainMemory({
        instanceId: keychainBridgeInstanceId,
        keychainId: keychainBridgeId,
        logLevel: this.initialLogLevel,
        backend: new Map([
          [keychainBridgeEntryKey, JSON.stringify(this.bridgeIdentity)],
        ]),
      });
      this.pluginRegistryBridge = new PluginRegistry({
        plugins: [this.keychainPluginBridge],
      });

      this.discoveryOptions = { enabled: true, asLocalhost: true };

      const cliContainerEnvForConnector: IFabricOrgEnvInfo = {
        ...FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
      };
      cliContainerEnvForConnector.CORE_CHAINCODE_BUILDER =
        "hyperledger/fabric-nodeenv:2.5.4";

      const connectorOptions: IPluginLedgerConnectorFabricOptions = {
        instanceId: uuidv4(),
        dockerBinary: "/usr/local/bin/docker",
        peerBinary: "/fabric-samples/bin/peer",
        goBinary: "/usr.local.go/bin/go",
        pluginRegistry: this.pluginRegistryUser,
        cliContainerEnv: cliContainerEnvForConnector,
        sshConfig: this.sshConfig,
        logLevel: this.initialLogLevel,
        connectionProfile: this.connectionProfile,
        discoveryOptions: this.discoveryOptions,
        eventHandlerOptions: {
          strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
          commitTimeout: 300,
        },
      };
      this.connector = new PluginLedgerConnectorFabric(connectorOptions);

      // Set signing credentials to reference the newly created keychains
      this.fabricSigningCredential = {
        keychainId: keychainUserId,
        keychainRef: keychainUserEntryKey,
      };
      this.bridgeFabricSigningCredential = {
        keychainId: keychainBridgeId,
        keychainRef: keychainBridgeEntryKey,
      };
    } else {
      this.log.debug(
        "FabricTestEnvironment: Initializing for new ledger setup (global setup phase).",
      );
      this.startedNetwork = true;
      this.network = {
        id: FabricTestEnvironment.FABRIC_NETWORK_ID,
        ledgerType: LedgerType.Fabric2,
      };
      this.discoveryOptions = { enabled: true, asLocalhost: true };
    }
  }

  /**
   * Initializes the Fabric ledger, accounts, and connector for testing.
   * This method is only called when a new ledger is being set up.
   */
  public async init(): Promise<void> {
    if (!this.startedNetwork) {
      this.log.warn(
        "Fabric init() skipped, not the network starter for this instance.",
      );
      return;
    }

    this.log.debug("FabricTestEnvironment: Initializing new Fabric ledger.");
    this.ledger = new FabricTestLedgerV1({
      emitContainerLogs: true,
      publishAllPorts: true,
      imageName: "ghcr.io/hyperledger/cactus-fabric2-all-in-one",
      imageVersion: FABRIC_25_LTS_AIO_IMAGE_VERSION,
      envVars: new Map([["FABRIC_VERSION", FABRIC_25_LTS_AIO_FABRIC_VERSION]]),
      networkName: this.dockerNetwork,
    });

    const docker = new Docker();
    const container = await this.ledger.start();
    const containerData = await docker
      .getContainer((await container).id)
      .inspect();
    this.dockerContainerIP =
      containerData.NetworkSettings.Networks[
        this.dockerNetwork || "bridge"
      ].IPAddress;

    this.fabricChannelName = "mychannel";

    this.connectionProfile = await this.ledger.getConnectionProfileOrgX("org1");
    this.bridgeProfile = await this.ledger.getConnectionProfileOrgX("org2");
    assert.ok(
      this.connectionProfile,
      "Connection profile must not be undefined",
    );
    assert.ok(this.bridgeProfile, "Bridge profile must not be undefined");

    const enrollAdminOut = await this.ledger.enrollAdmin();
    const adminWallet = enrollAdminOut[1];
    const enrollAdminBridgeOut = await this.ledger.enrollAdminV2({
      organization: "org2",
    });
    const bridgeWallet = enrollAdminBridgeOut[1];

    [this.userIdentity] = await this.ledger.enrollUser(adminWallet);
    const opts = {
      enrollmentID: "bridge",
      organization: "org2",
      wallet: bridgeWallet,
    };
    [this.bridgeIdentity] = await this.ledger.enrollUserV2(opts);
    this.bridgeMSPID = this.bridgeIdentity!.mspId;
    this.sshConfig = await this.ledger.getSshConfig();

    this.log.debug("Enrolled admin and bridge identities.");

    const keychainUserInstanceId = uuidv4();
    const keychainUserId = uuidv4();
    const keychainUserEntryKey = "user1";
    const keychainUserEntryValue = JSON.stringify(this.userIdentity);

    this.keychainPluginUser = new PluginKeychainMemory({
      instanceId: keychainUserInstanceId,
      keychainId: keychainUserId,
      logLevel: this.initialLogLevel,
      backend: new Map([
        [keychainUserEntryKey, keychainUserEntryValue],
        ["some-other-entry-key", "some-other-entry-value"],
      ]),
    });
    this.pluginRegistryUser = new PluginRegistry({
      plugins: [this.keychainPluginUser],
    });

    const keychainBridgeInstanceId = uuidv4();
    const keychainBridgeId = uuidv4();
    const keychainBridgeEntryKey = "user2";
    const keychainBridgeEntryValue = JSON.stringify(this.bridgeIdentity);

    this.keychainPluginBridge = new PluginKeychainMemory({
      instanceId: keychainBridgeInstanceId,
      keychainId: keychainBridgeId,
      logLevel: this.initialLogLevel,
      backend: new Map([
        [keychainBridgeEntryKey, keychainBridgeEntryValue],
        ["some-other-entry-key", "some-other-entry-value"],
      ]),
    });
    this.pluginRegistryBridge = new PluginRegistry({
      plugins: [this.keychainPluginBridge],
    });

    const cliContainerEnvForConnector: IFabricOrgEnvInfo = {
      ...FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
    };
    cliContainerEnvForConnector.CORE_CHAINCODE_BUILDER =
      "hyperledger/fabric-nodeenv:2.5.4";

    const connectorOptions: IPluginLedgerConnectorFabricOptions = {
      instanceId: uuidv4(),
      dockerBinary: "/usr/local/bin/docker",
      peerBinary: "/fabric-samples/bin/peer",
      goBinary: "/usr.local.go/bin/go",
      pluginRegistry: this.pluginRegistryUser,
      cliContainerEnv: cliContainerEnvForConnector,
      sshConfig: this.sshConfig,
      logLevel: this.initialLogLevel,
      connectionProfile: this.connectionProfile,
      discoveryOptions: this.discoveryOptions,
      eventHandlerOptions: {
        strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
        commitTimeout: 300,
      },
    };
    this.connector = new PluginLedgerConnectorFabric(connectorOptions);

    this.fabricSigningCredential = {
      keychainId: keychainUserId,
      keychainRef: keychainUserEntryKey,
    };
    this.bridgeFabricSigningCredential = {
      keychainId: keychainBridgeId,
      keychainRef: keychainBridgeEntryKey,
    };
  }

  /**
   * Returns the name of the primary smart contract being tested.
   * @returns The contract name.
   */
  public getTestContractName(): string {
    return this.satpContractName;
  }

  /**
   * Returns the name of the Fabric channel.
   * @returns The channel name.
   */
  public getTestChannelName(): string {
    return this.fabricChannelName;
  }

  /**
   * Returns the signing credentials for the test owner.
   * @returns FabricSigningCredential for the test owner.
   */
  public getTestOwnerSigningCredential(): FabricSigningCredential {
    return this.fabricSigningCredential;
  }

  /**
   * Returns the client ID of the test owner.
   * @returns The client ID.
   */
  public getTestOwnerAccount(): string {
    return this.clientId;
  }

  /**
   * Returns the MSP ID of the bridge organization.
   * @returns The bridge MSP ID.
   * @throws Error if bridge MSP ID is undefined.
   */
  public getBridgeMSPID(): string {
    assert.ok(this.bridgeMSPID, "Bridge MSPID is undefined");
    return this.bridgeMSPID;
  }

  /**
   * Returns the network ID.
   * @returns The network ID.
   */
  public getNetworkId(): string {
    return this.network.id;
  }

  /**
   * Returns the ledger type.
   * @returns The ledger type.
   */
  public getNetworkType(): LedgerType {
    return this.network.ledgerType;
  }

  /**
   * Creates and initializes a new FabricTestEnvironment instance.
   * This method is intended for use in global setup to start a fresh ledger.
   * @param config Options for the test environment.
   * @returns A promise that resolves to the initialized FabricTestEnvironment instance.
   */
  public static async setupTestEnvironment(
    config: IFabricTestEnvironmentOptions,
  ): Promise<FabricTestEnvironment> {
    const { contractName, logLevel, claimFormat, network } = config;
    const instance = new FabricTestEnvironment(
      contractName,
      logLevel,
      network,
      claimFormat,
      undefined,
    );
    await instance.init();
    return instance;
  }

  /**
   * Connects to an existing FabricTestEnvironment instance.
   * This method is intended for use by individual test files to connect to a globally running ledger.
   * @param config The existing Fabric connection configuration.
   * @returns A promise that resolves to the connected FabricTestEnvironment instance.
   */
  public static async connectToExistingEnvironment(
    config: IFabricConnectionConfig,
  ): Promise<FabricTestEnvironment> {
    const instance = new FabricTestEnvironment(
      config.satpContractName,
      config.logLevel,
      undefined,
      config.claimFormat,
      config,
    );
    return instance;
  }

  /**
   * Creates Fabric network configuration for the gateway.
   * @returns Network options for the gateway.
   */
  public createFabricConfig(): INetworkOptions {
    const cliContainerEnvForConfig: IFabricOrgEnvInfo = {
      ...FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
    };
    cliContainerEnvForConfig.CORE_CHAINCODE_BUILDER =
      "hyperledger/fabric-nodeenv:2.5.4";

    return {
      networkIdentification: this.network,
      userIdentity: this.bridgeIdentity,
      channelName: this.fabricChannelName,
      targetOrganizations: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
      ],
      caFile:
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2.ORDERER_TLS_ROOTCERT_FILE,
      ccSequence: 1,
      orderer: "orderer.example.com:7050",
      ordererTLSHostnameOverride: "orderer.example.com",
      connTimeout: 60,
      mspId: this.getBridgeMSPID(),
      connectorOptions: {
        dockerBinary: "/usr/local/bin/docker",
        peerBinary: "/fabric-samples/bin/peer",
        goBinary: "/usr.local.go/bin/go",
        cliContainerEnv: cliContainerEnvForConfig,
        sshConfig: this.sshConfig,
        connectionProfile: this.bridgeProfile,
        discoveryOptions: {
          enabled: true,
          asLocalhost: true,
        },
        eventHandlerOptions: {
          strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
          commitTimeout: 300,
        },
      },
      claimFormats: [this.claimFormat],
    } as INetworkOptions;
  }

  /**
   * Creates Fabric Docker-specific network configuration.
   * @returns Network options for Docker.
   */
  public async createFabricDockerConfig(): Promise<INetworkOptions> {
    const sshConfig = this.ledger
      ? await this.ledger.getSshConfig(false)
      : this.sshConfig;
    const connectionProfile = this.ledger
      ? await this.ledger.getConnectionProfileOrgX("org2", false)
      : this.bridgeProfile;

    const cliContainerEnvForConfig: IFabricOrgEnvInfo = {
      ...FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
    };
    cliContainerEnvForConfig.CORE_CHAINCODE_BUILDER =
      "hyperledger/fabric-nodeenv:2.5.4";

    return {
      networkIdentification: this.network,
      userIdentity: this.bridgeIdentity,
      channelName: this.fabricChannelName,
      targetOrganizations: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
      ],
      caFile:
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2.ORDERER_TLS_ROOTCERT_FILE,
      ccSequence: 1,
      orderer: "orderer.example.com:7050",
      ordererTLSHostnameOverride: "orderer.example.com",
      connTimeout: 60,
      mspId: this.getBridgeMSPID(),
      connectorOptions: {
        dockerBinary: "/usr/local/bin/docker",
        peerBinary: "/fabric-samples/bin/peer",
        goBinary: "/usr.local.go/bin/go",
        cliContainerEnv: cliContainerEnvForConfig,
        sshConfig: sshConfig,
        connectionProfile: connectionProfile,
        discoveryOptions: {
          enabled: true,
          asLocalhost: false,
        },
        eventHandlerOptions: {
          strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
          commitTimeout: 300,
        },
      },
      claimFormats: [this.claimFormat],
    } as INetworkOptions;
  }

  /**
   * Creates Fabric leaf configuration for the bridge manager.
   * @param ontologyManager The ontology manager instance.
   * @param logLevel Optional logging level.
   * @returns Fabric leaf options.
   */
  public createFabricLeafConfig(
    ontologyManager: OntologyManager,
    logLevel?: LogLevelDesc,
  ): IFabricLeafOptions {
    const cliContainerEnvForConfig: IFabricOrgEnvInfo = {
      ...FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
    };
    cliContainerEnvForConfig.CORE_CHAINCODE_BUILDER =
      "hyperledger/fabric-nodeenv:2.5.4";

    return {
      networkIdentification: this.network,
      signingCredential: this.bridgeFabricSigningCredential,
      ontologyManager: ontologyManager,
      channelName: this.fabricChannelName,
      targetOrganizations: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
      ],
      caFile:
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2.ORDERER_TLS_ROOTCERT_FILE,
      ccSequence: 1,
      orderer: "orderer.example.com:7050",
      ordererTLSHostnameOverride: "orderer.example.com",
      connTimeout: 60,
      mspId: this.getBridgeMSPID(),
      connectorOptions: {
        instanceId: uuidv4(),
        dockerBinary: "/usr/local/bin/docker",
        peerBinary: "/fabric-samples/bin/peer",
        goBinary: "/usr.local.go/bin/go",
        pluginRegistry: this.pluginRegistryBridge,
        cliContainerEnv: cliContainerEnvForConfig,
        sshConfig: this.sshConfig,
        logLevel: logLevel,
        connectionProfile: this.bridgeProfile,
        discoveryOptions: {
          enabled: true,
          asLocalhost: true,
        },
        eventHandlerOptions: {
          strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
          commitTimeout: 300,
        },
      },
      claimFormats: [this.claimFormat],
      logLevel: logLevel,
    };
  }

  /**
   * Checks the balance of a given account on a specified contract.
   * @param contractName The name of the smart contract.
   * @param channelName The name of the channel.
   * @param account The account to check balance for.
   * @param amount The expected amount.
   * @param signingCredential The signing credentials for the transaction.
   */
  public async checkBalance(
    contractName: string,
    channelName: string,
    account: string,
    amount: string,
    signingCredential: FabricSigningCredential,
  ): Promise<void> {
    const responseBalance1 = await this.connector.transact({
      contractName: contractName,
      channelName: channelName,
      params: [account],
      methodName: "ClientIDAccountBalance",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: signingCredential,
    });

    assert.ok(responseBalance1, "Response balance must not be undefined");
    assert.strictEqual(
      responseBalance1.functionOutput,
      amount,
      `Balance mismatch: expected ${amount}, got ${responseBalance1.functionOutput}`,
    );
  }

  /**
   * Grants the bridge role to a specified MSP ID.
   * @param mspID The MSP ID of the bridge.
   */
  public async giveRoleToBridge(mspID: string): Promise<void> {
    const setBridgeResponse = await this.connector.transact({
      contractName: this.satpContractName,
      channelName: this.fabricChannelName,
      params: [mspID],
      methodName: "setBridge",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });

    assert.ok(setBridgeResponse, "Set bridge response must not be undefined");
    this.log.info(
      `SATPWrapper.setBridge(): ${JSON.stringify(setBridgeResponse)}`,
    );
  }

  /**
   * Approves an amount for a bridge address.
   * @param bridgeAddress The address of the bridge.
   * @param amount The amount to approve.
   */
  public async approveAmount(
    bridgeAddress: string,
    amount: string,
  ): Promise<void> {
    const response = await this.connector.transact({
      contractName: this.satpContractName,
      channelName: this.fabricChannelName,
      params: [bridgeAddress, amount],
      methodName: "Approve",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });

    assert.ok(response, "Approve response must not be undefined");
    this.log.info(`SATPWrapper.Approve(): ${JSON.stringify(response)}`);
  }

  public async deployAndSetupContracts() {
    this.satpContractName = "satp-contract" + uuidv4();
    const satpContractRelPath =
      "./../fabric/contracts/satp-contract/chaincode-typescript";
    const satpContractDir = path.join(__dirname, satpContractRelPath);

    // ├── package.json
    // ├── src
    // │   ├── index.ts
    // │   ├── ITraceableContract.ts
    // │   ├── satp-contract-interface.ts
    // │   ├── satp-contract.ts
    // ├── tsconfig.json
    // ├── lib
    // │   └── tokenERC20.js
    // --------
    const satpSourceFiles: FileBase64[] = [];
    {
      const filename = "./tsconfig.json";
      const relativePath = "./";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      satpSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./package.json";
      const relativePath = "./";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      satpSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./index.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      satpSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./ITraceableContract.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      satpSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./satp-contract-interface.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      satpSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./satp-contract.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      satpSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./tokenERC20.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      satpSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }

    const res = await this.connector.deployContract({
      channelId: this.fabricChannelName,
      ccVersion: "1.0.0",
      sourceFiles: satpSourceFiles,
      ccName: this.satpContractName,
      targetOrganizations: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
      ],
      caFile:
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1.ORDERER_TLS_ROOTCERT_FILE,
      ccLabel: "satp-contract",
      ccLang: ChainCodeProgrammingLanguage.Typescript,
      ccSequence: 1,
      orderer: "orderer.example.com:7050",
      ordererTLSHostnameOverride: "orderer.example.com",
      connTimeout: 60,
    });

    const { packageIds, lifecycle, success } = res;
    expect(success).toBe(true);
    expect(lifecycle).not.toBeUndefined();

    const {
      approveForMyOrgList,
      installList,
      queryInstalledList,
      commit,
      packaging,
      queryCommitted,
    } = lifecycle;

    expect(packageIds).toBeTruthy();
    expect(Array.isArray(packageIds)).toBe(true);

    expect(approveForMyOrgList).toBeTruthy();
    expect(Array.isArray(approveForMyOrgList)).toBe(true);

    expect(installList).toBeTruthy();
    expect(Array.isArray(installList)).toBe(true);
    expect(queryInstalledList).toBeTruthy();
    expect(Array.isArray(queryInstalledList)).toBe(true);

    expect(commit).toBeTruthy();
    expect(packaging).toBeTruthy();
    expect(queryCommitted).toBeTruthy();
    this.log.info("SATP Contract deployed");

    const initializeResponse = await this.connector.transact({
      contractName: this.satpContractName,
      channelName: this.fabricChannelName,
      params: [this.userIdentity.mspId, FabricTestEnvironment.FABRIC_ASSET_ID],
      methodName: "InitToken",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });

    expect(initializeResponse).not.toBeUndefined();

    this.log.info(
      `SATPContract.InitToken(): ${JSON.stringify(initializeResponse)}`,
    );

    if (this.bridgeMSPID === undefined) {
      throw new Error("Bridge MSPID is undefined");
    }

    const responseClientId = await this.connector.transact({
      contractName: this.satpContractName,
      channelName: this.fabricChannelName,
      params: [],
      methodName: "ClientAccountID",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });

    this.clientId = responseClientId.functionOutput.toString();
  }

  public async deployAndSetupOracleContracts() {
    this.satpContractName = "oracle-bl-contract" + uuidv4();
    const satpContractRelPath =
      "./../fabric/contracts/oracle-bl-contract/chaincode-typescript";
    const satpContractDir = path.join(__dirname, satpContractRelPath);

    // ├── package.json
    // ├── src
    // │   ├── index.ts
    // │   ├── ITraceableContract.ts
    // │   ├── satp-contract-interface.ts
    // │   ├── satp-contract.ts
    // ├── tsconfig.json
    // ├── lib
    // │   └── tokenERC20.js
    // --------
    const oracleSourceFiles: FileBase64[] = [];
    {
      const filename = "./tsconfig.json";
      const relativePath = "./";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      oracleSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./package.json";
      const relativePath = "./";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      oracleSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./index.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      oracleSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./data.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      oracleSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }
    {
      const filename = "./oracleBusinessLogic.ts";
      const relativePath = "./src/";
      const filePath = path.join(satpContractDir, relativePath, filename);
      const buffer = await fs.readFile(filePath);
      oracleSourceFiles.push({
        body: buffer.toString("base64"),
        filepath: relativePath,
        filename,
      });
    }

    const res = await this.connector.deployContract({
      channelId: this.fabricChannelName,
      ccVersion: "1.0.0",
      sourceFiles: oracleSourceFiles,
      ccName: this.satpContractName,
      targetOrganizations: [
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_2,
      ],
      caFile:
        FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1.ORDERER_TLS_ROOTCERT_FILE,
      ccLabel: "oracle-bl-contract",
      ccLang: ChainCodeProgrammingLanguage.Typescript,
      ccSequence: 1,
      orderer: "orderer.example.com:7050",
      ordererTLSHostnameOverride: "orderer.example.com",
      connTimeout: 60,
    });

    const { packageIds, lifecycle, success } = res;
    expect(success).toBe(true);
    expect(lifecycle).not.toBeUndefined();

    const {
      approveForMyOrgList,
      installList,
      queryInstalledList,
      commit,
      packaging,
      queryCommitted,
    } = lifecycle;

    expect(packageIds).toBeTruthy();
    expect(Array.isArray(packageIds)).toBe(true);

    expect(approveForMyOrgList).toBeTruthy();
    expect(Array.isArray(approveForMyOrgList)).toBe(true);

    expect(installList).toBeTruthy();
    expect(Array.isArray(installList)).toBe(true);
    expect(queryInstalledList).toBeTruthy();
    expect(Array.isArray(queryInstalledList)).toBe(true);

    expect(commit).toBeTruthy();
    expect(packaging).toBeTruthy();
    expect(queryCommitted).toBeTruthy();
    this.log.info("Oracle Business Logic Contract deployed");

    const initializeResponse = await this.connector.transact({
      contractName: "oracle-bl-contract",
      channelName: this.fabricChannelName,
      params: [],
      methodName: "InitLedger",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });

    expect(initializeResponse).not.toBeUndefined();

    this.log.info(
      `OracleBLContract.InitLedger(): ${JSON.stringify(initializeResponse)}`,
    );

    if (this.bridgeMSPID === undefined) {
      throw new Error("Bridge MSPID is undefined");
    }
  }

  /**
   * Executes a write transaction on a Fabric smart contract.
   * @param contractName The name of the smart contract.
   * @param methodName The name of the method to invoke.
   * @param params Parameters for the method.
   * @param signingCredential Optional signing credentials (defaults to test owner).
   * @returns The transaction response.
   */
  public async writeData(
    contractName: string,
    methodName: string,
    params: string[],
    signingCredential?: FabricSigningCredential,
  ): Promise<RunTransactionResponse> {
    const cred = signingCredential || this.fabricSigningCredential;
    const response = await this.connector.transact({
      contractName: contractName,
      channelName: this.fabricChannelName,
      params: params,
      methodName: methodName,
      invocationType: FabricContractInvocationType.Send,
      signingCredential: cred,
    });
    assert.ok(response, "Write data response must not be undefined");
    return response;
  }

  /**
   * Executes a read query on a Fabric smart contract.
   * @param contractName The name of the smart contract.
   * @param methodName The name of the method to query.
   * @param params Parameters for the method.
   * @param signingCredential Optional signing credentials (defaults to test owner).
   * @returns The query response.
   */
  public async readData(
    contractName: string,
    methodName: string,
    params: string[],
    signingCredential?: FabricSigningCredential,
  ): Promise<RunTransactionResponse> {
    const cred = signingCredential || this.fabricSigningCredential;
    const response = await this.connector.transact({
      contractName: contractName,
      channelName: this.fabricChannelName,
      params: params,
      methodName: methodName,
      invocationType: FabricContractInvocationType.Call,
      signingCredential: cred,
    });
    assert.ok(response, "Read data response must not be undefined");
    return response;
  }

  /**
   * Mints tokens using the primary SATP contract.
   * @param amount The amount of tokens to mint.
   */
  public async mintTokens(amount: string): Promise<void> {
    const responseMint = await this.connector.transact({
      contractName: this.satpContractName,
      channelName: this.fabricChannelName,
      params: [amount],
      methodName: "Mint",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });
    assert.ok(responseMint, "Mint response must not be undefined");
    this.log.info(
      `Mint amount asset by the owner response: ${JSON.stringify(responseMint)}`,
    );
  }

  /**
   * Returns the Docker network name.
   * @returns The Docker network name.
   */
  public getNetwork(): string {
    return this.dockerNetwork;
  }

  /**
   * Gets the default asset configuration for testing.
   * @returns The default asset.
   */
  public get defaultAsset(): Asset {
    return {
      id: FabricTestEnvironment.FABRIC_ASSET_ID,
      referenceId: FabricTestEnvironment.FABRIC_REFERENCE_ID,
      owner: this.clientId,
      contractName: this.satpContractName,
      mspId: this.userIdentity.mspId,
      channelName: this.fabricChannelName,
      networkId: this.network,
      tokenType: AssetTokenTypeEnum.NonstandardFungible,
    };
  }

  /**
   * Returns the user identity certificate used for testing transactions.
   * @returns The user identity certificate.
   */
  get transactRequestPubKey(): string {
    return this.userIdentity.credentials.certificate;
  }

  /**
   * Stops and destroys the test ledger.
   * This method is only called if this instance initiated the ledger.
   */
  public async tearDown(): Promise<void> {
    if (this.startedNetwork && this.ledger) {
      await this.ledger.stop();
      await this.ledger.destroy();
      this.log.info("Fabric ledger stopped and destroyed successfully.");
    } else {
      this.log.warn(
        "Fabric ledger instance not found or not the network starter. Skipping tearDown.",
      );
    }
  }
}

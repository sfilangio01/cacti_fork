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
  IFabricOrgEnvInfo, // Import IFabricOrgEnvInfo
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
  IPluginLedgerConnectorFabricOptions, // Used for connector options type
} from "@hyperledger/cactus-plugin-ledger-connector-fabric";
import { DiscoveryOptions, X509Identity } from "fabric-network";
import { Config } from "node-ssh";
import { randomUUID as uuidv4 } from "node:crypto";
import fs from "fs-extra";
import path from "path";
import * as assert from "assert"; // Changed from Expect to assert
import { ClaimFormat } from "../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import { Asset, NetworkId } from "../../../main/typescript";
import { LedgerType } from "@hyperledger/cactus-core-api";
import { IFabricLeafOptions } from "../../../main/typescript/cross-chain-mechanisms/bridge/leafs/fabric-leaf";
import ExampleOntology from "../../ontologies/ontology-satp-erc20-interact-fabric.json";
import { OntologyManager } from "../../../main/typescript/cross-chain-mechanisms/bridge/ontology/ontology-manager";
import { INetworkOptions } from "../../../main/typescript/cross-chain-mechanisms/bridge/bridge-types";
import Docker from "dockerode";
// Test environment for Fabric ledger operations

export interface IFabricTestEnvironment {
  contractName: string;
  logLevel: LogLevelDesc;
  claimFormat?: ClaimFormat;
  network?: string;
}
export interface IFabricConnectionConfig {
  connectionProfileOrg1: ConnectionProfile;
  connectionProfileOrg2: ConnectionProfile;
  sshConfig: Config;
  userIdentity: X509Identity;
  bridgeIdentity: X509Identity;
  fabricChannelName: string;
  satpContractName: string;
  clientId: string;
  keychainEntryKeyBridge: string;
  keychainEntryValueBridge: string;
  fabricSigningCredential: FabricSigningCredential;
  bridgeFabricSigningCredential: FabricSigningCredential;
  claimFormat: ClaimFormat;
  bridgeMSPID: string;
  logLevel: LogLevelDesc;
  networkId: NetworkId;
}

export class FabricTestEnvironment {
  public static readonly FABRIC_ASSET_ID: string = "FabricExampleAsset";
  public static readonly FABRIC_REFERENCE_ID: string = ExampleOntology.id;
  public static readonly FABRIC_NETWORK_ID: string = "FabricLedgerTestNetwork";
  public readonly network: NetworkId = {
    // Reverted to original initialization
    id: FabricTestEnvironment.FABRIC_NETWORK_ID,
    ledgerType: LedgerType.Fabric2,
  };
  public ledger!: FabricTestLedgerV1;
  public connector!: PluginLedgerConnectorFabric;
  public userIdentity!: X509Identity;
  public bridgeProfile!: ConnectionProfile;
  public connectionProfile!: ConnectionProfile;
  public keychainPluginBridge!: PluginKeychainMemory;
  public keychainEntryKeyBridge!: string;
  public keychainEntryValueBridge!: string;
  public fabricSigningCredential!: FabricSigningCredential;
  public bridgeFabricSigningCredential!: FabricSigningCredential;
  public pluginRegistryBridge!: PluginRegistry; // Kept separate as per original logic
  public sshConfig!: Config;
  public discoveryOptions!: DiscoveryOptions;
  public configFabric!: Configuration;
  public fabricChannelName!: string;
  public satpContractName!: string;
  public clientId!: string;
  public wrapperContractName?: string;
  private channelName: string = "mychannel";

  private dockerContainerIP?: string;
  private dockerNetwork: string = "fabric";

  private readonly log: Logger;
  private initialLogLevel: LogLevelDesc; // Stored for consistent logging level

  private bridgeMSPID?: string;
  public bridgeIdentity?: X509Identity;
  private claimFormat: number;

  private constructor(
    satpContractName: string,
    logLevel: LogLevelDesc,
    network?: string,
    claimFormat?: ClaimFormat,
    existingConfig?: IFabricConnectionConfig, // Added for reconnection logic
  ) {
    if (network) {
      this.dockerNetwork = network;
    }
    this.satpContractName = satpContractName;

    this.claimFormat = claimFormat || ClaimFormat.DEFAULT;

    this.initialLogLevel = logLevel || "INFO"; // Store log level
    const level = logLevel || "INFO";
    const label = "FabricTestEnvironment";
    this.log = LoggerProvider.getOrCreate({ level, label });

    // Handle reconnection vs. new setup
    if (existingConfig) {
      this.log.debug(
        "FabricTestEnvironment: Reconnecting to existing environment.",
      );
      this.network = existingConfig.networkId;
      this.connectionProfile = existingConfig.connectionProfileOrg1;
      this.bridgeProfile = existingConfig.connectionProfileOrg2;
      this.sshConfig = existingConfig.sshConfig;
      this.userIdentity = existingConfig.userIdentity;
      this.bridgeIdentity = existingConfig.bridgeIdentity;
      this.fabricChannelName = existingConfig.fabricChannelName;
      this.satpContractName = existingConfig.satpContractName;
      this.clientId = existingConfig.clientId;
      this.keychainEntryKeyBridge = existingConfig.keychainEntryKeyBridge;
      this.keychainEntryValueBridge = existingConfig.keychainEntryValueBridge;
      this.bridgeMSPID = existingConfig.bridgeMSPID;
      this.claimFormat = existingConfig.claimFormat;
      this.channelName = existingConfig.fabricChannelName;

      // Recreate keychains using the stored keychainIds
      const keychainPluginForConnector = new PluginKeychainMemory({
        instanceId: existingConfig.fabricSigningCredential.keychainId, // Use original UUID
        keychainId: existingConfig.fabricSigningCredential.keychainId, // Use original UUID
        logLevel: this.initialLogLevel,
        backend: new Map([
          [
            existingConfig.fabricSigningCredential.keychainRef,
            JSON.stringify(existingConfig.userIdentity), // Use existing config's user identity
          ],
        ]),
      });

      this.keychainPluginBridge = new PluginKeychainMemory({
        instanceId: existingConfig.bridgeFabricSigningCredential.keychainId, // Use original UUID
        keychainId: existingConfig.bridgeFabricSigningCredential.keychainId, // Use original UUID
        logLevel: this.initialLogLevel,
        backend: new Map([
          [
            existingConfig.keychainEntryKeyBridge,
            existingConfig.keychainEntryValueBridge,
          ],
        ]),
      });

      // Original behavior: main connector uses its own registry
      const pluginRegistryMain = new PluginRegistry({
        plugins: [keychainPluginForConnector],
      });

      // Original behavior: bridge leaf uses its own separate registry
      this.pluginRegistryBridge = new PluginRegistry({
        plugins: [this.keychainPluginBridge],
      });

      this.discoveryOptions = {
        enabled: true,
        asLocalhost: true,
      };

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
        pluginRegistry: pluginRegistryMain, // Use the main plugin registry
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

      this.fabricSigningCredential = existingConfig.fabricSigningCredential; // Use stored credentials directly
      this.bridgeFabricSigningCredential =
        existingConfig.bridgeFabricSigningCredential; // Use stored credentials directly
    } else {
      // Original logic for new setup, remains mostly the same
      this.log.debug(
        "FabricTestEnvironment: Initializing for new ledger setup (global setup phase).",
      );
      this.network = {
        // Ensure network is initialized for new setups
        id: FabricTestEnvironment.FABRIC_NETWORK_ID,
        ledgerType: LedgerType.Fabric2,
      };
      // Set discoveryOptions for new setup
      this.discoveryOptions = {
        enabled: true,
        asLocalhost: true,
      };
    }
  }

  // Initializes the Fabric ledger, accounts, and connector for testing
  public async init(logLevel: LogLevelDesc): Promise<void> {
    // Only proceed if ledger is not already initialized (only for new setups)
    if (!this.ledger) {
      this.log.debug("FabricTestEnvironment: Initializing new Fabric ledger.");
      this.ledger = new FabricTestLedgerV1({
        emitContainerLogs: true,
        publishAllPorts: true,
        imageName: "ghcr.io/hyperledger/cactus-fabric2-all-in-one",
        imageVersion: FABRIC_25_LTS_AIO_IMAGE_VERSION,
        envVars: new Map([
          ["FABRIC_VERSION", FABRIC_25_LTS_AIO_FABRIC_VERSION],
        ]),
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

      this.connectionProfile =
        await this.ledger.getConnectionProfileOrgX("org1");
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

      this.log.debug("enrolled admin");

      const keychainInstanceId = uuidv4();
      const keychainId = uuidv4(); // Unique ID for the user keychain
      const keychainEntryKey = "user1";
      const keychainEntryValue = JSON.stringify(this.userIdentity);

      const keychainPlugin = new PluginKeychainMemory({
        instanceId: keychainInstanceId,
        keychainId,
        logLevel,
        backend: new Map([
          [keychainEntryKey, keychainEntryValue],
          ["some-other-entry-key", "some-other-entry-value"],
        ]),
      });

      const pluginRegistryForConnector = new PluginRegistry({
        plugins: [keychainPlugin],
      }); // Main connector's registry

      const keychainInstanceIdBridge = uuidv4();
      const keychainIdBridge = uuidv4(); // Unique ID for the bridge keychain
      this.keychainEntryKeyBridge = "user2"; // Original key name
      this.keychainEntryValueBridge = JSON.stringify(this.bridgeIdentity);

      this.keychainPluginBridge = new PluginKeychainMemory({
        instanceId: keychainInstanceIdBridge,
        keychainId: keychainIdBridge,
        logLevel,
        backend: new Map([
          [this.keychainEntryKeyBridge, this.keychainEntryValueBridge],
          ["some-other-entry-key", "some-other-entry-value"],
        ]),
      });

      this.pluginRegistryBridge = new PluginRegistry({
        // Separate registry for the bridge
        plugins: [this.keychainPluginBridge],
      });

      this.discoveryOptions = {
        enabled: true,
        asLocalhost: true,
      };

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
        pluginRegistry: pluginRegistryForConnector, // This connector uses the main user's registry
        cliContainerEnv: cliContainerEnvForConnector,
        sshConfig: this.sshConfig,
        logLevel,
        connectionProfile: this.connectionProfile,
        discoveryOptions: this.discoveryOptions,
        eventHandlerOptions: {
          strategy: DefaultEventHandlerStrategy.NetworkScopeAllfortx,
          commitTimeout: 300,
        },
      };

      this.connector = new PluginLedgerConnectorFabric(connectorOptions);

      this.fabricSigningCredential = {
        keychainId, // Use the generated UUID
        keychainRef: keychainEntryKey,
      };
      this.bridgeFabricSigningCredential = {
        keychainId: keychainIdBridge, // Use the generated UUID
        keychainRef: this.keychainEntryKeyBridge,
      };
    } else {
      this.log.debug(
        "FabricTestEnvironment: init() skipped, already connected.",
      );
    }
  }

  public getTestContractName(): string {
    return this.satpContractName;
  }

  public getTestChannelName(): string {
    return this.fabricChannelName;
  }

  public getTestOwnerSigningCredential(): FabricSigningCredential {
    return this.fabricSigningCredential;
  }

  public getTestOwnerAccount(): string {
    return this.clientId;
  }

  public getBridgeMSPID(): string {
    if (this.bridgeMSPID === undefined) {
      throw new Error("Bridge MSPID is undefined");
    }
    return this.bridgeMSPID;
  }

  public getNetworkId(): string {
    return this.network.id;
  }

  public getNetworkType(): LedgerType {
    return this.network.ledgerType;
  }

  // Creates and initializes a new FabricTestEnvironment instance
  public static async setupTestEnvironment(
    config: IFabricTestEnvironment,
  ): Promise<FabricTestEnvironment> {
    const { contractName, logLevel, claimFormat, network } = config;
    const instance = new FabricTestEnvironment(
      contractName,
      logLevel,
      network,
      claimFormat,
    );
    await instance.init(logLevel);
    return instance;
  }

  // Connects to an existing FabricTestEnvironment instance
  public static async connectToExistingEnvironment(
    config: IFabricConnectionConfig,
  ): Promise<FabricTestEnvironment> {
    const instance = new FabricTestEnvironment(
      config.satpContractName,
      config.logLevel,
      undefined, // No network name needed for connecting
      config.claimFormat,
      config, // Pass the full connection config
    );
    // The constructor's `if (existingConfig)` block handles re-initialization.
    return instance;
  }

  // this is the config to be loaded by the gateway, does not contain the log level because it will use the one in the gateway config
  public createFabricConfig(): INetworkOptions {
    // Recreate the specific `cliContainerEnv` for this config as per original
    const cliContainerEnvForConfig: IFabricOrgEnvInfo = {
      ...FABRIC_25_LTS_FABRIC_SAMPLES_ENV_INFO_ORG_1,
    };
    cliContainerEnvForConfig.CORE_CHAINCODE_BUILDER =
      "hyperledger/fabric-nodeenv:2.5.4";

    return {
      networkIdentification: this.network,
      userIdentity: this.bridgeIdentity,
      channelName: this.channelName,
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
      mspId: this.bridgeMSPID,
      connectorOptions: {
        dockerBinary: "/usr/local/bin/docker",
        peerBinary: "/fabric-samples/bin/peer",
        goBinary: "/usr.local.go/bin/go",
        cliContainerEnv: cliContainerEnvForConfig, // Use the locally modified copy
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

  // this is the config to be loaded by the gateway, does not contain the log level because it will use the one in the gateway config
  public async createFabricDockerConfig(): Promise<INetworkOptions> {
    // Use the stored sshConfig and bridgeProfile if not starting a new ledger
    const sshConfig = this.ledger
      ? await this.ledger.getSshConfig(false)
      : this.sshConfig;
    const connectionProfile = this.ledger
      ? await this.ledger.getConnectionProfileOrgX("org2", false)
      : this.bridgeProfile;

    // Recreate the specific `cliContainerEnv` for this config as per original
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
      mspId: this.bridgeMSPID,
      connectorOptions: {
        dockerBinary: "/usr/local/bin/docker",
        peerBinary: "/fabric-samples/bin/peer",
        goBinary: "/usr.local.go/bin/go",
        cliContainerEnv: cliContainerEnvForConfig, // Use the locally modified copy
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
  // this creates the same config as the bridge manager does
  public createFabricLeafConfig(
    ontologyManager: OntologyManager,
    logLevel?: LogLevelDesc,
  ): IFabricLeafOptions {
    // Recreate the specific `cliContainerEnv` for this config as per original
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
      mspId: this.bridgeMSPID,
      connectorOptions: {
        instanceId: uuidv4(),
        dockerBinary: "/usr/local/bin/docker",
        peerBinary: "/fabric-samples/bin/peer",
        goBinary: "/usr.local.go/bin/go",
        pluginRegistry: this.pluginRegistryBridge, // Crucial: This uses the SEPARATE bridge registry
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

    assert.ok(responseBalance1, "Response balance must not be undefined"); // Changed from expect().not.toBeUndefined()
    assert.strictEqual(
      // Changed from expect().toBe()
      responseBalance1.functionOutput,
      amount,
      `Balance mismatch: expected ${amount}, got ${responseBalance1.functionOutput}`,
    );
  }

  public async giveRoleToBridge(mspID: string): Promise<void> {
    const setBridgeResponse = await this.connector.transact({
      contractName: this.satpContractName,
      channelName: this.fabricChannelName,
      params: [mspID],
      methodName: "setBridge",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential, // Original: Uses main user's credential
    });

    assert.ok(setBridgeResponse, "Set bridge response must not be undefined"); // Changed from expect().not.toBeUndefined()

    this.log.info(
      `SATPWrapper.setBridge(): ${JSON.stringify(setBridgeResponse)}`,
    );
  }

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

    assert.ok(response, "Approve response must not be undefined"); // Changed from expect().not.toBeUndefined()

    this.log.info(`SATPWrapper.Approve(): ${JSON.stringify(response)}`);
  }

  // Deploys smart contracts and sets up configurations for testing
  public async deployAndSetupContracts() {
    this.satpContractName = "satp-contract";
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
    assert.ok(success, "Deployment success expected to be true"); // Changed from expect().toBe(true)
    assert.ok(lifecycle, "Lifecycle must not be undefined"); // Changed from expect().not.toBeUndefined()

    const {
      approveForMyOrgList,
      installList,
      queryInstalledList,
      commit,
      packaging,
      queryCommitted,
    } = lifecycle;

    assert.ok(packageIds, "Package IDs must be truthy"); // Changed from expect().toBeTruthy()
    assert.ok(Array.isArray(packageIds), "Package IDs must be an array"); // Changed from expect().toBe(true)

    assert.ok(approveForMyOrgList, "Approve for my Org List must be truthy");
    assert.ok(
      Array.isArray(approveForMyOrgList),
      "Approve for my Org List must be an array",
    );

    assert.ok(installList, "Install list must be truthy");
    assert.ok(Array.isArray(installList), "Install list must be an array");
    assert.ok(queryInstalledList, "Query installed list must be truthy");
    assert.ok(
      Array.isArray(queryInstalledList),
      "Query installed list must be an array",
    );

    assert.ok(commit, "Commit must be truthy");
    assert.ok(packaging, "Packaging must be truthy");
    assert.ok(queryCommitted, "Query committed must be truthy");
    this.log.info("SATP Contract deployed");

    const initializeResponse = await this.connector.transact({
      contractName: this.satpContractName,
      channelName: this.fabricChannelName,
      params: [this.userIdentity.mspId, FabricTestEnvironment.FABRIC_ASSET_ID],
      methodName: "InitToken",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });

    assert.ok(initializeResponse, "Initialize response must not be undefined"); // Changed from expect().not.toBeUndefined()

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
    this.satpContractName = "oracle-bl-contract";
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
    assert.ok(success, "Deployment success expected to be true");
    assert.ok(lifecycle, "Lifecycle must not be undefined");

    const {
      approveForMyOrgList,
      installList,
      queryInstalledList,
      commit,
      packaging,
      queryCommitted,
    } = lifecycle;

    assert.ok(packageIds, "Package IDs must be truthy");
    assert.ok(Array.isArray(packageIds), "Package IDs must be an array");

    assert.ok(approveForMyOrgList, "Approve for my Org List must be truthy");
    assert.ok(
      Array.isArray(approveForMyOrgList),
      "Approve for my Org List must be an array",
    );

    assert.ok(installList, "Install list must be truthy");
    assert.ok(Array.isArray(installList), "Install list must be an array");
    assert.ok(queryInstalledList, "Query installed list must be truthy");
    assert.ok(
      Array.isArray(queryInstalledList),
      "Query installed list must be an array",
    );

    assert.ok(commit, "Commit must be truthy");
    assert.ok(packaging, "Packaging must be truthy");
    assert.ok(queryCommitted, "Query committed must be truthy");
    this.log.info("Oracle Business Logic Contract deployed");

    const initializeResponse = await this.connector.transact({
      contractName: "oracle-bl-contract",
      channelName: this.fabricChannelName,
      params: [],
      methodName: "InitLedger",
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });

    assert.ok(initializeResponse, "Initialize response must not be undefined");

    this.log.info(
      `OracleBLContract.InitLedger(): ${JSON.stringify(initializeResponse)}`,
    );

    if (this.bridgeMSPID === undefined) {
      throw new Error("Bridge MSPID is undefined");
    }
  }

  public async writeData(
    contractName: string,
    methodName: string,
    params: string[],
  ): Promise<RunTransactionResponse> {
    const readData = await this.connector.transact({
      contractName: contractName,
      channelName: this.fabricChannelName,
      params: params,
      methodName: methodName,
      invocationType: FabricContractInvocationType.Send,
      signingCredential: this.fabricSigningCredential,
    });
    assert.ok(readData, "Read data response must not be undefined");

    return readData;
  }

  public async readData(
    contractName: string,
    methodName: string,
    params: string[],
  ): Promise<RunTransactionResponse> {
    const readData = await this.connector.transact({
      contractName: contractName,
      channelName: this.fabricChannelName,
      params: params,
      methodName: methodName,
      invocationType: FabricContractInvocationType.Call,
      signingCredential: this.fabricSigningCredential,
    });
    assert.ok(readData, "Read data response must not be undefined");

    return readData;
  }

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
      `Mint 100 amount asset by the owner response: ${JSON.stringify(responseMint)}`,
    );
  }

  public getNetwork(): string {
    return this.dockerNetwork;
  }

  // Gets the default asset configuration for testing
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

  // Returns the user identity certificate used for testing transactions
  get transactRequestPubKey(): string {
    return this.userIdentity.credentials.certificate;
  }

  // Stops and destroys the test ledger
  public async tearDown(): Promise<void> {
    if (this.ledger) {
      // Only tear down if this instance started the ledger
      await this.ledger.stop();
      await this.ledger.destroy();
    } else {
      this.log.warn(
        "Fabric ledger instance not found. Skipping tearDown (likely connected to existing).",
      );
    }
  }
}

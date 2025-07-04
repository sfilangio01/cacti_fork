import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import { BesuTestLedger } from "@hyperledger/cactus-test-tooling";
import {
  EthContractInvocationType as BesuContractInvocationType,
  InvokeContractV1Response,
  IPluginLedgerConnectorBesuOptions,
  PluginLedgerConnectorBesu,
  ReceiptType,
  Web3SigningCredential,
  Web3SigningCredentialType as Web3SigningCredentialTypeBesu,
} from "@hyperledger/cactus-plugin-ledger-connector-besu";
import SATPTokenContract from "../../solidity/generated/SATPTokenContract.sol/SATPTokenContract.json";
import Web3 from "web3";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { randomUUID as uuidv4 } from "node:crypto";
import * as assert from "assert";
import { ClaimFormat } from "../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import { Asset, AssetTokenTypeEnum, NetworkId } from "../../../main/typescript";
import { LedgerType } from "@hyperledger/cactus-core-api";
import {
  IBesuLeafNeworkOptions,
  IBesuLeafOptions,
} from "../../../main/typescript/cross-chain-mechanisms/bridge/leafs/besu-leaf";
import { OntologyManager } from "../../../main/typescript/cross-chain-mechanisms/bridge/ontology/ontology-manager";
import ExampleOntology from "../../ontologies/ontology-satp-erc20-interact-besu.json";
import { INetworkOptions } from "../../../main/typescript/cross-chain-mechanisms/bridge/bridge-types";
import Docker from "dockerode";
// Test environment for Besu ledger operations

export interface IBesuConnectionConfig {
  rpcApiHttpHost: string;
  rpcApiWsHost: string;
  firstHighNetWorthAccount: string;
  bridgeEthAccount: { address: string; privateKey: string };
  assigneeEthAccount: { address: string; privateKey: string };
  besuKeyPair: { privateKey: string };
  keychainEntryKey: string;
  keychainEntryValue: string;
  erc20TokenContract: string;
  assetContractAddress?: string;
  networkId: NetworkId;
  logLevel: LogLevelDesc;
}

export interface IBesuTestEnvironment {
  contractName: string;
  logLevel: LogLevelDesc;
  network?: string;
}

export class BesuTestEnvironment {
  public static readonly BESU_ASSET_ID: string = "BesuExampleAsset";
  public static readonly BESU_REFERENCE_ID: string = ExampleOntology.id;
  public static readonly BESU_NETWORK_ID: string = "BesuLedgerTestNetwork";
  public readonly network: NetworkId = {
    id: BesuTestEnvironment.BESU_NETWORK_ID,
    ledgerType: LedgerType.Besu2X,
  };
  public ledger!: BesuTestLedger;
  public connector!: PluginLedgerConnectorBesu;
  public connectorOptions!: IPluginLedgerConnectorBesuOptions;
  public keychainPlugin1!: PluginKeychainMemory;
  public keychainPlugin2!: PluginKeychainMemory;
  public besuKeyPair!: { privateKey: string };
  public keychainEntryKey!: string;
  public keychainEntryValue!: string;
  public web3!: Web3;
  public firstHighNetWorthAccount!: string;
  public bridgeEthAccount!: { address: string; privateKey: string };
  public assigneeEthAccount?: { address: string; privateKey: string };
  public erc20TokenContract!: string;
  public assetContractAddress?: string;
  public besuConfig!: IBesuLeafNeworkOptions;
  public gas: number = 999999999; // Default gas limit for transactions

  private dockerContainerIP?: string;
  private dockerNetwork: string = "besu";

  private readonly log: Logger;

  private constructor(
    erc20TokenContract: string,
    logLevel: LogLevelDesc,
    network?: string,
    existingConfig?: IBesuConnectionConfig, // Added for reconnection logic
  ) {
    if (network) {
      this.dockerNetwork = network;
    }

    this.erc20TokenContract = erc20TokenContract;

    const level = logLevel || "INFO";
    const label = "BesuTestEnvironment";
    this.log = LoggerProvider.getOrCreate({ level, label });

    // Populate properties if connecting to existing ledger (new logic for shared setup)
    if (existingConfig) {
      this.network = existingConfig.networkId;
      this.firstHighNetWorthAccount = existingConfig.firstHighNetWorthAccount;
      this.bridgeEthAccount = existingConfig.bridgeEthAccount;
      this.assigneeEthAccount = existingConfig.assigneeEthAccount;
      this.besuKeyPair = existingConfig.besuKeyPair;
      this.keychainEntryKey = existingConfig.keychainEntryKey;
      this.keychainEntryValue = existingConfig.keychainEntryValue;
      this.erc20TokenContract = existingConfig.erc20TokenContract;
      this.assetContractAddress = existingConfig.assetContractAddress;

      // Re-initialize Web3 and Connector for the existing ledger
      this.web3 = new Web3(existingConfig.rpcApiHttpHost);

      this.keychainPlugin1 = new PluginKeychainMemory({
        instanceId: uuidv4(), // Need new unique instanceId for this specific plugin instance
        keychainId: uuidv4(), // Need new unique keychainId for this specific keychain
        backend: new Map([[this.keychainEntryKey, this.keychainEntryValue]]),
        logLevel,
      });

      this.keychainPlugin2 = new PluginKeychainMemory({
        instanceId: uuidv4(), // Need new unique instanceId for this specific plugin instance
        keychainId: uuidv4(), // Need new unique keychainId for this specific keychain
        backend: new Map([[this.keychainEntryKey, this.keychainEntryValue]]),
        logLevel,
      });

      // Smart Contract Configuration - initial setup for known contract
      // Note: For dynamic contracts, this will be set in deployAndSetupContracts
      this.keychainPlugin1.set(
        this.erc20TokenContract,
        JSON.stringify(SATPTokenContract),
      );

      // Plugin Registry setup
      const pluginRegistry = new PluginRegistry({
        plugins: [this.keychainPlugin1, this.keychainPlugin2],
      });

      // Besu Connector setup
      this.connectorOptions = {
        instanceId: uuidv4(),
        rpcApiHttpHost: existingConfig.rpcApiHttpHost,
        rpcApiWsHost: existingConfig.rpcApiWsHost,
        pluginRegistry,
        logLevel,
      };

      this.connector = new PluginLedgerConnectorBesu(this.connectorOptions);

      // Initialize besuConfig for leaf options if needed
      this.besuConfig = {
        networkIdentification: this.network,
        signingCredential: {
          ethAccount: this.bridgeEthAccount.address,
          secret: this.bridgeEthAccount.privateKey,
          type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
        },
        leafId: "Testing-event-besu-leaf",
        connectorOptions: this.connectorOptions,
        claimFormats: [],
        gas: this.gas,
      };
    } else {
      // Original logic for new setup (used in global-setup), remains untouched
    }
  }

  // Initializes the Besu ledger, accounts, and connector for testing (ONLY CALLED ONCE IN GLOBAL SETUP)
  public async init(logLevel: LogLevelDesc): Promise<void> {
    // Only proceed if ledger is not already initialized (only for new setups)
    if (!this.ledger) {
      this.ledger = new BesuTestLedger({
        emitContainerLogs: true,
        envVars: ["BESU_NETWORK=dev"],
        containerImageVersion: "2024-06-09-cc2f9c5",
        containerImageName: "ghcr.io/hyperledger/cactus-besu-all-in-one",
        networkName: this.dockerNetwork,
      });

      const docker = new Docker();

      const container = await this.ledger.start(false);

      const containerData = await docker
        .getContainer((await container).id)
        .inspect();

      this.dockerContainerIP =
        containerData.NetworkSettings.Networks[
          this.dockerNetwork || "bridge"
        ].IPAddress;

      const rpcApiHttpHost = await this.ledger.getRpcApiHttpHost();
      const rpcApiWsHost = await this.ledger.getRpcApiWsHost();

      this.web3 = new Web3(rpcApiHttpHost);

      // Accounts setup
      this.firstHighNetWorthAccount = this.ledger.getGenesisAccountPubKey();
      this.bridgeEthAccount = await this.ledger.createEthTestAccount();
      this.assigneeEthAccount = await this.ledger.createEthTestAccount();

      // Besu Key Pair setup
      this.besuKeyPair = { privateKey: this.ledger.getGenesisAccountPrivKey() };
      this.keychainEntryValue = this.besuKeyPair.privateKey;
      this.keychainEntryKey = uuidv4();

      // Keychain Plugins setup
      this.keychainPlugin1 = new PluginKeychainMemory({
        instanceId: uuidv4(),
        keychainId: uuidv4(),
        backend: new Map([[this.keychainEntryKey, this.keychainEntryValue]]),
        logLevel,
      });

      this.keychainPlugin2 = new PluginKeychainMemory({
        instanceId: uuidv4(),
        keychainId: uuidv4(),
        backend: new Map([[this.keychainEntryKey, this.keychainEntryValue]]),
        logLevel,
      });

      // Smart Contract Configuration - initial setup for known contract
      // Note: For dynamic contracts, this will be set in deployAndSetupContracts
      this.keychainPlugin1.set(
        this.erc20TokenContract,
        JSON.stringify(SATPTokenContract),
      );

      // Plugin Registry setup
      const pluginRegistry = new PluginRegistry({
        plugins: [this.keychainPlugin1, this.keychainPlugin2],
      });

      // Besu Connector setup
      this.connectorOptions = {
        instanceId: uuidv4(),
        rpcApiHttpHost,
        rpcApiWsHost,
        pluginRegistry,
        logLevel,
      };

      this.connector = new PluginLedgerConnectorBesu(this.connectorOptions);

      // Fund the bridge account (initial funding, can be done once globally)
      await this.connector.transact({
        web3SigningCredential: {
          ethAccount: this.firstHighNetWorthAccount,
          secret: this.besuKeyPair.privateKey,
          type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
        },
        consistencyStrategy: {
          blockConfirmations: 0,
          receiptType: ReceiptType.NodeTxPoolAck,
        },
        transactionConfig: {
          from: this.firstHighNetWorthAccount,
          to: this.bridgeEthAccount.address,
          value: 10e9,
          gas: 1000000,
        },
      });

      const balance = await this.web3.eth.getBalance(
        this.bridgeEthAccount.address,
      );
      assert.ok(balance, "Balance should be truthy");
      assert.ok(
        parseInt(balance.toString(), 10) > 10e9,
        `Bridge account balance (${balance}) should be greater than 10e9`,
      );
      this.log.info(`Bridge account funded: New Balance: ${balance} wei`);

      // Initialize besuConfig for leaf options if needed
      this.besuConfig = {
        networkIdentification: this.network,
        signingCredential: {
          ethAccount: this.bridgeEthAccount.address,
          secret: this.bridgeEthAccount.privateKey,
          type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
        },
        leafId: "Testing-event-besu-leaf",
        connectorOptions: this.connectorOptions,
        claimFormats: [],
        gas: this.gas,
      };
    } else {
      this.log.warn("Besu init() skipped, ledger already initialized.");
    }
  }

  // Creates and initializes a new BesuTestEnvironment instance
  public static async setupTestEnvironment(
    config: IBesuTestEnvironment,
  ): Promise<BesuTestEnvironment> {
    const instance = new BesuTestEnvironment(
      config.contractName,
      config.logLevel,
      config.network,
    );
    await instance.init(config.logLevel);
    return instance;
  }

  // NEW: Static method to connect to an existing BesuTestLedger
  public static async connectToExistingEnvironment(
    config: IBesuConnectionConfig,
  ): Promise<BesuTestEnvironment> {
    const instance = new BesuTestEnvironment(
      config.erc20TokenContract,
      config.logLevel,
      undefined, // No network name needed for connecting
      config, // Pass the full connection config
    );
    return instance;
  }

  // this is the config to be loaded by the gateway, does not contain the log level because it will use the one in the gateway config
  public createBesuConfig(): INetworkOptions {
    return {
      networkIdentification: this.besuConfig.networkIdentification,
      signingCredential: this.besuConfig.signingCredential,
      wrapperContractName: this.besuConfig.wrapperContractName,
      wrapperContractAddress: this.besuConfig.wrapperContractAddress,
      gas: this.besuConfig.gas,
      connectorOptions: {
        rpcApiHttpHost: this.connectorOptions.rpcApiHttpHost,
        rpcApiWsHost: this.connectorOptions.rpcApiWsHost,
      },
      claimFormats: this.besuConfig.claimFormats,
    } as INetworkOptions;
  }

  public async createBesuDockerConfig(): Promise<INetworkOptions> {
    const rpcApiHttpHost = this.ledger
      ? await this.ledger.getRpcApiHttpHost(false)
      : this.connectorOptions.rpcApiHttpHost;
    const rpcApiWsHost = this.ledger
      ? await this.ledger.getRpcApiWsHost(false)
      : this.connectorOptions.rpcApiWsHost;

    return {
      networkIdentification: this.besuConfig.networkIdentification,
      signingCredential: this.besuConfig.signingCredential,
      wrapperContractName: this.besuConfig.wrapperContractName,
      wrapperContractAddress: this.besuConfig.wrapperContractAddress,
      gas: this.besuConfig.gas,
      connectorOptions: {
        rpcApiHttpHost,
        rpcApiWsHost,
      },
      claimFormats: this.besuConfig.claimFormats,
    } as INetworkOptions;
  }

  // this creates the same config as the bridge manager does
  public createBesuLeafConfig(
    ontologyManager: OntologyManager,
    logLevel?: LogLevelDesc,
  ): IBesuLeafOptions {
    return {
      networkIdentification: this.besuConfig.networkIdentification,
      signingCredential: this.besuConfig.signingCredential,
      ontologyManager: ontologyManager,
      wrapperContractName: this.besuConfig.wrapperContractName,
      wrapperContractAddress: this.besuConfig.wrapperContractAddress,
      gas: this.besuConfig.gas,
      connectorOptions: {
        instanceId: this.connectorOptions.instanceId,
        rpcApiHttpHost: this.connectorOptions.rpcApiHttpHost,
        rpcApiWsHost: this.connectorOptions.rpcApiWsHost,
        pluginRegistry: new PluginRegistry({ plugins: [] }),
        logLevel: logLevel,
      },
      claimFormats: this.besuConfig.claimFormats,
      logLevel: logLevel,
    };
  }

  public getNetworkId(): string {
    return this.network.id;
  }

  public getNetworkType(): LedgerType {
    return this.network.ledgerType;
  }

  // Deploys smart contracts and sets up configurations for testing
  public async deployAndSetupContracts(
    claimFormat: ClaimFormat,
    contractNameOverride?: string,
  ) {
    const contractName = contractNameOverride || this.erc20TokenContract;

    // FIX: Add the dynamic contractName and its ABI to the keychain *before* deploying.
    // This resolves "contractName in the request does not exist on the keychain" when using dynamic names.
    this.keychainPlugin1.set(contractName, JSON.stringify(SATPTokenContract));

    const deployOutSATPTokenContract = await this.connector.deployContract({
      keychainId: this.keychainPlugin1.getKeychainId(),
      contractName: contractName, // Use dynamic name
      contractAbi: SATPTokenContract.abi,
      constructorArgs: [this.firstHighNetWorthAccount],
      web3SigningCredential: {
        ethAccount: this.firstHighNetWorthAccount,
        secret: this.besuKeyPair.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      bytecode: SATPTokenContract.bytecode.object,
      gas: this.gas,
    });
    assert.ok(
      deployOutSATPTokenContract,
      "deployOutSATPTokenContract must be truthy",
    );
    assert.ok(
      deployOutSATPTokenContract.transactionReceipt,
      "deployOutSATPTokenContract.transactionReceipt must be truthy",
    );
    assert.ok(
      deployOutSATPTokenContract.transactionReceipt.contractAddress,
      "deployOutSATPTokenContract.transactionReceipt.contractAddress must be truthy",
    );

    this.assetContractAddress =
      deployOutSATPTokenContract.transactionReceipt.contractAddress ?? "";

    this.log.info(
      `SATPTokenContract (${contractName}) Deployed successfully at ${this.assetContractAddress}`,
    );

    this.besuConfig = {
      networkIdentification: this.network,
      signingCredential: {
        ethAccount: this.bridgeEthAccount.address,
        secret: this.bridgeEthAccount.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      leafId: "Testing-event-besu-leaf",
      connectorOptions: this.connectorOptions,
      claimFormats: [claimFormat],
      gas: this.gas,
    };
    // Update erc20TokenContract to the deployed name if it was overridden
    this.erc20TokenContract = contractName;
  }

  // Deploys smart contracts and sets up configurations for testing
  public async deployAndSetupOracleContracts(
    claimFormat: ClaimFormat,
    contract_name: string,
    contract: { abi: any; bytecode: { object: string } },
  ): Promise<string> {
    this.keychainPlugin1.set(
      contract_name,
      JSON.stringify(contract), // Store the entire contract JSON (ABI is part of it)
    );

    const blOracleContract = await this.connector.deployContract({
      keychainId: this.keychainPlugin1.getKeychainId(),
      contractName: contract_name,
      contractAbi: contract.abi, // Pass ABI directly (good practice)
      constructorArgs: [],
      web3SigningCredential: {
        ethAccount: this.bridgeEthAccount.address,
        secret: this.bridgeEthAccount.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      bytecode: contract.bytecode.object,
      gas: this.gas,
    });
    assert.ok(blOracleContract, "blOracleContract must be truthy");
    assert.ok(
      blOracleContract.transactionReceipt,
      "blOracleContract.transactionReceipt must be truthy",
    );
    assert.ok(
      blOracleContract.transactionReceipt.contractAddress,
      "blOracleContract.transactionReceipt.contractAddress must be truthy",
    );

    this.assetContractAddress =
      blOracleContract.transactionReceipt.contractAddress ?? "";

    this.log.info("this.businessLogicContract Deployed successfully");

    this.besuConfig = {
      networkIdentification: this.network,
      signingCredential: {
        ethAccount: this.bridgeEthAccount.address,
        secret: this.bridgeEthAccount.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      leafId: "Testing-event-besu-leaf",
      connectorOptions: this.connectorOptions,
      claimFormats: [claimFormat],
      gas: this.gas,
    };

    return blOracleContract.transactionReceipt.contractAddress!;
  }

  public async mintTokens(
    amount: string,
    contractAddress?: string,
  ): Promise<void> {
    const targetContractAddress = contractAddress || this.assetContractAddress;
    assert.ok(targetContractAddress, "targetContractAddress must be truthy");

    const responseMint = await this.connector.invokeContract({
      contractName: this.erc20TokenContract,
      contractAddress: targetContractAddress,
      keychainId: this.keychainPlugin1.getKeychainId(),
      invocationType: BesuContractInvocationType.Send,
      methodName: "mint",
      params: [this.firstHighNetWorthAccount, amount],
      contractAbi: SATPTokenContract.abi, // Original: Pass contractAbi here
      signingCredential: {
        ethAccount: this.firstHighNetWorthAccount,
        secret: this.besuKeyPair.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      gas: this.besuConfig.gas,
    });
    assert.ok(responseMint, "responseMint must be truthy");
    assert.ok(responseMint.success, "responseMint.success must be truthy");
    this.log.info("Minted 100 tokens to firstHighNetWorthAccount");
  }

  public async giveRoleToBridge(
    wrapperAddress: string,
    contractAddress?: string,
  ): Promise<void> {
    const targetContractAddress = contractAddress || this.assetContractAddress;
    assert.ok(targetContractAddress, "targetContractAddress must be truthy");

    const giveRoleRes = await this.connector.invokeContract({
      contractName: this.erc20TokenContract,
      contractAddress: targetContractAddress,
      keychainId: this.keychainPlugin1.getKeychainId(),
      invocationType: BesuContractInvocationType.Send,
      methodName: "grantBridgeRole",
      params: [wrapperAddress],
      contractAbi: SATPTokenContract.abi, // Original: Pass contractAbi here
      signingCredential: {
        ethAccount: this.firstHighNetWorthAccount,
        secret: this.besuKeyPair.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      gas: 1000000,
    });

    assert.ok(giveRoleRes, "giveRoleRes must be truthy");
    assert.ok(giveRoleRes.success, "giveRoleRes.success must be truthy");
    this.log.info("BRIDGE_ROLE given to SATPWrapperContract successfully");
  }

  public async approveAmount(
    wrapperAddress: string,
    amount: string,
    contractAddress?: string,
  ): Promise<void> {
    const targetContractAddress = contractAddress || this.assetContractAddress;
    assert.ok(targetContractAddress, "targetContractAddress must be truthy");

    const responseApprove = await this.connector.invokeContract({
      contractName: this.erc20TokenContract,
      contractAddress: targetContractAddress,
      keychainId: this.keychainPlugin1.getKeychainId(),
      invocationType: BesuContractInvocationType.Send,
      methodName: "approve",
      params: [wrapperAddress, amount],
      contractAbi: SATPTokenContract.abi, // Original: Pass contractAbi here
      signingCredential: {
        ethAccount: this.firstHighNetWorthAccount,
        secret: this.besuKeyPair.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      gas: this.besuConfig.gas,
    });
    assert.ok(responseApprove, "responseApprove must be truthy");
    assert.ok(
      responseApprove.success,
      "responseApprove.success must be truthy",
    );
    this.log.info("Approved 100 tokens to SATPWrapperContract");
  }

  public getTestContractName(): string {
    return this.erc20TokenContract;
  }

  public getTestContractAddress(): string {
    return this.assetContractAddress ?? "";
  }

  public getTestContractAbi(): any {
    return SATPTokenContract.abi;
  }

  public getTestOwnerAccount(): string {
    return this.firstHighNetWorthAccount;
  }

  public getBridgeEthAccount(): string {
    return this.bridgeEthAccount.address;
  }

  public getTestOwnerSigningCredential(): Web3SigningCredential {
    return {
      ethAccount: this.firstHighNetWorthAccount,
      secret: this.besuKeyPair.privateKey,
      type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
    };
  }

  public getBridgeEthAccountSigningCredential(): Web3SigningCredential {
    return {
      ethAccount: this.bridgeEthAccount.address,
      secret: this.bridgeEthAccount.privateKey,
      type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
    };
  }

  public async checkBalance(
    contract_name: string,
    contract_address: string,
    contract_abi: any,
    account: string,
    amount: string,
    signingCredential: Web3SigningCredential,
  ): Promise<void> {
    const responseBalanceBridge = await this.connector.invokeContract({
      contractName: contract_name,
      contractAddress: contract_address,
      contractAbi: contract_abi, // Original: Pass contractAbi here
      invocationType: BesuContractInvocationType.Call,
      methodName: "balanceOf",
      params: [account],
      signingCredential: signingCredential,
      gas: this.besuConfig.gas,
    });

    assert.ok(responseBalanceBridge, "responseBalanceBridge must be truthy");
    assert.ok(
      responseBalanceBridge.success,
      "responseBalanceBridge.success must be truthy",
    );
    assert.equal(
      responseBalanceBridge.callOutput,
      amount,
      `Balance mismatch: expected ${amount}, got ${responseBalanceBridge.callOutput}`,
    );
  }
  // Gets the default asset configuration for testing
  public get defaultAsset(): Asset {
    return {
      id: BesuTestEnvironment.BESU_ASSET_ID,
      referenceId: BesuTestEnvironment.BESU_REFERENCE_ID,
      owner: this.firstHighNetWorthAccount,
      contractName: this.erc20TokenContract,
      contractAddress: this.assetContractAddress,
      networkId: this.network,
      tokenType: AssetTokenTypeEnum.NonstandardFungible,
    };
  }

  // Returns the assignee account address used for testing transactions
  get transactRequestPubKey(): string {
    return this.assigneeEthAccount?.address ?? "";
  }

  // Oracle related functions

  public getData(
    contractName: string,
    contractAddress: string,
    contractAbi: any,
    methodName: string,
    params: string[],
  ): Promise<any> {
    return this.connector.invokeContract({
      contractName,
      contractAddress,
      contractAbi,
      invocationType: BesuContractInvocationType.Call,
      methodName,
      params,
      signingCredential: {
        ethAccount: this.bridgeEthAccount.address,
        secret: this.bridgeEthAccount.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      gas: this.besuConfig.gas,
    });
  }

  public async readData(
    contractName: string,
    contractAddress: string,
    contractAbi: any,
    methodName: string,
    params: string[],
  ): Promise<InvokeContractV1Response> {
    const response = await this.connector.invokeContract({
      contractName,
      contractAddress,
      contractAbi,
      invocationType: BesuContractInvocationType.Call,
      methodName,
      params,
      signingCredential: {
        ethAccount: this.bridgeEthAccount.address,
        secret: this.bridgeEthAccount.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      gas: this.besuConfig.gas,
    });

    assert.ok(response, "response must be truthy");
    assert.ok(response.success, "response.success must be truthy");

    return response;
  }

  public async writeData(
    contractName: string,
    contractAddress: string,
    contractAbi: any,
    methodName: string,
    params: string[],
  ): Promise<InvokeContractV1Response> {
    const response = await this.connector.invokeContract({
      contractName,
      contractAddress,
      contractAbi,
      invocationType: BesuContractInvocationType.Send,
      methodName,
      params,
      signingCredential: {
        ethAccount: this.bridgeEthAccount.address,
        secret: this.bridgeEthAccount.privateKey,
        type: Web3SigningCredentialTypeBesu.PrivateKeyHex,
      },
      gas: this.besuConfig.gas,
    });

    assert.ok(response, "response must be truthy");
    assert.ok(response.success, "response.success must be truthy");

    return response;
  }

  // Stops and destroys the test ledger
  public async tearDown(): Promise<void> {
    if (this.ledger) {
      // Only tear down if this instance started the ledger
      await this.ledger.stop();
      await this.ledger.destroy();
    } else {
      this.log.warn(
        "Besu ledger instance not found. Skipping tearDown (likely connected to existing).",
      );
    }
  }
}

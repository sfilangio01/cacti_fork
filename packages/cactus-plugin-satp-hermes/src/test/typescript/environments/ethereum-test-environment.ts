import {
  Logger,
  LoggerProvider,
  LogLevelDesc,
} from "@hyperledger/cactus-common";
import SATPTokenContract from "../../solidity/generated/SATPTokenContract.sol/SATPTokenContract.json";
import SATPWrapperContract from "../../../main/solidity/generated/SATPWrapperContract.sol/SATPWrapperContract.json";
import { PluginKeychainMemory } from "@hyperledger/cactus-plugin-keychain-memory";
import { PluginRegistry } from "@hyperledger/cactus-core";
import { randomUUID as uuidv4 } from "node:crypto";
import {
  EthContractInvocationType,
  GasTransactionConfig,
  InvokeContractV1Response,
  IPluginLedgerConnectorEthereumOptions,
  PluginLedgerConnectorEthereum,
  Web3SigningCredential,
  Web3SigningCredentialType,
} from "@hyperledger/cactus-plugin-ledger-connector-ethereum";
import { IPluginBungeeHermesOptions } from "@hyperledger/cactus-plugin-bungee-hermes";
import {
  GethTestLedger,
  WHALE_ACCOUNT_ADDRESS,
} from "@hyperledger/cactus-test-geth-ledger";
import { ClaimFormat } from "../../../main/typescript/generated/proto/cacti/satp/v02/common/message_pb";
import { Asset, AssetTokenTypeEnum, NetworkId } from "../../../main/typescript";
import { LedgerType } from "@hyperledger/cactus-core-api";
import {
  IEthereumLeafNeworkOptions,
  IEthereumLeafOptions,
} from "../../../main/typescript/cross-chain-mechanisms/bridge/leafs/ethereum-leaf";
import { OntologyManager } from "../../../main/typescript/cross-chain-mechanisms/bridge/ontology/ontology-manager";
import ExampleOntology from "../../ontologies/ontology-satp-erc20-interact-ethereum.json";
import { INetworkOptions } from "../../../main/typescript/cross-chain-mechanisms/bridge/bridge-types";
import * as assert from "assert";
import Web3 from "web3";

/**
 * Interface for serializable Ethereum connection configuration.
 * Used to pass ledger details between global setup and individual test files.
 */
export interface IEthereumConnectionConfig {
  rpcApiHttpHost?: string;
  rpcApiWsHost?: string;
  bridgeEthAccount: string;
  keychainEntryKey: string;
  keychainEntryValue: string;
  erc20TokenContract: string;
  assetContractAddress?: string;
  networkId: NetworkId;
  logLevel: LogLevelDesc;
  chainId: bigint; // Changed type from number to bigint
}

export interface IEthereumTestEnvironment {
  contractName: string;
  logLevel: LogLevelDesc;
  network?: string;
}

/**
 * Test environment for Ethereum ledger operations.
 * Manages the lifecycle of a Geth test ledger, its connector, and contract deployments.
 * Supports both starting a new ledger and connecting to an existing one.
 */
export class EthereumTestEnvironment {
  public static readonly ETH_ASSET_ID: string = "EthereumExampleAsset";
  public static readonly ETHREFERENCE_ID: string = ExampleOntology.id;
  public static readonly ETH_NETWORK_ID: string = "EthereumLedgerTestNetwork";

  public readonly network: NetworkId = {
    id: EthereumTestEnvironment.ETH_NETWORK_ID,
    ledgerType: LedgerType.Ethereum,
  };

  public ledger?: GethTestLedger;
  public connector!: PluginLedgerConnectorEthereum;
  public connectorOptions!: IPluginLedgerConnectorEthereumOptions;
  public bungeeOptions!: IPluginBungeeHermesOptions; // Not directly used in this class, but part of the original context
  public keychainPlugin1!: PluginKeychainMemory;
  public keychainPlugin2!: PluginKeychainMemory;
  public keychainEntryKey!: string;
  public keychainEntryValue!: string;
  public bridgeEthAccount!: string;
  public erc20TokenContract!: string;
  public contractNameWrapper!: string;
  public assetContractAddress!: string;
  public wrapperContractAddress!: string; // Not explicitly set in this class, but part of config
  public ethereumConfig!: IEthereumLeafNeworkOptions;
  public gasConfig: GasTransactionConfig | undefined = {
    gas: "6721975",
    gasPrice: "20000000000",
  };
  public rpcApiHttpHost?: string;
  public rpcApiWsHost?: string;
  public web3!: Web3;
  public chainId!: bigint; // Changed type from number to bigint

  private dockerNetwork?: string;
  private startedNetwork: boolean = false; // Flag to indicate if this instance started the ledger

  private readonly log: Logger;

  /**
   * Private constructor to enforce static factory methods for creation.
   * @param erc20TokenContract The name of the ERC20 token contract.
   * @param logLevel The log level for the environment.
   * @param network Optional Docker network name.
   * @param existingConfig Optional configuration for connecting to an already running ledger.
   */
  private constructor(
    erc20TokenContract: string,
    logLevel: LogLevelDesc,
    network?: string,
    existingConfig?: IEthereumConnectionConfig,
  ) {
    if (network) {
      this.dockerNetwork = network;
    }

    this.contractNameWrapper = "SATPWrapperContract";
    this.erc20TokenContract = erc20TokenContract;

    const level = logLevel || "INFO";
    const label = "EthereumTestEnvironment";
    this.log = LoggerProvider.getOrCreate({ level, label });

    // Logic for connecting to an existing ledger
    if (existingConfig) {
      this.network = existingConfig.networkId;
      this.rpcApiHttpHost = existingConfig.rpcApiHttpHost;
      this.rpcApiWsHost = existingConfig.rpcApiWsHost;
      this.bridgeEthAccount = existingConfig.bridgeEthAccount;
      this.keychainEntryKey = existingConfig.keychainEntryKey;
      this.keychainEntryValue = existingConfig.keychainEntryValue;
      this.erc20TokenContract = existingConfig.erc20TokenContract;
      this.assetContractAddress = existingConfig.assetContractAddress!;
      this.chainId = existingConfig.chainId; // Assign the chainId from existing config

      assert.ok(
        this.rpcApiHttpHost,
        "rpcApiHttpHost must be available for Web3 initialization",
      );
      this.web3 = new Web3(this.rpcApiHttpHost);

      // Re-initialize keychains and plugins for the current process
      // Ensure that the contract definition includes the deployed address for the specific network ID (chainId)
      const SATPTokenContractForKeychain = {
        abi: SATPTokenContract.abi,
        bytecode: SATPTokenContract.bytecode.object, // FIX: Directly use the bytecode string
        networks: {
          [this.chainId.toString()]: {
            // Use chainId as string key for the network
            address: existingConfig.assetContractAddress,
            events: {},
            links: {},
          },
        },
      };
      const SATPWrapperContractForKeychain = {
        abi: SATPWrapperContract.abi,
        bytecode: SATPWrapperContract.bytecode.object, // FIX: Directly use the bytecode string
        networks: {
          [this.chainId.toString()]: {
            // Use chainId as string key for the network
            address: this.wrapperContractAddress, // Assuming wrapper address is also in existingConfig if needed
            events: {},
            links: {},
          },
        },
      };

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

      this.log.info(
        `Keychain plugins initialized with key: ${this.keychainEntryKey}`,
      );
      this.log.info(`Keychain entry value: ${this.keychainEntryValue}`);
      this.log.info(`ERC20 Token Contract: ${this.erc20TokenContract}`);
      this.log.info(`Asset Contract Address: ${this.assetContractAddress}`);
      this.log.info(`Network ID: ${this.network.id}`);
      this.log.info(`Chain ID: ${this.chainId}`);
      this.log.info(`RPC API HTTP Host: ${this.rpcApiHttpHost}`);

      this.keychainPlugin1.set(
        this.erc20TokenContract,
        JSON.stringify(SATPTokenContractForKeychain),
      );
      this.keychainPlugin2.set(
        this.contractNameWrapper,
        JSON.stringify(SATPWrapperContractForKeychain),
      );

      const pluginRegistry = new PluginRegistry({
        plugins: [this.keychainPlugin1, this.keychainPlugin2],
      });

      this.connectorOptions = {
        instanceId: uuidv4(),
        rpcApiHttpHost: this.rpcApiHttpHost,
        rpcApiWsHost: this.rpcApiWsHost,
        pluginRegistry,
        logLevel,
      };

      this.connector = new PluginLedgerConnectorEthereum(this.connectorOptions);

      this.ethereumConfig = {
        networkIdentification: this.network,
        signingCredential: {
          ethAccount: this.bridgeEthAccount,
          secret: "test",
          type: Web3SigningCredentialType.GethKeychainPassword,
        },
        leafId: "Testing-event-ethereum-leaf",
        connectorOptions: this.connectorOptions,
        claimFormats: [], // This will be populated later if needed
        gasConfig: this.gasConfig,
      };
      this.startedNetwork = false; // This instance connects to existing, doesn't start
    } else {
      // Original logic for new setup (used in global-setup)
      this.startedNetwork = true; // This instance starts the ledger
    }
  }

  /**
   * Initializes the Ethereum ledger, accounts, and connector for testing.
   * This method is ONLY CALLED ONCE in the global setup (`jest.global-setup.ts`).
   * It starts a new Geth ledger container.
   * @param logLevel The log level for the environment.
   */
  public async init(logLevel: LogLevelDesc): Promise<void> {
    // Only proceed if this instance is designated to start the ledger
    if (!this.startedNetwork) {
      this.log.warn("Ethereum init() skipped, ledger already initialized.");
      return;
    }

    this.ledger = new GethTestLedger({
      containerImageName: "ghcr.io/hyperledger/cacti-geth-all-in-one",
      containerImageVersion: "2023-07-27-2a8c48ed6",
      networkName: this.dockerNetwork,
    });

    await this.ledger.start(false, []);

    const SATPTokenContract1 = {
      contractName: "SATPTokenContract",
      abi: SATPTokenContract.abi,
      bytecode: SATPTokenContract.bytecode.object,
    };
    const SATPWrapperContract1 = {
      contractName: "SATPWrapperContract",
      abi: SATPWrapperContract.abi,
      bytecode: SATPWrapperContract.bytecode.object,
    };

    this.rpcApiWsHost = await this.ledger.getRpcApiWebSocketHost();
    this.rpcApiHttpHost = await this.ledger.getRpcApiHttpHost();

    this.web3 = new Web3(this.rpcApiHttpHost); // Initialize Web3 for new setup
    this.chainId = await this.web3.eth.getChainId(); // Get and store the actual chain ID

    this.bridgeEthAccount = await this.ledger.newEthPersonalAccount();
    this.keychainEntryValue = "test";
    this.keychainEntryKey = this.bridgeEthAccount;

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

    // Store the contract definitions in the keychain.
    // The `deployContract` method of the connector will later update the `networks` property
    // with the deployed address using the actual chain ID as the key.
    this.keychainPlugin1.set(
      this.erc20TokenContract,
      JSON.stringify(SATPTokenContract1),
    );
    this.keychainPlugin2.set(
      this.contractNameWrapper,
      JSON.stringify(SATPWrapperContract1),
    );

    const pluginRegistry = new PluginRegistry({
      plugins: [this.keychainPlugin1, this.keychainPlugin2],
    });

    this.connectorOptions = {
      instanceId: uuidv4(),
      rpcApiWsHost: this.rpcApiWsHost,
      rpcApiHttpHost: this.rpcApiHttpHost,
      pluginRegistry,
      logLevel,
    };

    this.connector = new PluginLedgerConnectorEthereum(this.connectorOptions);

    this.ethereumConfig = {
      networkIdentification: this.network,
      signingCredential: {
        ethAccount: this.bridgeEthAccount,
        secret: "test",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
      leafId: "Testing-event-ethereum-leaf",
      connectorOptions: this.connectorOptions,
      claimFormats: [],
      gasConfig: this.gasConfig,
    };
  }

  public getTestContractAddress(): string {
    return this.assetContractAddress ?? "";
  }

  public getTestContractName(): string {
    return this.erc20TokenContract;
  }

  public getTestContractAbi(): any {
    return SATPTokenContract.abi;
  }

  public getTestOwnerAccount(): string {
    return WHALE_ACCOUNT_ADDRESS;
  }

  public getBridgeEthAccount(): string {
    return this.bridgeEthAccount;
  }

  public getTestOwnerSigningCredential(): Web3SigningCredential {
    return {
      ethAccount: WHALE_ACCOUNT_ADDRESS,
      secret: "",
      type: Web3SigningCredentialType.GethKeychainPassword,
    };
  }

  public getTestBridgeSigningCredential(): Web3SigningCredential {
    return {
      ethAccount: this.bridgeEthAccount,
      secret: "test",
      type: Web3SigningCredentialType.GethKeychainPassword,
    };
  }

  public getTestOracleSigningCredential(): Web3SigningCredential {
    return {
      ethAccount: this.bridgeEthAccount,
      secret: "test",
      type: Web3SigningCredentialType.GethKeychainPassword,
    };
  }

  /**
   * Creates and initializes a new EthereumTestEnvironment instance.
   * This is used in the global setup (`jest.global-setup.ts`) to start a fresh ledger.
   * @param config Configuration for the new test environment.
   * @returns A promise that resolves to the initialized EthereumTestEnvironment instance.
   */
  public static async setupTestEnvironment(
    config: IEthereumTestEnvironment,
  ): Promise<EthereumTestEnvironment> {
    const instance = new EthereumTestEnvironment(
      config.contractName,
      config.logLevel,
      config.network,
    );
    await instance.init(config.logLevel);
    return instance;
  }

  /**
   * Connects to an already existing EthereumTestLedger.
   * This is used by individual test files (`besu_ethereum.test.ts`) to reuse the ledger
   * started by the global setup.
   * @param config Configuration for connecting to the existing environment.
   * @returns A promise that resolves to the connected EthereumTestEnvironment instance.
   */
  public static async connectToExistingEnvironment(
    config: IEthereumConnectionConfig,
  ): Promise<EthereumTestEnvironment> {
    const instance = new EthereumTestEnvironment(
      config.erc20TokenContract,
      config.logLevel,
      undefined, // No new network to start
      config, // Pass the full connection config
    );
    return instance;
  }

  /**
   * Creates the network options configuration as expected by the bridge manager.
   * @returns The network options for the Ethereum leaf.
   */
  public createEthereumLeafConfig(
    ontologyManager: OntologyManager,
    logLevel?: LogLevelDesc,
  ): IEthereumLeafOptions {
    return {
      networkIdentification: this.ethereumConfig.networkIdentification,
      signingCredential: this.ethereumConfig.signingCredential,
      ontologyManager: ontologyManager,
      wrapperContractName: this.ethereumConfig.wrapperContractName,
      wrapperContractAddress: this.ethereumConfig.wrapperContractAddress,
      gasConfig: this.ethereumConfig.gasConfig,
      connectorOptions: {
        instanceId: this.connectorOptions.instanceId,
        rpcApiHttpHost: this.connectorOptions.rpcApiHttpHost,
        rpcApiWsHost: this.connectorOptions.rpcApiWsHost,
        pluginRegistry: new PluginRegistry({ plugins: [] }), // New registry for this leaf
        logLevel: logLevel,
      },
      claimFormats: this.ethereumConfig.claimFormats,
      logLevel: logLevel,
    };
  }

  /**
   * Creates the configuration to be loaded by the SATP Gateway.
   * Does not contain the log level, as it will use the one from the gateway config.
   * @returns The network options for the gateway.
   */
  public createEthereumConfig(): INetworkOptions {
    return {
      networkIdentification: this.ethereumConfig.networkIdentification,
      signingCredential: this.ethereumConfig.signingCredential,
      wrapperContractName: this.ethereumConfig.wrapperContractName,
      wrapperContractAddress: this.ethereumConfig.wrapperContractAddress,
      gasConfig: this.ethereumConfig.gasConfig,
      connectorOptions: {
        rpcApiHttpHost: this.connectorOptions.rpcApiHttpHost,
        rpcApiWsHost: this.connectorOptions.rpcApiWsHost,
      },
      claimFormats: this.ethereumConfig.claimFormats,
    } as INetworkOptions;
  }

  /**
   * Creates the configuration to be loaded by the gateway when running in a Docker environment.
   * Uses the ledger's dynamic RPC hosts.
   * @returns The network options for the gateway in a Docker setup.
   */
  public async createEthereumDockerConfig(): Promise<INetworkOptions> {
    return {
      networkIdentification: this.ethereumConfig.networkIdentification,
      signingCredential: this.ethereumConfig.signingCredential,
      wrapperContractName: this.ethereumConfig.wrapperContractName,
      wrapperContractAddress: this.ethereumConfig.wrapperContractAddress,
      gasConfig: this.ethereumConfig.gasConfig,
      connectorOptions: {
        rpcApiHttpHost: this.ledger?.getRpcApiHttpHost(false),
        rpcApiWsHost: this.ledger?.getRpcApiWebSocketHost(false),
      },
      claimFormats: this.ethereumConfig.claimFormats,
    } as INetworkOptions;
  }

  /**
   * Deploys the SATPTokenContract and sets up initial configurations for testing.
   * This is called once during the global setup.
   * @param claimFormat The claim format to be used.
   */
  public async deployAndSetupContracts(claimFormat: ClaimFormat) {
    const deployOutSATPTokenContract = await this.connector.deployContract({
      contract: {
        keychainId: this.keychainPlugin1.getKeychainId(),
        contractName: this.erc20TokenContract,
      },
      constructorArgs: [WHALE_ACCOUNT_ADDRESS],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    assert.ok(
      deployOutSATPTokenContract,
      "deployOutSATPTokenContract must be truthy",
    );
    assert.ok(
      deployOutSATPTokenContract.transactionReceipt,
      "transactionReceipt must be truthy",
    );
    assert.ok(
      deployOutSATPTokenContract.transactionReceipt.contractAddress,
      "contractAddress must be truthy",
    );

    this.assetContractAddress =
      deployOutSATPTokenContract.transactionReceipt.contractAddress ?? "";

    this.log.info("SATPTokenContract Deployed successfully");

    this.ethereumConfig = {
      networkIdentification: this.network,
      signingCredential: {
        ethAccount: this.bridgeEthAccount,
        secret: "test",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
      leafId: "Testing-event-ethereum-leaf",
      connectorOptions: this.connectorOptions,
      claimFormats: [claimFormat],
      gasConfig: this.gasConfig,
    };

    this.log.info("BRIDGE_ROLE given to SATPWrapperContract successfully");
  }

  /**
   * Deploys Oracle smart contracts and sets up configurations for testing.
   * @param claimFormat The claim format.
   * @param contract_name The name of the oracle contract.
   * @param contract The contract ABI and bytecode.
   * @returns The deployed contract address.
   */
  public async deployAndSetupOracleContracts(
    claimFormat: ClaimFormat,
    contract_name: string,
    contract: { abi: any; bytecode: { object: string } },
  ): Promise<string> {
    const blOracleContract = await this.connector.deployContract({
      contract: {
        contractJSON: {
          contractName: contract_name,
          abi: contract.abi,
          bytecode: contract.bytecode.object,
        },
        keychainId: this.keychainPlugin1.getKeychainId(),
      },
      constructorArgs: [],
      web3SigningCredential: this.getTestOracleSigningCredential(),
      gasConfig: this.gasConfig,
    });
    assert.ok(blOracleContract, "blOracleContract must be truthy");
    assert.ok(
      blOracleContract.transactionReceipt,
      "transactionReceipt must be truthy",
    );
    assert.ok(
      blOracleContract.transactionReceipt.contractAddress,
      "contractAddress must be truthy",
    );

    this.assetContractAddress =
      blOracleContract.transactionReceipt.contractAddress ?? "";

    this.log.info("Oracle Business Logic Contract Deployed successfully");

    this.ethereumConfig = {
      networkIdentification: this.network,
      signingCredential: this.getTestOracleSigningCredential(),
      connectorOptions: this.connectorOptions,
      claimFormats: [claimFormat],
      gasConfig: this.gasConfig,
    };

    return blOracleContract.transactionReceipt.contractAddress!;
  }

  /**
   * Mints a specified amount of tokens to the WHALE_ACCOUNT_ADDRESS.
   * @param amount The amount of tokens to mint.
   */
  public async mintTokens(amount: string): Promise<void> {
    const responseMint = await this.connector.invokeContract({
      contract: {
        contractName: this.erc20TokenContract,
        keychainId: this.keychainPlugin1.getKeychainId(),
      },
      invocationType: EthContractInvocationType.Send,
      methodName: "mint",
      params: [WHALE_ACCOUNT_ADDRESS, amount],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    assert.ok(responseMint, "responseMint must be truthy");
    assert.ok(responseMint.success, "responseMint.success must be truthy");
    this.log.info(`Minted ${amount} tokens to WHALE_ACCOUNT_ADDRESS`);
  }

  /**
   * Grants the BRIDGE_ROLE to a specified wrapper address on the ERC20 token contract.
   * @param wrapperAddress The address of the wrapper contract to grant the role to.
   */
  public async giveRoleToBridge(wrapperAddress: string): Promise<void> {
    const giveRoleRes = await this.connector.invokeContract({
      contract: {
        contractName: this.erc20TokenContract,
        keychainId: this.keychainPlugin1.getKeychainId(),
      },
      invocationType: EthContractInvocationType.Send,
      methodName: "grantBridgeRole",
      params: [wrapperAddress],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });

    assert.ok(giveRoleRes, "giveRoleRes must be truthy");
    assert.ok(giveRoleRes.success, "giveRoleRes.success must be truthy");
    this.log.info("BRIDGE_ROLE given to SATPWrapperContract successfully");
  }

  /**
   * Approves a specified amount of tokens for a wrapper address on the ERC20 token contract.
   * @param wrapperAddress The address of the wrapper contract to approve tokens for.
   * @param amount The amount of tokens to approve.
   */
  public async approveAmount(
    wrapperAddress: string,
    amount: string,
  ): Promise<void> {
    const responseApprove = await this.connector.invokeContract({
      contract: {
        contractName: this.erc20TokenContract,
        keychainId: this.keychainPlugin1.getKeychainId(),
      },
      invocationType: EthContractInvocationType.Send,
      methodName: "approve",
      params: [wrapperAddress, amount],
      web3SigningCredential: {
        ethAccount: WHALE_ACCOUNT_ADDRESS,
        secret: "",
        type: Web3SigningCredentialType.GethKeychainPassword,
      },
    });
    assert.ok(responseApprove, "responseApprove must be truthy");
    assert.ok(
      responseApprove.success,
      "responseApprove.success must be truthy",
    );
    this.log.info(`Approved ${amount} tokens to SATPWrapperContract`);
  }

  /**
   * Checks the balance of an account on a specified contract.
   * @param contract_name The name of the contract.
   * @param contract_address The address of the contract.
   * @param contract_abi The ABI of the contract.
   * @param account The account address to check balance for.
   * @param amount The expected amount.
   * @param signingCredential The signing credential for the transaction.
   */
  public async checkBalance(
    contract_name: string,
    contract_address: string,
    contract_abi: any,
    account: string,
    amount: string,
    signingCredential: Web3SigningCredential,
  ): Promise<void> {
    const responseBalanceBridge = await this.connector.invokeContract({
      contract: {
        contractJSON: {
          contractName: contract_name,
          abi: contract_abi,
          bytecode: SATPTokenContract.bytecode.object, // Use the actual bytecode object from the JSON
        },
        contractAddress: contract_address,
      },
      invocationType: EthContractInvocationType.Call,
      methodName: "balanceOf",
      params: [account],
      web3SigningCredential: signingCredential,
    });

    assert.ok(responseBalanceBridge, "responseBalanceBridge must be truthy");
    assert.ok(
      responseBalanceBridge.success,
      "responseBalanceBridge.success must be truthy",
    );
    assert.strictEqual(
      responseBalanceBridge.callOutput.toString(),
      amount,
      "Balance mismatch",
    );
  }

  /**
   * Gets the default asset configuration for testing.
   */
  public get defaultAsset(): Asset {
    return {
      id: EthereumTestEnvironment.ETH_ASSET_ID,
      referenceId: EthereumTestEnvironment.ETHREFERENCE_ID,
      owner: WHALE_ACCOUNT_ADDRESS,
      contractName: this.erc20TokenContract,
      contractAddress: this.assetContractAddress,
      networkId: this.network,
      tokenType: AssetTokenTypeEnum.NonstandardFungible,
    };
  }

  /**
   * Returns the whale account address used for testing transactions.
   */
  get transactRequestPubKey(): string {
    return WHALE_ACCOUNT_ADDRESS;
  }

  /**
   * Stops and destroys the test ledger.
   * Only performs teardown if this instance was responsible for starting the network.
   */
  public async tearDown(): Promise<void> {
    if (this.startedNetwork && this.ledger) {
      await this.ledger.stop();
      await this.ledger.destroy();
      this.log.info("Ethereum ledger stopped and destroyed successfully.");
    } else {
      this.log.warn(
        "Ethereum ledger instance not found or not the network starter. Skipping tearDown.",
      );
    }
  }

  /**
   * Writes data to a specified contract on the Ethereum ledger.
   * @param contractName The name of the contract.
   * @param contractAddress The address of the contract.
   * @param contractAbi The ABI of the contract.
   * @param methodName The method name to invoke.
   * @param params Parameters for the method.
   * @returns The invocation response.
   */
  public async writeData(
    contractName: string,
    contractAddress: string,
    contractAbi: any,
    methodName: string,
    params: string[],
  ): Promise<InvokeContractV1Response> {
    const response = await this.connector.invokeContract({
      contract: {
        contractJSON: {
          contractName: contractName,
          abi: contractAbi,
          bytecode: SATPTokenContract.bytecode.object, // Use actual bytecode object
        },
        contractAddress: contractAddress,
      },
      invocationType: EthContractInvocationType.Send,
      methodName: methodName,
      params: params,
      web3SigningCredential: this.getTestOracleSigningCredential(),
    });
    assert.ok(response, "Response must be truthy");
    return response;
  }

  /**
   * Reads data from a specified contract on the Ethereum ledger.
   * @param contractName The name of the contract.
   * @param contractAddress The address of the contract.
   * @param contractAbi The ABI of the contract.
   * @param methodName The method name to invoke.
   * @param params Parameters for the method.
   * @returns The invocation response.
   */
  public readData(
    contractName: string,
    contractAddress: string,
    contractAbi: any,
    methodName: string,
    params: string[],
  ): Promise<InvokeContractV1Response> {
    const response = this.connector.invokeContract({
      contract: {
        contractJSON: {
          contractName: contractName,
          abi: contractAbi,
          bytecode: SATPTokenContract.bytecode.object, // Use actual bytecode object
        },
        contractAddress: contractAddress,
      },
      invocationType: EthContractInvocationType.Call,
      methodName: methodName,
      params: params,
      web3SigningCredential: this.getTestOracleSigningCredential(),
    });
    assert.ok(response, "Response must be truthy");
    return response;
  }
}

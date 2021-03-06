import assert from 'assert'
import EventEmitter from 'events'
import ObservableStore from 'obs-store'
import ComposedStore from 'obs-store/lib/composed'
import EthQuery from '../../eth-query'
import JsonRpcEngine from 'json-rpc-engine'
import providerFromEngine from '@yqrashawn/cfx-json-rpc-middleware/providerFromEngine'
import log from 'loglevel'
import createMetamaskMiddleware from './createMetamaskMiddleware'
// import createInfuraClient from './createInfuraClient'
import createJsonRpcClient from './createJsonRpcClient'
import createLocalhostClient from './createLocalhostClient'
import {
  createSwappableProxy,
  createEventEmitterProxy,
} from 'swappable-obj-proxy'

const networks = { networkList: {} }

import {
  TESTNET,
  MAINNET,
  LOCALHOST,
} from './enums'
// const INFURA_PROVIDER_TYPES = [ROPSTEN, RINKEBY, KOVAN, MAINNET, GOERLI]
// TODO: add main net endpoint
const CONFLUX_MAINNET = 'http://wallet-mainnet-jsonrpc.conflux-chain.org:12537'
const CONFLUX_TEST_NET = 'http://wallet-testnet-jsonrpc.conflux-chain.org:12537'

const env = process.env.METAMASK_ENV
const METAMASK_DEBUG = process.env.METAMASK_DEBUG

let defaultProviderConfigType
if (process.env.IN_TEST === 'true') {
  // defaultProviderConfigType = TESTNET
  defaultProviderConfigType = LOCALHOST
} else if (METAMASK_DEBUG) {
  defaultProviderConfigType = TESTNET
} else if (env === 'test') {
  defaultProviderConfigType = LOCALHOST
} else {
  defaultProviderConfigType = MAINNET
}

const defaultProviderConfig = {
  type: defaultProviderConfigType,
}

const defaultNetworkConfig = {
  ticker: 'CFX',
}

export default class NetworkController extends EventEmitter {
  constructor (opts = {}) {
    super()

    // parse options
    const providerConfig = opts.provider || defaultProviderConfig
    // create stores
    this.providerStore = new ObservableStore(providerConfig)
    this.networkStore = new ObservableStore('loading')
    this.networkConfig = new ObservableStore(defaultNetworkConfig)
    this.store = new ComposedStore({
      provider: this.providerStore,
      network: this.networkStore,
      settings: this.networkConfig,
    })
    this.on('networkDidChange', this.lookupNetwork)
    // provider and block tracker
    this._provider = null
    this._blockTracker = null
    // provider and block tracker proxies - because the network changes
    this._providerProxy = null
    this._blockTrackerProxy = null
  }

  initializeProvider (providerParams) {
    this._baseProviderParams = providerParams
    const {
      type,
      rpcTarget,
      chainId,
      ticker,
      nickname,
    } = this.providerStore.getState()
    this._configureProvider({ type, rpcTarget, chainId, ticker, nickname })
    this.lookupNetwork()
  }

  // return the proxies so the references will always be good
  getProviderAndBlockTracker () {
    const provider = this._providerProxy
    const blockTracker = this._blockTrackerProxy
    return { provider, blockTracker }
  }

  verifyNetwork () {
    // Check network when restoring connectivity:
    if (this.isNetworkLoading()) {
      this.lookupNetwork()
    }
  }

  getNetworkState () {
    return this.networkStore.getState()
  }

  getNetworkConfig () {
    return this.networkConfig.getState()
  }

  setNetworkState (network, type) {
    if (network === 'loading') {
      return this.networkStore.putState(network)
    }

    // type must be defined
    if (!type) {
      return
    }
    network =
      networks.networkList[type] && networks.networkList[type].chainId
        ? networks.networkList[type].chainId
        : network
    if (type === MAINNET) {
      network = '0'
    } else if (type === TESTNET) {
      network = '1'
    }

    return this.networkStore.putState(network)
  }

  isNetworkLoading () {
    return this.getNetworkState() === 'loading'
  }

  lookupNetwork () {
    // Prevent firing when provider is not defined.
    if (!this._provider) {
      return log.warn(
        'NetworkController - lookupNetwork aborted due to missing provider'
      )
    }
    const { type } = this.providerStore.getState()
    const ethQuery = new EthQuery(this._provider)
    const initialNetwork = this.getNetworkState()
    ethQuery.sendAsync({ method: 'cfx_epochNumber' }, (err, network) => {
      const currentNetwork = this.getNetworkState()
      if (initialNetwork === currentNetwork) {
        if (err) {
          return this.setNetworkState('loading')
        }
        log.info('web3.getNetwork returned ' + network)
        this.setNetworkState(network, type)
      }
    })
  }

  setRpcTarget (rpcTarget, chainId, ticker = 'CFX', nickname = '', rpcPrefs) {
    const providerConfig = {
      type: 'rpc',
      rpcTarget,
      chainId,
      ticker,
      nickname,
      rpcPrefs,
    }
    this.providerConfig = providerConfig
  }

  async setProviderType (type, rpcTarget = '', ticker = 'CFX', nickname = '') {
    assert(
      type === MAINNET ||
        type === LOCALHOST ||
        type === TESTNET ||
        type === 'rpc',
      `NetworkController - cannot call "setProviderType" with type 'rpc'. use "setRpcTarget"`
    )
    assert(
      type === MAINNET || type === LOCALHOST || type === TESTNET,
      `NetworkController - Unknown rpc type "${type}"`
    )
    // assert(INFURA_PROVIDER_TYPES.includes(type) || type === LOCALHOST, `NetworkController - Unknown rpc type "${type}"`)
    const providerConfig = { type, rpcTarget, ticker, nickname }
    this.providerConfig = providerConfig
  }

  resetConnection () {
    this.providerConfig = this.getProviderConfig()
  }

  set providerConfig (providerConfig) {
    this.providerStore.updateState(providerConfig)
    this._switchNetwork(providerConfig)
  }

  getProviderConfig () {
    return this.providerStore.getState()
  }

  //
  // Private
  //

  _switchNetwork (opts) {
    this.setNetworkState('loading')
    this._configureProvider(opts)
    this.emit('networkDidChange', opts.type)
  }

  _configureProvider (opts) {
    const { type, rpcTarget, chainId, ticker, nickname } = opts
    // infura type-based endpoints
    // const isInfura = INFURA_PROVIDER_TYPES.includes(type)
    // if (isInfura) {
    //   this._configureInfuraProvider(opts)
    // other type-based rpc endpoints
    if (type === MAINNET) {
      this._configureStandardProvider({
        rpcUrl: CONFLUX_MAINNET,
        chainId: 0,
        ticker: 'CFX',
        nickname: 'mainnet',
        type,
      })
    } else if (type === TESTNET) {
      this._configureStandardProvider({
        rpcUrl: CONFLUX_TEST_NET,
        chainId: 1,
        ticker: 'CFX',
        nickname: 'testnet',
        type,
      })
    } else if (type === LOCALHOST) {
      this._configureLocalhostProvider()
      // url-based rpc endpoints
    } else if (type === 'rpc') {
      this._configureStandardProvider({
        rpcUrl: rpcTarget,
        chainId,
        ticker,
        nickname,
        type,
      })
    } else {
      throw new Error(
        `NetworkController - _configureProvider - unknown type "${type}"`
      )
    }
  }

  // _configureInfuraProvider ({ type }) {
  //   log.info('NetworkController - configureInfuraProvider', type)
  //   const networkClient = createInfuraClient({
  //     network: type,
  //   })
  //   this._setNetworkClient(networkClient)
  //   // setup networkConfig
  //   const settings = {
  //     ticker: 'ETH',
  //   }
  //   this.networkConfig.putState(settings)
  // }

  _configureLocalhostProvider () {
    log.info('NetworkController - configureLocalhostProvider')
    const networkClient = createLocalhostClient()
    this._setNetworkClient(networkClient)
  }

  _configureStandardProvider ({ rpcUrl, chainId, ticker, nickname, type }) {
    log.info('NetworkController - configureStandardProvider', rpcUrl)
    const networkClient = createJsonRpcClient({ rpcUrl })
    // hack to add a 'rpc' network with chainId
    networks.networkList[type || 'rpc'] = {
      chainId: chainId,
      rpcUrl,
      ticker: ticker || 'CFX',
      nickname,
    }

    // setup networkConfig
    let settings = {
      network: chainId,
    }
    settings = Object.assign(settings, networks.networkList['rpc'])
    this.networkConfig.putState(settings)
    this._setNetworkClient(networkClient)
  }

  _setNetworkClient ({ networkMiddleware, blockTracker, rpcUrl }) {
    const metamaskMiddleware = createMetamaskMiddleware(
      this._baseProviderParams
    )
    const engine = new JsonRpcEngine()
    engine._rpcUrl = rpcUrl
    engine.push(metamaskMiddleware)
    engine.push(networkMiddleware)
    const provider = providerFromEngine(engine)
    provider._confluxWebProvider = { url: rpcUrl }
    this._setProviderAndBlockTracker({ provider, blockTracker })
  }

  _setProviderAndBlockTracker ({ provider, blockTracker }) {
    // update or intialize proxies
    if (this._providerProxy) {
      this._providerProxy.setTarget(provider)
    } else {
      this._providerProxy = createSwappableProxy(provider)
    }
    if (this._blockTrackerProxy) {
      this._blockTrackerProxy.setTarget(blockTracker)
    } else {
      this._blockTrackerProxy = createEventEmitterProxy(blockTracker, {
        eventFilter: 'skipInternal',
      })
    }
    // set new provider and blockTracker
    this._provider = provider
    this._blockTracker = blockTracker
  }

  _logBlock (block) {
    log.info(
      `BLOCK CHANGED: #${block.number.toString('hex')} 0x${block.hash.toString(
        'hex'
      )}`
    )
    this.verifyNetwork()
  }
}

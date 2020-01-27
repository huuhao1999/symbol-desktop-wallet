/**
 * Copyright 2020 NEM Foundation (https://nem.io)
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *     http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import Vue from 'vue';
import {
  Address,
  QueryParams,
  Listener,
  Mosaic,
  UInt64,
  Transaction,
  SignedTransaction,
  TransactionService,
  AggregateTransaction,
} from 'nem2-sdk'
import {Subscription, Observable, from} from 'rxjs'
import {map} from 'rxjs/operators'

// internal dependencies
import {$eventBus} from '../main'
import {CacheKey} from '@/core/utils/CacheKey'
import {RESTService} from '@/services/RESTService'
import {WalletsRepository} from '@/repositories/WalletsRepository'
import {AwaitLock} from './AwaitLock';
import { TransactionBroadcastResult } from '@/core/TransactionBroadcastResult';

/**
 * Helper to format transaction group in name of state variable.
 *
 * @internal
 * @param {string} group 
 * @return {string} One of 'confirmedTransactions', 'unconfirmedTransactions' or 'partialTransactions'
 */
const transactionGroupToStateVariable = (
  group: string
): string => {
  let transactionGroup = group.toLowerCase();
  if (transactionGroup === 'unconfirmed'
      || transactionGroup === 'confirmed'
      || transactionGroup === 'partial') {
    transactionGroup = transactionGroup + 'Transactions'
  }
  else {
    throw new Error('Unknown transaction group \'' + group + '\'.')
  }

  return transactionGroup
}

/// region globals
const Lock = AwaitLock.create();
const walletsRepository = new WalletsRepository()
/// end-region globals

/**
 * Type SubscriptionType for Wallet Store
 * @type {SubscriptionType}
 */
type SubscriptionType = {
  listener: Listener,
  subscriptions: Subscription[]
}

/**
 * Type PartialTransactionAnnouncementPayloadType for Wallet Store 
 * @type {PartialTransactionAnnouncementPayloadType}
 */
type PartialTransactionAnnouncementPayloadType = {
  signedLock: SignedTransaction,
  signedPartial: SignedTransaction,
}

/**
 * Wallet Store
 */
export default {
  namespaced: true,
  state: {
    initialized: false,
    currentWallet: '',
    currentWalletAddress: null,
    currentWalletInfo: null,
    currentWalletMosaics: [],
    currentMultisigInfo: null,
    knownWallets: {},
    otherWalletsInfo: {},
    allTransactions: [],
    transactionHashes: [],
    confirmedTransactions: [],
    unconfirmedTransactions: [],
    partialTransactions: [],
    stagedTransactions: [],
    signedTransactions: [],
    transactionCache: {},
    // Subscriptions to websocket channels.
    subscriptions: [],
  },
  getters: {
    getInitialized: state => state.initialized,
    currentWallet: state => state.currentWallet,
    currentWalletAddress: state => state.currentWalletAddress,
    currentWalletInfo: state => state.currentWalletInfo,
    currentWalletMosaics: state => state.currentWalletMosaics,
    currentMultisigInfo: state => state.currentMultisigInfo,
    knownWallets: state => state.knownWallets,
    otherWalletsInfo: state => state.otherWalletsInfo,
    getSubscriptions: state => state.subscriptions,
    transactionHashes: state => state.transactionHashes,
    confirmedTransactions: state => state.confirmedTransactions,
    unconfirmedTransactions: state => state.unconfirmedTransactions,
    partialTransactions: state => state.partialTransactions,
    stagedTransactions: state => state.stagedTransactions,
    signedTransactions: state => state.signedTransactions,
    transactionCache: state => state.transactionCache,
    allTransactions: state => {
      return [].concat(
        state.partialTransactions,
        state.unconfirmedTransactions,
        state.confirmedTransactions,
      )
    },
  },
  mutations: {
    setInitialized: (state, initialized) => { state.initialized = initialized },
    currentWallet: (state, walletName) => Vue.set(state, 'currentWallet', walletName),
    currentWalletAddress: (state, walletAddress) => Vue.set(state, 'currentWalletAddress', walletAddress),
    currentWalletInfo: (state, currentWalletInfo) => Vue.set(state, 'currentWalletInfo', currentWalletInfo),
    currentWalletMosaics: (state, currentWalletMosaics) => Vue.set(state, 'currentWalletMosaics', currentWalletMosaics),
    setKnownWallets: (state, wallets) => Vue.set(state, 'knownWallets', wallets),
    addWalletInfo: (state, walletInfo) => {
      // update storage
      let wallets = state.otherWalletsInfo
      wallets[walletInfo.address.plain()] = walletInfo

      // update state
      Vue.set(state, 'otherWalletsInfo', wallets)
    },
    setMultisigInfo: (state, multisigInfo) => Vue.set(state, 'currentMultisigInfo', multisigInfo),
    transactionHashes: (state, hashes) => Vue.set(state, 'transactionHashes', hashes),
    confirmedTransactions: (state, transactions) => Vue.set(state, 'confirmedTransactions', transactions),
    unconfirmedTransactions: (state, transactions) => Vue.set(state, 'unconfirmedTransactions', transactions),
    partialTransactions: (state, transactions) => Vue.set(state, 'partialTransactions', transactions),
    setSubscriptions: (state, data) => Vue.set(state, 'subscriptions', data),
    addSubscriptions: (state, payload) => {
      if (payload && payload.length) {
        const subscriptions = state.subscriptions
        subscriptions.push(payload)

        Vue.set(state, 'subscriptions', subscriptions)
      }
    },
    addTransactionToCache: (state, payload) => {
      if (payload === undefined) {
        return ;
      }

      // if unknown cache key, JiT creation of collection
      const key  = payload.cacheKey
      const cache = state.transactionCache
      if (! cache.hasOwnProperty(key)) {
        cache[key] = []
      }

      // add transaction to cache
      const hash  = payload.hash
      cache[key].push({hash, transaction: payload.transaction})

      // update state
      Vue.set(state, 'transactionCache', cache)
      return cache
    },
    setStagedTransactions: (state, transactions: Transaction[]) => Vue.set(state, 'stagedTransactions', transactions),
    addStagedTransaction: (state, transaction: Transaction, dependencyHash: string) => {
      // - get previously staged transactions
      const staged = state.stagedTransactions

      // - update instead of push if transaction exists on stage
      const findIndex = staged.findIndex(tx => tx.transactionInfo.hash === transaction.transactionInfo.hash)
      if (undefined !== findIndex) {
        staged[findIndex] = transaction
      }
      // - push transaction on stage (order matters)
      else staged.push(transaction)

      // - update state
      return Vue.set(state, 'stagedTransactions', staged)
    },
    addSignedTransaction: (state, transaction: SignedTransaction) => {
      // - get previously signed transactions
      const signed = state.signedTransactions

      // - update state
      signed.push(transaction)
      return Vue.set(state, 'signedTransactions', signed)
    },
    removeSignedTransaction: (state, transaction: SignedTransaction) => {
      // - get previously signed transactions
      const signed = state.signedTransactions

      // - find transaction by hash and delete
      const findIndex = signed.findIndex(tx => tx.hash === transaction.hash)
      if (undefined !== findIndex) {
        delete signed[findIndex]
      }

      // - use Array.from to reset indexes
      return Vue.set(state, 'signedTransactions', Array.from(signed))
    },
  },
  actions: {
    async initialize({ commit, dispatch, getters }, address) {
      const callback = async () => {
        if (!address || !address.length) {
            return ;
        }

        // fetch account info
        dispatch('REST_FETCH_INFO', address)
        
        // open websocket connections
        dispatch('SUBSCRIBE', address)
        dispatch('RESET_TRANSACTIONS')
        commit('setInitialized', true)
      }
      await Lock.initialize(callback, {commit, dispatch, getters})
    },
    async uninitialize({ commit, dispatch, getters }) {
      const callback = async () => {
        // close websocket connections
        dispatch('UNSUBSCRIBE')
        dispatch('RESET_TRANSACTIONS')
        commit('setInitialized', false)
      }
      await Lock.uninitialize(callback, {commit, dispatch, getters})
    },
/// region scoped actions
    async SET_CURRENT_WALLET({commit, dispatch}, walletName) {

      const currentWallet = walletsRepository.read(walletName)
      commit('currentWallet', currentWallet)
      commit('currentWalletAddress', currentWallet.address())

      // reset store + re-initialize
      await dispatch('uninitialize')
      await dispatch('initialize', currentWallet.address().plain())
      $eventBus.$emit('onWalletChange', currentWallet.address().plain())
    },
    SET_KNOWN_WALLETS({commit}, wallets) {
      commit('setKnownWallets', wallets)
    },
    SET_BALANCES({commit, dispatch, rootGetters}, mosaics) {
      // - read network mosaic
      const networkMosaic = rootGetters['mosaic/networkMosaic']

      // - if there is no mosaics, add network mosaic balance 0
      if (! mosaics.length) {
        mosaics = [new Mosaic(networkMosaic, UInt64.fromUint(0))]
      }
      // - if there is mosaics, set network mosaic on top
      else {
        const currency = mosaics.filter(m => m.id.equals(networkMosaic)).shift()
        mosaics = [currency].concat(mosaics.find(m => !m.id.equals(networkMosaic)) || [])
      }

      commit('currentWalletMosics', mosaics)
    },
    RESET_SUBSCRIPTIONS({commit}) {
      commit('setSubscriptions', [])
    },
    RESET_TRANSACTIONS({commit}) {
      commit('confirmedTransactions', [])
      commit('unconfirmedTransactions', [])
      commit('partialTransactions', [])
    },
    ADD_TRANSACTION({commit, getters}, transactionMessage) {
      if (!transactionMessage || !transactionMessage.group) {
        throw Error('Missing mandatory field \'group\' for action wallet/addTransaction.')
      }

      // format transactionGroup to store variable name
      let transactionGroup = transactionGroupToStateVariable(transactionMessage.group);

      // if transaction hash is known, do nothing
      const hashes = getters['transactionHashes']
      const transaction = transactionMessage.transaction
      const findIterator = hashes.find(hash => hash === transaction.transactionInfo.hash)
      if (findIterator !== undefined) {
        return ; // transaction already known
      }

      // register transaction
      const transactions = getters[transactionGroup]
      transactions.push(transaction)
      hashes.push(transaction.transactionInfo.hash)

      // update state
      commit('addTransactionToCache', {hash: transaction.transactionInfo.hash, transaction})
      commit(transactionGroup, transactions)
      return commit('transactionHashes', hashes)
    },
    REMOVE_TRANSACTION({commit, getters}, transactionMessage) {
      if (!transactionMessage || !transactionMessage.group) {
        throw Error('Missing mandatory field \'group\' for action wallet/removeTransaction.')
      }

      // format transactionGroup to store variable name
      let transactionGroup = transactionGroupToStateVariable(transactionMessage.group);

      // read from store
      const hashes = getters['transactionHashes']
      const transactions = getters[transactionGroup]

      // prepare search
      const transaction = transactionMessage.transaction
      const transactionHash = transaction.meta.hash

      // find transaction in storage
      const findHashIt = hashes.find(hash => hash === transactionHash)
      const findIterator = transactions.find(tx => tx.meta.hash === transactionHash)
      if (findIterator === undefined) {
        return ; // not found, do nothing
      }

      // remove transaction
      delete transactions[findIterator]
      delete hashes[findHashIt]
      commit(transactionGroup, transactions)
      return commit('transactionHashes', hashes)
    },
    ADD_STAGED_TRANSACTION({commit}, stagedTransaction: Transaction) {
      commit('addStagedTransaction', stagedTransaction)
    },
    RESET_TRANSACTION_STAGE({commit}) {
      commit('setStagedTransactions', [])
    },
/**
 * Websocket API
 */
    // Subscribe to latest account transactions.
    async SUBSCRIBE({ commit, dispatch, rootGetters }, address) {
      if (!address || !address.length) {
        return ;
      }

      // use RESTService to open websocket channel subscriptions
      const websocketUrl = rootGetters['network/wsEndpoint']
      const subscriptions: SubscriptionType  = await RESTService.subscribeTransactionChannels(
        {commit, dispatch},
        websocketUrl,
        address,
      )

      // update state of listeners & subscriptions
      commit('addSubscriptions', subscriptions)
    },

    // Unsubscribe from all open websocket connections
    UNSUBSCRIBE({ dispatch, getters }) {
      const subscriptions = getters.getSubscriptions
      subscriptions.map((subscription: SubscriptionType) => {
        // unsubscribe channels
        subscription.subscriptions.map(sub => sub.unsubscribe())

        // close listener
        subscription.listener.close()
      })

      // update state
      dispatch('RESET_SUBSCRIPTIONS')
    },
/**
 * REST API
 */
    async REST_FETCH_TRANSACTIONS({dispatch, getters, rootGetters}, {group, address, pageSize, id}) {
      if (!group || ! ['partial', 'unconfirmed', 'confirmed'].includes(group)) {
        group = 'confirmed'
      }

      if (!address || address.length !== 40) {
        return ;
      }

      // check cache for results
      const cacheKey = CacheKey.create([group, address, pageSize, id])
      const cache = getters.transactionCache
      if (cache.hasOwnProperty(cacheKey)) {
        return cache[cacheKey]
      }

      try {
        // prepare REST parameters
        const currentPeer = rootGetters['network/currentPeer'].url
        const queryParams = new QueryParams(pageSize, id)
        const addressObject = Address.createFromRawAddress(address)

        // fetch transactions from REST gateway
        const accountHttp = RESTService.create('AccountHttp', currentPeer)
        let transactions: Transaction[]
        let blockHeights: number[]

        if ('confirmed' === group) {
          transactions = await accountHttp.getAccountTransactions(addressObject, queryParams).toPromise()
          // - record block height to be fetched
          transactions.map(transaction => blockHeights.push(transaction.transactionInfo.height.compact()))
        }
        else if ('unconfirmed' === group)
          transactions = await accountHttp.getAccountUnconfirmedTransactions(addressObject, queryParams).toPromise()
        else if ('partial' === group)
          transactions = await accountHttp.getAccountPartialTransactions(addressObject, queryParams).toPromise()

        // update store
        transactions.map((transaction) => dispatch('ADD_TRANSACTION', {
          group: group,
          cacheKey: cacheKey,
          transaction
        }))

        // fetch block informations if necessary
        if (blockHeights.length) {
          // - non-blocking
          dispatch('network/REST_FETCH_BLOCKS', blockHeights, {root: true})
        }

        return transactions
      }
      catch (e) {
        console.error('An error happened while trying to fetch transactions: ' + e)
        return false
      }
    },
    async REST_FETCH_INFO({commit, dispatch, getters, rootGetters}, address) {
      if (!address || address.length !== 40) {
        return ;
      }

      try {
        // prepare REST parameters
        const currentPeer = rootGetters['network/currentPeer'].url
        const addressObject = Address.createFromRawAddress(address)

        // fetch account info from REST gateway
        const accountHttp = RESTService.create('AccountHttp', currentPeer)
        const accountInfo = await accountHttp.getAccountInfo(addressObject).toPromise()

        commit('addWalletInfo', accountInfo)

        // update current wallet state if necessary
        if (address === getters.currentWalletAddress.plain()) {
          commit('currentWalletInfo', accountInfo)
          dispatch('SET_BALANCES', accountInfo.mosaics)
        }

        return accountInfo
      }
      catch (e) {
        console.error('An error happened while trying to fetch account information: <pre>' + e + '</pre>')
        return false
      }
    },
    async REST_FETCH_INFOS({commit, rootGetters}, addresses) {
      try {
        // prepare REST parameters
        const currentPeer = rootGetters['network/currentPeer'].url

        // fetch account info from REST gateway
        const accountHttp = RESTService.create('AccountHttp', currentPeer)
        const accountsInfo = await accountHttp.getAccountsInfo(addresses).toPromise()
        accountsInfo.map(info => commit('addWalletInfo', info))
        return accountsInfo
      }
      catch (e) {
        console.error('An error happened while trying to fetch account information: <pre>' + e + '</pre>')
        return false
      }
    },
    async REST_FETCH_MULTISIG({commit, dispatch, getters, rootGetters}, address) {
      if (!address || address.length !== 40) {
        return ;
      }

      try {
        // prepare REST parameters
        const currentPeer = rootGetters['network/currentPeer'].url
        const addressObject = Address.createFromRawAddress(address)

        // fetch account info from REST gateway
        const multisigHttp = RESTService.create('MultisigHttp', currentPeer)
        const multisigInfo = await multisigHttp.getMultisigAccountInfo(addressObject).toPromise()

        commit('setMultisigInfo', multisigInfo)
        return multisigInfo
      }
      catch (e) {
        console.error('An error happened while trying to fetch multisig information: <pre>' + e + '</pre>')
        return false
      }
    },
    REST_ANNOUNCE_PARTIAL(
      {commit, rootGetters},
      {signedLock, signedPartial}
    ): Observable<TransactionBroadcastResult> {
      try {
        // prepare REST parameters
        const currentPeer = rootGetters['network/currentPeer'].url
        const wsEndpoint = rootGetters['network/wsEndpoint']
        const transactionHttp = RESTService.create('TransactionHttp', currentPeer)
        const receiptHttp = RESTService.create('ReceiptHttp', currentPeer)
        const listener = new Listener(wsEndpoint)

        // prepare nem2-sdk TransactionService
        const service = new TransactionService(transactionHttp, receiptHttp)

        // announce lock and aggregate only after lock confirmation
        return service.announceHashLockAggregateBonded(
          signedLock,
          signedPartial,
          listener
        ).pipe(
          map((announcedTransaction: AggregateTransaction) => {
            commit('removeSignedTransaction', signedPartial)
            commit('removeSignedTransaction', signedLock)

            return new TransactionBroadcastResult(signedPartial, true)
          })
        )
      }
      catch(e) {
        return from([
          new TransactionBroadcastResult(signedPartial, false, e.toString()),
        ])
      }
    },
    REST_ANNOUNCE_TRANSACTION(
      {commit, dispatch, rootGetters},
      signedTransaction: SignedTransaction
    ): Observable<TransactionBroadcastResult> {
      try {
        // prepare REST parameters
        const currentPeer = rootGetters['network/currentPeer'].url
        const wsEndpoint = rootGetters['network/wsEndpoint']
        const transactionHttp = RESTService.create('TransactionHttp', currentPeer)
        const receiptHttp = RESTService.create('ReceiptHttp', currentPeer)
        const listener = new Listener(wsEndpoint)

        // prepare nem2-sdk TransactionService
        const service = new TransactionService(transactionHttp, receiptHttp)
        return service.announce(signedTransaction, listener).pipe(
          map((transaction: Transaction) => {
            commit('removeSignedTransaction', signedTransaction)
            return new TransactionBroadcastResult(signedTransaction, true)
          })
        )
      }
      catch(e) {
        return from([
          new TransactionBroadcastResult(signedTransaction, false, e.toString()),
        ])
      }
    },
/// end-region scoped actions
  },
};
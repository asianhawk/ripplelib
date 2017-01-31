'use strict';

var util = require('util');
var lodash = require('lodash');
var EventEmitter = require('events').EventEmitter;
var utils = require('./utils');
var sjcl = require('./utils').sjcl;
var Amount = require('./amount').Amount;
var Currency = require('./amount').Currency;
var UInt160 = require('./amount').UInt160;
var Seed = require('./seed').Seed;
var SerializedObject = require('./serializedobject').SerializedObject;
var RippleError = require('./rippleerror').RippleError;
var hashprefixes = require('./hashprefixes');
var log = require('./log').internal.sub('transaction');

/**
 * @constructor Transaction
 *
 * Notes:
 * All transactions including those with local and malformed errors may be
 * forwarded anyway.
 *
 * A malicous server can:
 *  - may or may not forward
 *  - give any result
 *    + it may declare something correct as incorrect or something incorrect
 *      as correct
 *    + it may not communicate with the rest of the network
 */

function Transaction(remote) {
  EventEmitter.call(this);

  var self = this;
  var remoteExists = typeof remote === 'object';

  this.remote = remote;
  this.tx_json = { Flags: 0 };
  this._secret = undefined;
  this._build_path = false;
  this._maxFee = remoteExists ? this.remote.max_fee : undefined;
  this.state = 'unsubmitted';
  this.finalized = false;
  this.previousSigningHash = undefined;
  this.submitIndex = undefined;
  this.canonical = remoteExists ? this.remote.canonical_signing : true;
  this.submittedIDs = [];
  this.attempts = 0;
  this.submissions = 0;
  this.responses = 0;
  this._maxSignerNum = 8;

  this.once('success', function (message) {
    // Transaction definitively succeeded
    self.setState('validated');
    self.finalize(message);
    if (self._successHandler) {
      self._successHandler(message);
    }
  });

  this.once('error', function (message) {
    // Transaction definitively failed
    self.setState('failed');
    self.finalize(message);
    if (self._errorHandler) {
      self._errorHandler(message);
    }
  });

  this.once('submitted', function () {
    // Transaction was submitted to the network
    self.setState('submitted');
  });

  this.once('proposed', function () {
    // Transaction was submitted successfully to the network
    self.setState('pending');
  });
}

util.inherits(Transaction, EventEmitter);

// This is currently a constant in rippled known as the "base reference"
// https://wiki.ripple.com/Transaction_Fee#Base_Fees
Transaction.fee_units = {
  'default': 10
};

Transaction.flags = {
  // Universal flags can apply to any transaction type
  Universal: {
    FullyCanonicalSig: 0x80000000
  },

  AccountSet: {
    RequireDestTag: 0x00010000,
    OptionalDestTag: 0x00020000,
    RequireAuth: 0x00040000,
    OptionalAuth: 0x00080000,
    DisallowXRP: 0x00100000,
    AllowXRP: 0x00200000
  },

  TrustSet: {
    SetAuth: 0x00010000,
    SetNoRipple: 0x00020000,
    ClearNoRipple: 0x00040000,
    SetFreeze: 0x00100000,
    ClearFreeze: 0x00200000
  },

  OfferCreate: {
    Passive: 0x00010000,
    ImmediateOrCancel: 0x00020000,
    FillOrKill: 0x00040000,
    Sell: 0x00080000
  },

  Payment: {
    NoRippleDirect: 0x00010000,
    PartialPayment: 0x00020000,
    LimitQuality: 0x00040000
  }
};

// The following are integer (as opposed to bit) flags
// that can be set for particular transactions in the
// SetFlag or ClearFlag field
Transaction.set_clear_flags = {
  AccountSet: {
    asfRequireDest: 1,
    asfRequireAuth: 2,
    asfDisallowXRP: 3,
    asfDisableMaster: 4,
    asfAccountTxnID: 5,
    asfNoFreeze: 6,
    asfGlobalFreeze: 7,
    asfDefaultRipple: 8
  }
};

Transaction.MEMO_TYPES = {};

/* eslint-disable max-len */

// URL characters per RFC 3986
Transaction.MEMO_REGEX = /^[0-9a-zA-Z-\.\_\~\:\/\?\#\[\]\@\!\$\&\'\(\)\*\+\,\;\=\%]+$/;
/* eslint-enable max-len */

Transaction.formats = require('./binformat').tx;

Transaction.prototype.consts = {
  telLOCAL_ERROR: -399,
  temMALFORMED: -299,
  tefFAILURE: -199,
  terRETRY: -99,
  tesSUCCESS: 0,
  tecCLAIMED: 100
};

Transaction.prototype.isTelLocal = function (ter) {
  return ter >= this.consts.telLOCAL_ERROR && ter < this.consts.temMALFORMED;
};

Transaction.prototype.isTemMalformed = function (ter) {
  return ter >= this.consts.temMALFORMED && ter < this.consts.tefFAILURE;
};

Transaction.prototype.isTefFailure = function (ter) {
  return ter >= this.consts.tefFAILURE && ter < this.consts.terRETRY;
};

Transaction.prototype.isTerRetry = function (ter) {
  return ter >= this.consts.terRETRY && ter < this.consts.tesSUCCESS;
};

Transaction.prototype.isTepSuccess = function (ter) {
  return ter >= this.consts.tesSUCCESS;
};

Transaction.prototype.isTecClaimed = function (ter) {
  return ter >= this.consts.tecCLAIMED;
};

Transaction.prototype.isRejected = function (ter) {
  return this.isTelLocal(ter) || this.isTemMalformed(ter) || this.isTefFailure(ter);
};

Transaction.from_json = function (j) {
  return new Transaction().parseJson(j);
};

Transaction.prototype.parseJson = function (v) {
  this.tx_json = v;
  return this;
};

/**
 * Set state on the condition that the state is different
 *
 * @param {String} state
 */

Transaction.prototype.setState = function (state) {
  if (this.state !== state) {
    this.state = state;
    this.emit('state', state);
  }
};

/**
 * Finalize transaction. This will prevent future activity
 *
 * @param {Object} message
 * @api private
 */

Transaction.prototype.finalize = function (message) {
  this.finalized = true;

  if (this.result) {
    this.result.ledger_index = message.ledger_index;
    this.result.ledger_hash = message.ledger_hash;
  } else {
    this.result = message;
    this.result.tx_json = this.tx_json;
  }

  this.emit('cleanup');
  this.emit('final', message);

  if (this.remote && this.remote.trace) {
    log.info('transaction finalized:', this.tx_json, this.getManager()._pending.getLength());
  }

  return this;
};

/**
 * Get transaction Account
 *
 * @return {Account}
 */

Transaction.prototype.getAccount = function () {
  return this.tx_json.Account;
};

/**
 * Get TransactionType
 *
 * @return {String}
 */

Transaction.prototype.getType = Transaction.prototype.getTransactionType = function () {
  return this.tx_json.TransactionType;
};

/**
 * Get transaction TransactionManager
 *
 * @param [String] account
 * @return {TransactionManager]
 */

Transaction.prototype.getManager = function (account_) {
  if (!this.remote) {
    return undefined;
  }

  var account = account_ || this.tx_json.Account;
  return this.remote.account(account)._transactionManager;
};

/**
 * Get keypair for signing.
 *
 * @param [String] account
 */
Transaction.prototype.getKey =
Transaction.prototype.getKeyPair =
Transaction.prototype._accountKeyPair = function(account_) {
  if (!this.remote || this._secret) {
    return this.generateKey();
  }

  var account = account_ || this.tx_json.Account;
  return this.remote.getKey(account);
}

Transaction.prototype.generateKey =
Transaction.prototype.generateKeyPair = function(secret) {
  secret = secret || this._secret;
  try {
    return Seed.from_json(secret).get_key();
  } catch(e) {
    throw new Error('Invalid Secret!');
  }
}

/**
 * Get transaction secret
 *
 * @param [String] account
 */

Transaction.prototype.getSecret = Transaction.prototype._accountSecret = function (account_) {
  if (!this.remote) {
    return undefined;
  }

  var account = account_ || this.tx_json.Account;
  return this.remote.secrets[account];
};

/**
 * Returns the number of fee units this transaction will cost.
 *
 * Each Ripple transaction based on its type and makeup costs a certain number
 * of fee units. The fee units are calculated on a per-server basis based on the
 * current load on both the network and the server.
 *
 * @see https://ripple.com/wiki/Transaction_Fee
 *
 * @return {Number} Number of fee units for this transaction.
 */

Transaction.prototype._getFeeUnits = Transaction.prototype.feeUnits = function () {
  return Transaction.fee_units['default'];
};

/**
 * Compute median server fee
 *
 * @return {String} median fee
 */

Transaction.prototype._computeFee = function () {
  if (!this.remote) {
    return undefined;
  }

  var servers = this.remote._servers;
  var fees = [];

  for (var i = 0; i < servers.length; i++) {
    var server = servers[i];
    if (server.isConnected()) {
      fees.push(Number(server._computeFee(this._getFeeUnits())));
    }
  }

  switch (fees.length) {
    case 0:
      return undefined;
    case 1:
      return String(fees[0]);
  }

  fees.sort(function ascending(a, b) {
    if (a > b) {
      return 1;
    } else if (a < b) {
      return -1;
    }
    return 0;
  });

  var midInd = Math.floor(fees.length / 2);

  var median = fees.length % 2 === 0 ? Math.floor(0.5 + (fees[midInd] + fees[midInd - 1]) / 2) : fees[midInd];

  return String(median);
};

/**
 * Attempts to complete the transaction for submission.
 *
 * This function seeks to fill out certain fields, such as Fee and
 * SigningPubKey, which can be determined by the library based on network
 * information and other fields.
 *
 * @return {Boolean|Transaction} If succeeded, return transaction. Otherwise
 * return `false`
 */

Transaction.prototype.complete = function () {
  if (this.remote) {
    if (!this.remote.trusted && !this.remote.local_signing) {
      this.emit('error', new RippleError('tejServerUntrusted', 'Attempt to give secret to untrusted server'));
      return false;
    }
  }

  if (typeof this.tx_json.SigningPubKey === 'undefined') {
    if (this._multiSign) { 
      this.tx_json.SigningPubKey = ''; 
    } else {
      try {
        var key = this.getKey();
        this.tx_json.SigningPubKey = key.to_hex_pub();
      } catch (e) {
        this.emit('error', new RippleError('tejSecretInvalid', 'Invalid secret'));
        return false;
      }
    }
  }

  // If the Fee hasn't been set, one needs to be computed by
  // an assigned server
  if (this.remote && typeof this.tx_json.Fee === 'undefined') {
    if (this.remote.local_fee || !this.remote.trusted) {
      var fee = this._computeFee();
      if (!fee) {
        this.emit('error', new RippleError('tejUnconnected'));
        return false;
      }
      if (Number(fee) > this._maxFee) fee = String(this._maxFee);
      if (this._multiSign) {
        var num = this._signerNum || 2; //default to 2-signatures
        this.tx_json.Fee = String(Number(fee) * (num + 1));
      } else {
        this.tx_json.Fee = fee;  
      }      
    }
  }

  // Set canonical flag - this enables canonicalized signature checking
  if (this.remote && this.remote.local_signing && this.canonical) {
    this.tx_json.Flags |= Transaction.flags.Universal.FullyCanonicalSig;

    // JavaScript converts operands to 32-bit signed ints before doing bitwise
    // operations. We need to convert it back to an unsigned int.
    this.tx_json.Flags = this.tx_json.Flags >>> 0;
  }

  return this.tx_json;
};

Transaction.prototype.serialize = function () {
  return SerializedObject.from_json(this.tx_json);
};

Transaction.prototype.signingHash = function (testnet) {
  return this.hash(testnet ? 'HASH_TX_SIGN_TESTNET' : 'HASH_TX_SIGN');
};

Transaction.prototype.hash = function (prefix_, asUINT256, serialized) {
  var prefix = undefined;

  if (typeof prefix_ !== 'string') {
    prefix = hashprefixes.HASH_TX_ID;
  } else if (!hashprefixes.hasOwnProperty(prefix_)) {
    throw new Error('Unknown hashing prefix requested: ' + prefix_);
  } else {
    prefix = hashprefixes[prefix_];
  }

  var hash = (serialized || this.serialize()).hash(prefix);

  return asUINT256 ? hash : hash.to_hex();
};

Transaction.prototype.sign = function (testnet) {
  if (this._multiSign) return this;

  var prev_sig = this.tx_json.TxnSignature;
  delete this.tx_json.TxnSignature;
  var hash = this.signingHash(testnet);

  // If the hash is the same, we can re-use the previous signature
  if (prev_sig && hash === this.previousSigningHash) {
    this.tx_json.TxnSignature = prev_sig;
    return this;
  }

  var key = this.getKey();
  var sig = key.sign(hash);
  var hex = sjcl.codec.hex.fromBits(sig).toUpperCase();

  this.tx_json.TxnSignature = hex;
  this.previousSigningHash = hash;

  return this;
};

Transaction.prototype.multiSigningHash = function(account) {
  var prev_sig = this.tx_json.Signers;
  delete this.tx_json.Signers;

  var prefix = hashprefixes['HASH_TX_MULTISIGN'];
  var suffix = UInt160.from_json(account).to_bytes();
  var hash = this.serialize().hash(prefix, suffix);

  this.tx_json.Signers = prev_sig;
  return hash.to_hex();
};

Transaction.prototype.getSignatureFor = function(account) {
  var signer = {
    Signer : {
      Account : account,
      SigningPubKey : '',
      TxnSignature : ''
    }
  }

  var prev_sig = this.tx_json.Signers;
  delete this.tx_json.Signers;

  var hash = this.multiSigningHash(account);

  var key = this.getKey(account);
  var sig = key.sign(hash, 0);
  var hex = sjcl.codec.hex.fromBits(sig).toUpperCase();

  signer.Signer.SigningPubKey = key.to_hex_pub();
  signer.Signer.TxnSignature = hex;
  this.tx_json.Signers = prev_sig;

  return signer;
}

Transaction.prototype.multiSignFor = function(account) {
  this.addSignature(this.getSignatureFor(account));
  return this;
}

Transaction.prototype.addSignature = function(signer) {
  if (! Array.isArray(this.tx_json.Signers)) {
    this.tx_json.Signers = [];  
  }
  this.tx_json.Signers.push(signer);
  if (this.tx_json.Signers.length > this._maxSignerNum) {
    throw new Error('Maximum Number of Signatures Exceeded.');
  }
  this.sortSigners();
  return this;
}

Transaction.prototype.sortSigners = function() {
  if (! Array.isArray(this.tx_json.Signers)) return;
  this.tx_json.Signers.sort(function(a,b){
    return UInt160.from_json(a.Signer.Account)._value.greaterEquals(UInt160.from_json(b.Signer.Account)._value);
  });
  return this;
}

Transaction.prototype.clearSignatures = function() {
  this.tx_json.Signers = []
  return this;
}

Transaction.prototype.setMultiSign = function(sigNum) {
  this._multiSign = true;
  if (typeof sigNum === 'number') this._signerNum = sigNum;
  return this;
}

Transaction.prototype.isMultiSign = function() {
  return this._multiSign;
}

/**
 * Add an ID to cached list of submitted IDs
 *
 * @param {String} transaction id
 * @api private
 */

Transaction.prototype.addId = function (id) {
  if (!lodash.contains(this.submittedIDs, id)) {
    this.submittedIDs.unshift(id);
  }
};

/**
 * Find ID within cached received (validated) IDs. If this transaction has
 * an ID that is within the cache, it has been seen validated, so return the
 * received message
 *
 * @param {Object} cache
 * @return {Object} message
 * @api private
 */

Transaction.prototype.findId = function (cache) {
  var cachedTransactionID = lodash.detect(this.submittedIDs, function (id) {
    return cache.hasOwnProperty(id);
  });
  return cache[cachedTransactionID];
};

/**
 * Set client ID. This is an identifier specified by the user of the API to
 * identify a transaction in the event of a disconnect. It is not currently
 * persisted in the transaction itself, but used offline for identification.
 * In applications that require high reliability, client-specified ID should
 * be persisted such that one could map it to submitted transactions. Use
 * .summary() for a consistent transaction summary output for persisitng. In
 * the future, this ID may be stored in the transaction itself (in the ledger)
 *
 * @param {String} id
 */

Transaction.prototype.setClientID = Transaction.prototype.clientID = function (id) {
  if (typeof id === 'string') {
    this._clientID = id;
  }
  return this;
};

/**
 * Set LastLedgerSequence as the absolute last ledger sequence the transaction
 * is valid for. LastLedgerSequence is set automatically if not set using this
 * method
 *
 * @param {Number} ledger index
 */

Transaction.prototype.setLastLedgerSequence = Transaction.prototype.setLastLedger = Transaction.prototype.lastLedger = function (sequence) {
  this._setUInt32('LastLedgerSequence', sequence);
  this._setLastLedger = true;
  return this;
};

/**
 * Set max fee. The maximum fee to be paid during high load condition.
 * Specified fee must be >= 0.
 *
 * @param {Number} fee The proposed fee
 */

Transaction.prototype.setMaxFee = Transaction.prototype.maxFee = function (fee) {
  if (typeof fee === 'number' && fee >= 0) {
    this._setMaxFee = true;
    this._maxFee = fee;
  }
  return this;
};

/*
 * Set the fee user will pay to the network for submitting this transaction.
 * Specified fee must be >= 0.
 *
 * @param {Number} fee The proposed fee
 *
 * @returns {Transaction} calling instance for chaining
 */
Transaction.prototype.setFixedFee = function (fee) {
  if (typeof fee === 'number' && fee >= 0) {
    this._setFixedFee = true;
    this.tx_json.Fee = String(fee);
  }

  return this;
};

/**
 * Set secret If the secret has been set with Remote.setSecret, it does not
 * need to be provided
 *
 * @param {String} secret
 */

Transaction.prototype.setSecret = Transaction.prototype.secret = function (secret) {
  if (typeof secret === 'string') {
    this._secret = secret;
  }
  return this;
};

Transaction.prototype.setType = function (type) {
  if (lodash.isUndefined(Transaction.formats, type)) {
    throw new Error('TransactionType must be a valid transaction type');
  }

  this.tx_json.TransactionType = type;

  return this;
};

Transaction.prototype._setUInt32 = function (name, value, options_) {
  var options = lodash.merge({}, options_);
  var isValidUInt32 = typeof value === 'number' && value >= 0 && value < Math.pow(256, 4);

  if (!isValidUInt32) {
    throw new Error(name + ' must be a valid UInt32');
  }
  if (!lodash.isUndefined(options.min_value) && value < options.min_value) {
    throw new Error(name + ' must be >= ' + options.min_value);
  }

  this.tx_json[name] = value;

  return this;
};

/**
 * Set SourceTag
 *
 * @param {Number} source tag
 */

Transaction.prototype.setSourceTag = Transaction.prototype.sourceTag = function (tag) {
  return this._setUInt32('SourceTag', tag);
};

Transaction.prototype._setAccount = function (name, value) {
  var uInt160 = UInt160.from_json(value);

  if (!uInt160.is_valid()) {
    throw new Error(name + ' must be a valid account');
  }

  this.tx_json[name] = uInt160.to_json();

  return this;
};

Transaction.prototype.setAccount = function (account) {
  return this._setAccount('Account', account);
};

Transaction.prototype._setAmount = function (name, amount, options_) {
  var options = lodash.merge({ no_native: false }, options_);
  var parsedAmount = Amount.from_json(amount);

  if (parsedAmount.is_negative()) {
    throw new Error(name + ' value must be non-negative');
  }

  var isNative = parsedAmount.currency().is_native();

  if (isNative && options.no_native) {
    throw new Error(name + ' must be a non-native amount');
  }
  if (!(isNative || parsedAmount.currency().is_valid())) {
    throw new Error(name + ' must have a valid currency');
  }
  if (!(isNative || parsedAmount.issuer().is_valid())) {
    throw new Error(name + ' must have a valid issuer');
  }

  this.tx_json[name] = parsedAmount.to_json();

  return this;
};

Transaction.prototype._setHash256 = function (name, value, options_) {
  if (typeof value !== 'string') {
    throw new Error(name + ' must be a valid Hash256');
  }

  var options = lodash.merge({ pad: false }, options_);
  var hash256 = value;

  if (options.pad) {
    while (hash256.length < 64) {
      hash256 += '0';
    }
  }

  if (!/^[0-9A-Fa-f]{64}$/.test(hash256)) {
    throw new Error(name + ' must be a valid Hash256');
  }

  this.tx_json[name] = hash256;

  return this;
};

Transaction.prototype.setAccountTxnID = Transaction.prototype.accountTxnID = function (id) {
  return this._setHash256('AccountTxnID', id);
};

/**
 * Set Flags. You may specify flags as a number, as the string name of the
 * flag, or as an array of strings.
 *
 * setFlags(Transaction.flags.AccountSet.RequireDestTag)
 * setFlags('RequireDestTag')
 * setFlags('RequireDestTag', 'RequireAuth')
 * setFlags([ 'RequireDestTag', 'RequireAuth' ])
 *
 * @param {Number|String|Array} flags
 */

Transaction.prototype.setFlags = function (flags) {
  if (flags === undefined) {
    return this;
  }

  if (typeof flags === 'number') {
    this.tx_json.Flags = flags;
    return this;
  }

  var transaction_flags = Transaction.flags[this.getType()] || {};
  var flag_set = Array.isArray(flags) ? flags : [].slice.call(arguments);

  for (var i = 0, l = flag_set.length; i < l; i++) {
    var flag = flag_set[i];

    if (transaction_flags.hasOwnProperty(flag)) {
      this.tx_json.Flags += transaction_flags[flag];
    } else {
      // XXX Should throw?
      this.emit('error', new RippleError('tejInvalidFlag'));
      return this;
    }
  }

  return this;
};

/**
 * Add a Memo to transaction.
 *
 * @param [String] memoType
 * - describes what the data represents, must contain valid URL characters
 * @param [String] memoFormat
 * - describes what format the data is in, MIME type, must contain valid URL
 * - characters
 * @param [String] memoData
 * - data for the memo, can be any JS object. Any object other than string will
 *   be stringified (JSON) for transport
 */

Transaction.prototype.addMemo = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);
  } else {
    options = {
      memoType: arguments[0],
      memoFormat: arguments[1],
      memoData: arguments[2]
    };
  }

  function convertStringToHex(string) {
    var utf8String = sjcl.codec.utf8String.toBits(string);
    return sjcl.codec.hex.fromBits(utf8String).toUpperCase();
  }

  var memo = {};
  var memoRegex = Transaction.MEMO_REGEX;
  var memoType = options.memoType;
  var memoFormat = options.memoFormat;
  var memoData = options.memoData;

  if (memoType) {
    if (!(lodash.isString(memoType) && memoRegex.test(memoType))) {
      throw new Error('MemoType must be a string containing only valid URL characters');
    }
    if (Transaction.MEMO_TYPES[memoType]) {
      // XXX Maybe in the future we want a schema validator for
      // memo types
      memoType = Transaction.MEMO_TYPES[memoType];
    }
    memo.MemoType = convertStringToHex(memoType);
  }

  if (memoFormat) {
    if (!(lodash.isString(memoFormat) && memoRegex.test(memoFormat))) {
      throw new Error('MemoFormat must be a string containing only valid URL characters');
    }

    memo.MemoFormat = convertStringToHex(memoFormat);
  }

  if (memoData) {
    if (typeof memoData !== 'string') {
      if (lodash.isString(memoFormat) && memoFormat.toLowerCase() == 'json') {
        try {
          memoData = JSON.stringify(memoData);
        } catch (e) {
          throw new Error('MemoFormat json with invalid JSON in MemoData field');
        }
      } else {
        throw new Error('MemoData can only be a JSON object with a valid json MemoFormat');
      }
    }
    if (lodash.isString(memoFormat) && memoFormat.toLowerCase() == 'hex') {
      // no need to convert data that's already in hex
      if (/^[0-9a-fA-F]+$/.test(memoData)){
        memo.MemoData = memoData;
      } else {
        throw new Error('MemoFormat hex with invalid Hex String in MemoData field');
      }
    } else {
      memo.MemoData = convertStringToHex(memoData);
    }
    
  }

  this.tx_json.Memos = (this.tx_json.Memos || []).concat({ Memo: memo });

  return this;
};

/**
 * Construct an 'AccountSet' transaction
 *
 * Note that bit flags can be set using the .setFlags() method but for
 * 'AccountSet' transactions there is an additional way to modify AccountRoot
 * flags. The values available for the SetFlag and ClearFlag are as follows:
 *
 * asfRequireDest:    Require a destination tag
 * asfRequireAuth:    Authorization is required to extend trust
 * asfDisallowXRP:    XRP should not be sent to this account
 * asfDisableMaster:  Disallow use of the master key
 * asfNoFreeze:       Permanently give up the ability to freeze individual
 *                    trust lines. This flag can never be cleared.
 * asfGlobalFreeze:   Freeze all assets issued by this account
 *
 * @param [String] set flag
 * @param [String] clear flag
 */

Transaction.prototype.accountSet = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src;
    }
    if (lodash.isUndefined(options.set_flag)) {
      options.set_flag = options.set;
    }
    if (lodash.isUndefined(options.clear_flag)) {
      options.clear_flag = options.clear;
    }
  } else {
    options = {
      account: arguments[0],
      set_flag: arguments[1],
      clear_flag: arguments[2]
    };
  }

  this.setType('AccountSet');
  this.setAccount(options.account);

  if (!lodash.isUndefined(options.set_flag)) {
    this.setSetFlag(options.set_flag);
  }
  if (!lodash.isUndefined(options.clear_flag)) {
    this.setClearFlag(options.clear_flag);
  }

  return this;
};

Transaction.prototype.setAccountSetFlag = function (name, value) {
  // if (this.getType() !== 'AccountSet') {
  // throw new Error('TransactionType must be AccountSet to use ' + name);
  // }

  var accountSetFlags = Transaction.set_clear_flags.AccountSet;
  var flagValue = value;

  if (typeof flagValue === 'string') {
    flagValue = /^asf/.test(flagValue) ? accountSetFlags[flagValue] : accountSetFlags['asf' + flagValue];
  }

  if (!lodash.contains(lodash.values(accountSetFlags), flagValue)) {
    throw new Error(name + ' must be a valid AccountSet flag');
  }

  this.tx_json[name] = flagValue;

  return this;
};

Transaction.prototype.setSetFlag = function (flag) {
  return this.setAccountSetFlag('SetFlag', flag);
};

Transaction.prototype.setClearFlag = function (flag) {
  return this.setAccountSetFlag('ClearFlag', flag);
};

/**
 * Set TransferRate for AccountSet
 *
 * @param {Number} transfer rate
 */

Transaction.prototype.setTransferRate = Transaction.prototype.transferRate = function (rate) {
  /* eslint-disable max-len */
  // if (this.getType() !== 'AccountSet') {
  // throw new Error('TransactionType must be AccountSet to use TransferRate');
  // }
  /* eslint-enable max-len */

  var transferRate = rate;

  if (transferRate === 0) {
    // Clear TransferRate
    this.tx_json.TransferRate = transferRate;
    return this;
  }

  // if (rate >= 1 && rate < 2) {
  // transferRate *= 1e9;
  // }

  return this._setUInt32('TransferRate', transferRate, { min_value: 1e9 });
};

/**
 * Construct a 'SetRegularKey' transaction
 *
 * If the RegularKey is set, the private key that corresponds to it can be
 * used to sign transactions instead of the master key
 *
 * The RegularKey must be a valid Ripple Address, or a Hash160 of the public
 * key corresponding to the new private signing key.
 *
 * @param {String} account
 * @param {String} regular key
 */

Transaction.prototype.setRegularKey = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src;
    }
  } else {
    options = {
      account: arguments[0],
      regular_key: arguments[1]
    };
  }

  this.setType('SetRegularKey');
  this.setAccount(options.account);

  if (!lodash.isUndefined(options.regular_key)) {
    this._setAccount('RegularKey', options.regular_key);
  }

  return this;
};


/**
 * Construct a 'SignerListSet' transaction
 *
 * @param {String} account
 * @param {Array} signers object in the form {address, weight}
 * @param {Number} quorum
 */

Transaction.prototype.signerListSet = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src;
    }
  } else {
    options = {
      account: arguments[0],
      signers: arguments[1],
      quorum: arguments[2]
    };
  }

  this.setType('SignerListSet');
  this.setAccount(options.account);

  function formatSignerEntry (signer) {
    var uInt160 = UInt160.from_json(signer.address);
    if (!uInt160.is_valid()) {
      throw new Error('signer.address must be a valid account');
    }
    var value = signer.weight;
    var isValidUInt32 = typeof value === 'number' && value >= 0 && value < Math.pow(256, 4);
    if (!isValidUInt32) {
      throw new Error('signer.weight must be a valid UInt32');
    }
    return {
      SignerEntry: {
        Account: uInt160.to_json(),
        SignerWeight: value
      }      
    }
  }

  if (!lodash.isUndefined(options.signers) && options.quorum) {
    if (options.signers.length > 8) throw new Error('signer members must not more 8.');
    this.tx_json.SignerEntries = lodash.map(options.signers, formatSignerEntry);
  }

  if (!lodash.isUndefined(options.quorum)) {
    this._setUInt32('SignerQuorum', options.quorum);
  }

  return this;
};

/**
 * Construct a 'TrustSet' transaction
 *
 * @param {String} account
 * @param [Amount] limit
 * @param [Number] quality in
 * @param [Number] quality out
 */

Transaction.prototype.trustSet = Transaction.prototype.rippleLineSet = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src;
    }
  } else {
    options = {
      account: arguments[0],
      limit: arguments[1],
      quality_in: arguments[2],
      quality_out: arguments[3]
    };
  }

  this.setType('TrustSet');
  this.setAccount(options.account);

  if (!lodash.isUndefined(options.limit)) {
    this.setLimit(options.limit);
  }
  if (!lodash.isUndefined(options.quality_in)) {
    this.setQualityIn(options.quality_in);
  }
  if (!lodash.isUndefined(options.quality_out)) {
    this.setQualityOut(options.quality_out);
  }

  // XXX Throw an error if nothing is set.

  return this;
};

Transaction.prototype.setLimit = function (amount) {
  // if (this.getType() !== 'TrustSet') {
  // throw new Error('TransactionType must be TrustSet to use LimitAmount');
  // }

  return this._setAmount('LimitAmount', amount, { no_native: true });
};

Transaction.prototype.setQualityIn = function (quality) {
  // if (this.getType() !== 'TrustSet') {
  // throw new Error('TransactionType must be TrustSet to use QualityIn');
  // }

  return this._setUInt32('QualityIn', quality);
};

Transaction.prototype.setQualityOut = function (quality) {
  // if (this.getType() !== 'TrustSet') {
  // throw new Error('TransactionType must be TrustSet to use QualityOut');
  // }

  return this._setUInt32('QualityOut', quality);
};

/**
 * Construct a 'Payment' transaction
 *
 * Relevant setters:
 *  - setPaths()
 *  - setBuildPath()
 *  - addPath()
 *  - setSourceTag()
 *  - setDestinationTag()
 *  - setSendMax()
 *  - setFlags()
 *
 *  @param {String} source account
 *  @param {String} destination account
 *  @param {Amount} payment amount
 */

Transaction.prototype.payment = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src || options.from;
    }
    if (lodash.isUndefined(options.destination)) {
      options.destination = options.dst || options.to;
    }
  } else {
    options = {
      account: arguments[0],
      destination: arguments[1],
      amount: arguments[2]
    };
  }

  this.setType('Payment');
  this.setAccount(options.account);
  this.setDestination(options.destination);
  this.setAmount(options.amount);

  return this;
};


/**
 * Construct a 'SuspendedPaymentCreate' transaction
 * @param {String} source account
 * @param {String} destination account
 * @param {Amount} payment amount
 * @param {String} condition
 * @param [Number|Date] cancel after
 * @param [Number|Date] finish after
 */
Transaction.prototype.susPayCreate = 
Transaction.prototype.suspendedPaymentCreate = function (options_) {  
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src || options.from;
    }
    if (lodash.isUndefined(options.destination)) {
      options.destination = options.dst || options.to;
    }
  } else {
    options = {
      account: arguments[0],
      destination: arguments[1],
      amount: arguments[2],
      condition: arguments[3],
      cancel_after: arguments[4],
      finish_after: arguments[5],
    };
  }

  this.setType('SuspendedPaymentCreate');
  this.setAccount(options.account);
  this.setDestination(options.destination);
  this.setAmount(options.amount);

  var dtag = options.destination_tag || options.dtag;
  if (!lodash.isUndefined(dtag)) {
    this._.setDestinationTag(dtag);
  }

  if (!lodash.isUndefined(options.condition)) {
    this.tx_json.Condition = options.condition;
  }

  if (!lodash.isUndefined(options.cancel_after)) {
    this._setTime('CancelAfter', options.cancel_after);
  }

  if (!lodash.isUndefined(options.finish_after)) {
    this._setTime('FinishAfter', options.finish_after);
  }

  return this;
};

/**
 * Construct a 'SuspendedPaymentFinish' transaction
 * @param {String} account
 * @param {String} owner account of the suspay
 * @param [Number] sequence of the txn that create the suspay
 * @param {String} condition
 * @param {String} fulfillment
 */
Transaction.prototype.susPayExecute = 
Transaction.prototype.susPayFinish = 
Transaction.prototype.suspendedPaymentFinish = function (options_) {  
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.offer_sequence)) {
      options.offer_sequence = options.sequence || options.seq;
    }
  } else {
    options = {
      account: arguments[0],
      owner: arguments[1],
      offer_sequence: arguments[2],
      condition: arguments[3],
      fulfillment: arguments[4],
    };
  }

  this.setType('SuspendedPaymentFinish');
  this.setAccount(options.account);
  this.setOwner(options.owner);
  this.setOfferSequence(options.offer_sequence);

  if (!lodash.isUndefined(options.condition)) {
    this.tx_json.Condition = options.condition;
  }

  if (!lodash.isUndefined(options.fulfillment)) {
    this.tx_json.Fulfillment = options.fulfillment;
  }

  return this;
};

/**
 * Construct a 'SuspendedPaymentCancel' transaction
 * @param {String} account
 * @param {String} owner account of the suspay
 * @param [Number] sequence of the txn that create the suspay
 */
Transaction.prototype.susPayCancel = 
Transaction.prototype.suspendedPaymentCancel = function (options_) {  
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.offer_sequence)) {
      options.offer_sequence = options.sequence || options.seq;
    }
  } else {
    options = {
      account: arguments[0],
      owner: arguments[1],
      offer_sequence: arguments[2],
    };
  }

  this.setType('SuspendedPaymentCancel');
  this.setAccount(options.account);
  this.setOwner(options.owner);
  this.setOfferSequence(options.offer_sequence);

  return this;
};

Transaction.prototype.setOwner = function (account) {
  return this._setAccount('Owner', account);
};

Transaction.prototype.setAmount = function (amount) {
  // if (this.getType() !== 'Payment') {
  // throw new Error('TransactionType must be Payment to use SendMax');
  // }

  return this._setAmount('Amount', amount);
};

Transaction.prototype.setDestination = function (destination) {
  // if (this.getType() !== 'Payment') {
  // throw new Error('TransactionType must be Payment to use Destination');
  // }

  return this._setAccount('Destination', destination);
};

/**
 * Set SendMax for Payment
 *
 * @param {String|Object} send max amount
 */

Transaction.prototype.setSendMax = Transaction.prototype.sendMax = function (send_max) {
  // if (this.getType() !== 'Payment') {
  // throw new Error('TransactionType must be Payment to use SendMax');
  // }

  return this._setAmount('SendMax', send_max);
};

/**
 * Filter invalid properties from path objects in a path array
 *
 * Valid properties are:
 * - account
 * - currency
 * - issuer
 * - type_hex
 *
 * @param {Array} path
 * @return {Array} filtered path
 */

Transaction._rewritePath = function (path) {
  var newPath = path.map(function (node) {
    var newNode = {};

    if (node.hasOwnProperty('account')) {
      newNode.account = UInt160.json_rewrite(node.account);
    }

    if (node.hasOwnProperty('issuer')) {
      newNode.issuer = UInt160.json_rewrite(node.issuer);
    }

    if (node.hasOwnProperty('currency')) {
      newNode.currency = Currency.json_rewrite(node.currency);
    }

    if (node.hasOwnProperty('type_hex')) {
      newNode.type_hex = node.type_hex;
    }

    return newNode;
  });

  return newPath;
};

/**
 * Add a path for Payment transaction
 *
 * @param {Array} path
 */

Transaction.prototype.addPath = Transaction.prototype.pathAdd = function (path) {
  if (!Array.isArray(path)) {
    throw new Error('Path must be an array');
  }

  // Path must not be empty array
  if (path.length === 0) {
    return this;
  }

  this.tx_json.Paths = this.tx_json.Paths || [];
  this.tx_json.Paths.push(Transaction._rewritePath(path));

  return this;
};

/**
 * Set paths for Payment transaction
 *
 * @param {Array} paths
 */

Transaction.prototype.setPaths = Transaction.prototype.paths = function (paths) {
  if (!Array.isArray(paths)) {
    throw new Error('Paths must be an array');
  }
  // if (this.getType() !== 'Payment') {
  // throw new Error('TransactionType must be Payment to use Paths');
  // }

  this.tx_json.Paths = [];
  paths.forEach(this.addPath, this);

  return this;
};

/**
 * Set build_path to have server blindly construct a path for Payment
 *
 *  "blindly" because the sender has no idea of the actual cost must be less
 *  than send max.
 *
 *  @param {Boolean} build path
 */

Transaction.prototype.setBuildPath = Transaction.prototype.buildPath = function (build) {
  // if (this.getType() !== 'Payment') {
  // throw new Error('TransactionType must be Payment to use build_path');
  // }

  this._build_path = build === undefined || build;

  return this;
};

/**
 * Set DestinationTag for Payment transaction
 *
 * @param {Number} destination tag
 */

Transaction.prototype.setDestinationTag = Transaction.prototype.destinationTag = function (tag) {
  // if (this.getType() !== 'Payment') {
  // throw new Error('TransactionType must be Payment to use DestinationTag');
  // }

  return this._setUInt32('DestinationTag', tag);
};

/**
 * Set InvoiceID for Payment transaction
 *
 * @param {String} id
 */

Transaction.prototype.setInvoiceID = Transaction.prototype.invoiceID = function (id) {
  // if (this.getType() !== 'Payment') {
  // throw new Error('TransactionType must be Payment to use InvoiceID');
  // }

  return this._setHash256('InvoiceID', id, { pad: true });
};

/**
 * Construct an 'OfferCreate transaction
 *
 * @param {String} account
 * @param {Amount} taker pays amount
 * @param {Amount} taker gets amount
 * @param [Number|Date] expiration
 * @param [Number] sequence of an existing offer to replace
 */

Transaction.prototype.offerCreate = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src;
    }
    if (lodash.isUndefined(options.taker_pays)) {
      options.taker_pays = options.buy;
    }
    if (lodash.isUndefined(options.taker_gets)) {
      options.taker_gets = options.sell;
    }
    if (lodash.isUndefined(options.offer_sequence)) {
      options.offer_sequence = options.cancel_sequence || options.sequence;
    }
  } else {
    options = {
      account: arguments[0],
      taker_pays: arguments[1],
      taker_gets: arguments[2],
      expiration: arguments[3],
      offer_sequence: arguments[4]
    };
  }

  this.setType('OfferCreate');
  this.setAccount(options.account);
  this.setTakerGets(options.taker_gets);
  this.setTakerPays(options.taker_pays);

  if (!lodash.isUndefined(options.expiration)) {
    this.setExpiration(options.expiration);
  }
  if (!lodash.isUndefined(options.offer_sequence)) {
    this.setOfferSequence(options.offer_sequence);
  }

  return this;
};

Transaction.prototype.setTakerGets = function (amount) {
  // if (this.getType() !== 'OfferCreate') {
  // throw new Error('TransactionType must be OfferCreate to use TakerGets');
  // }

  return this._setAmount('TakerGets', amount);
};

Transaction.prototype.setTakerPays = function (amount) {
  // if (this.getType() !== 'OfferCreate') {
  // throw new Error('TransactionType must be OfferCreate to use TakerPays');
  // }

  return this._setAmount('TakerPays', amount);
};

Transaction.prototype.setExpiration = function (expiration) {
  return this._setTime('Expiration', expiration);
};

Transaction.prototype._setTime = function (fieldname, time) {
  return this._setUInt32(fieldname, utils.time.toRipple(time));
};

Transaction.prototype.setOfferSequence = function (offerSequence) {
  /* eslint-disable max-len */
  // if (!/^Offer(Cancel|Create)$/.test(this.getType())) {
  // throw new Error(
  // 'TransactionType must be OfferCreate or OfferCancel to use OfferSequence'
  // );
  // }
  /* eslint-enable max-len */

  return this._setUInt32('OfferSequence', offerSequence);
};

/**
 * Construct an 'OfferCancel' transaction
 *
 * @param {String} account
 * @param [Number] sequence of an existing offer
 */

Transaction.prototype.offerCancel = function (options_) {
  var options = undefined;

  if (typeof options_ === 'object') {
    options = lodash.merge({}, options_);

    if (lodash.isUndefined(options.account)) {
      options.account = options.src;
    }
    if (lodash.isUndefined(options.offer_sequence)) {
      options.offer_sequence = options.sequence || options.cancel_sequence;
    }
  } else {
    options = {
      account: arguments[0],
      offer_sequence: arguments[1]
    };
  }

  this.setType('OfferCancel');
  this.setAccount(options.account);
  this.setOfferSequence(options.offer_sequence);

  return this;
};

/**
 * Submit transaction to the network
 *
 * @param [Function] callback
 */

Transaction.prototype.submit = function (callback) {
  var self = this;

  this.callback = typeof callback === 'function' ? callback : function () {};

  this._errorHandler = function transactionError(error_, message) {
    var error = error_;

    if (!(error instanceof RippleError)) {
      error = new RippleError(error, message);
    }

    self.callback(error);
  };

  this._successHandler = function transactionSuccess(message) {
    self.callback(null, message);
  };

  if (!this.remote) {
    this.emit('error', new Error('No remote found'));
    return this;
  }

  /* eslint-disable max-len */
  // if (this.state !== 'unsubmitted') {
  // this.emit('error', new Error('Attempt to submit transaction more than once'));
  // return;
  // }
  /* eslint-enable max-len */

  this.getManager().submit(this);

  return this;
};

Transaction.prototype.abort = function () {
  if (!this.finalized) {
    this.emit('error', new RippleError('tejAbort', 'Transaction aborted'));
  }

  return this;
};

/**
 * Return summary object containing important information for persistence
 *
 * @return {Object} transaction summary
 */

Transaction.prototype.getSummary = Transaction.prototype.summary = function () {
  var txSummary = {
    tx_json: this.tx_json,
    clientID: this._clientID,
    submittedIDs: this.submittedIDs,
    submissionAttempts: this.attempts,
    submitIndex: this.submitIndex,
    initialSubmitIndex: this.initialSubmitIndex,
    lastLedgerSequence: this.lastLedgerSequence,
    state: this.state,
    finalized: this.finalized
  };

  if (this.result) {
    var transaction_hash = this.result.tx_json ? this.result.tx_json.hash : undefined;

    txSummary.result = {
      engine_result: this.result.engine_result,
      engine_result_message: this.result.engine_result_message,
      ledger_hash: this.result.ledger_hash,
      ledger_index: this.result.ledger_index,
      transaction_hash: transaction_hash
    };
  }

  return txSummary;
};

exports.Transaction = Transaction;

// vim:sw=2:sts=2:ts=8:et
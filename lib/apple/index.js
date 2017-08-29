var assert = require('assert');
var https = require('../https');
var _ = require('lodash');

var apiUrls = {
	sandbox: 'https://sandbox.itunes.apple.com/verifyReceipt',
	production: 'https://buy.itunes.apple.com/verifyReceipt'
};

var responses = {
	'21000': 'The App Store could not read the JSON object you provided.',
	'21002': 'The data in the receipt-data property was malformed or missing.',
	'21003': 'The receipt could not be authenticated.',
	'21004': 'The shared secret you provided does not match the shared secret on file for your account.',
	'21005': 'The receipt server is not currently available.',
	'21006': 'This receipt is valid but the subscription has expired. When this status code is returned to your server, the receipt data is also decoded and returned as part of the response.',
	'21007': 'This receipt is from the test environment, but it was sent to the production service for verification. Send it to the test environment service instead.',
	'21008': 'This receipt is from the production receipt, but it was sent to the test environment service for verification. Send it to the production environment service instead.'
};

function getReceiptFieldValue(receipt, field) {
	if (receipt.hasOwnProperty(field)) {
		return receipt[field];
	}

	/* jshint camelcase:false*/
	if (receipt.hasOwnProperty('in_app') && receipt.in_app[0] && receipt.in_app[0].hasOwnProperty(field)) {
		return receipt.in_app[0][field];
	}
	
	return null;
}

function getReceiptFieldValueHash(receipt, field) {
    /* jshint camelcase:false*/
    const result = {};
	  if (receipt.hasOwnProperty(field)) {
      result[receipt[field]] = true;
	  } else if (receipt.hasOwnProperty('in_app') && _.isArray(receipt.in_app)) {
      for (let i = 0; i < receipt.in_app.length; ++i) {
        const inAppInfo = receipt.in_app[i];
          if (inAppInfo && _.isString(inAppInfo[field])) {
            result[inAppInfo[field]] = true;
        }
      }
    }
	  return result;
}

function parseResult(result) {
	result = JSON.parse(result);

	var status = parseInt(result.status, 10);

	var latestReceiptInfo = null;

	if (status !== 0) {
		var msg = responses[status] || 'Unknown status code: ' + status;

		var error = new Error(msg);
		error.status = status;

		throw error;
	}

	var productId = getReceiptFieldValue(result.receipt, 'product_id');
	var transactionId = getReceiptFieldValue(result.receipt, 'transaction_id');

	/* jshint camelcase:false */
	if (result.hasOwnProperty('latest_receipt_info') && result.latest_receipt_info[0]) {
		latestReceiptInfo = result.latest_receipt_info.sort(function (a, b) {
			return parseInt(a.transaction_id, 10)  - parseInt(b.transaction_id, 10);
		});

		productId = latestReceiptInfo[latestReceiptInfo.length - 1].product_id;
		transactionId = latestReceiptInfo[latestReceiptInfo.length - 1].transaction_id;
	}

	return {
		receipt: result.receipt,
		latestReceiptInfo: latestReceiptInfo,
		productId: productId,
		transactionId: transactionId
	};
}

function verify(environmentUrl, options, cb) {
	https.post(environmentUrl, options, function (error, res, resultString) {
		if (error) {
			return cb(error);
		}

		if (res.statusCode !== 200) {
			return cb(new Error('Received ' + res.statusCode + ' status code with body: ' + resultString));
		}

		var resultObject;

		try {
			resultObject = parseResult(resultString);
		} catch (error) {
			return cb(error, {});
		}

		cb(null, resultObject);
	});
}


function isBase64like(str) {
	return !!str.match(/^[a-zA-Z0-9\/+]+\={0,2}$/);
}

exports.verifyPayment = function (payment, cb) {
	var jsonData = {};

	try {
		assert.equal(typeof payment.receipt, 'string', 'Receipt must be a string');

		if (isBase64like(payment.receipt)) {
			jsonData['receipt-data'] = payment.receipt;
		} else {
			jsonData['receipt-data'] = (new Buffer(payment.receipt, 'utf8')).toString('base64');
		}
	} catch (error) {
		return process.nextTick(function () {
			cb(error);
		});
	}

	if (payment.secret !== undefined) {
		assert.equal(typeof payment.secret, 'string', 'Shared secret must be a string');
		jsonData.password = payment.secret;
	}

	function checkReceipt(error, result, environment) {
    if (!_.isObject(result)) {
        result = {};
    }

		result.environment = environment;
		if (error) {
			return cb(error, result);
		}

		var receipt = result.receipt;
		var productIdHash = getReceiptFieldValueHash(receipt, 'product_id');

    var errStr = '';
		if (payment.hasOwnProperty('productId') && !productIdHash[payment.productId]) {
      errStr = 'Wrong product ID: ' + payment.productId + ' (expected: ' + JSON.stringify(productIdHash) + ')';
			return cb(new Error(errStr), result);
		}

		var receiptBundleId = getReceiptFieldValue(receipt, 'bid');

		if (receiptBundleId === null) {
			receiptBundleId = getReceiptFieldValue(receipt, 'bundle_id');
		}

		if (payment.hasOwnProperty('packageName') && payment.packageName !== receiptBundleId) {
      errStr = 'Wrong bundle ID: ' + payment.packageName + ' (expected: ' + receiptBundleId + ')';
			return cb(new Error(errStr), result);
		}

		return cb(null, result);
	}


	verify(apiUrls.production, { json: jsonData }, function (error, resultString) {
		// 21007: this is a sandbox receipt, so take it there
		if (error && error.status === 21007) {
			return verify(apiUrls.sandbox, { json: jsonData }, function(err, res) {
                		checkReceipt(err, res, 'sandbox');
            		});
		}

		return checkReceipt(error, resultString, 'production');
	});
};

/*
Copyright 2013 Google Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

goog.provide('cam.ServerConnection');

goog.require('goog.string');
goog.require('goog.net.XhrIo');
goog.require('goog.Uri'); // because goog.net.XhrIo forgot to include it.
goog.require('goog.debug.ErrorHandler'); // because goog.net.Xhrio forgot to include it.
goog.require('goog.uri.utils');

goog.require('cam.blob');
goog.require('cam.ServerType');
goog.require('cam.WorkerMessageRouter');

// @fileoverview Connection to the blob server and API for the RPCs it provides. All blob index UI code should use this connection to contact the server.
// @param {cam.ServerType.DiscoveryDocument} config Discovery document for the current server.
// @param {Function=} opt_sendXhr Function for sending XHRs for testing.
// @constructor
cam.ServerConnection = function(config, opt_sendXhr) {
	this.config_ = config;
	this.sendXhr_ = opt_sendXhr || goog.net.XhrIo.send;
	this.worker_ = null;
};

cam.ServerConnection.DESCRIBE_REQUEST = {
	// This size doesn't matter, we don't use it. We only care about the aspect ratio.
	// TODO(aa): This needs to die: https://code.google.com/p/camlistore/issues/detail?id=321
	thumbnailSize: 1000,

	// TODO(aa): This is not perfect. The describe request will return some data we don't care about:
	// - Properties we don't use
	// See: https://code.google.com/p/camlistore/issues/detail?id=319

	depth: 1,
	rules: [
		{
			attrs: ['camliContent', 'camliContentImage']
		},
		{
			ifCamliNodeType: 'foursquare.com:checkin',
			attrs: ['foursquareVenuePermanode']
		},
		{
			ifCamliNodeType: 'foursquare.com:venue',
			attrs: ['camliPath:photos'],
                        rules: [
                            { attrs: ['camliPath:*'] }
                        ]
		}
	]
};

cam.ServerConnection.prototype.getWorker_ = function() {
	if (!this.worker_) {
		var r = new Date().getTime(); // For cachebusting the worker. Sigh. We need content stamping.
		this.worker_ = new cam.WorkerMessageRouter(new Worker('hash_worker.js?r=' + r));
	}
	return this.worker_;
};

cam.ServerConnection.prototype.getConfig = function() {
	return this.config_;
};

// @param {?Function|undefined} fail Fail func to call if exists.
// @return {Function}
cam.ServerConnection.prototype.safeFail_ = function(fail) {
	return fail || function(msg) {
		throw new Error(msg);
	};
};

// @param {Function} success Success callback.
// @param {?Function} fail Optional fail callback.
// @param {goog.events.Event} e Event that triggered this
cam.ServerConnection.prototype.handleXhrResponseText_ = function(success, fail, e) {
	var xhr = e.target;
	var error = !xhr.isSuccess();
	var result = null;
	if (!error) {
		result = xhr.getResponseText();
		error = !result;
	}
	if (error) {
		if (fail) {
			fail(xhr.getLastError())
		} else {
			// TODO(bslatkin): Add a default failure event handler to this class.
			console.log('Failed XHR (text) in ServerConnection');
		}
		return;
	}
	success(result);
};

// @param {string} blobref blobref whose contents we want.
// @param {Function} success callback with data.
// @param {?Function} opt_fail optional failure calback
cam.ServerConnection.prototype.getBlobContents = function(blobref, success, opt_fail) {
	var path = goog.uri.utils.appendPath(
		this.config_.blobRoot, 'camli/' + blobref
	);

	this.sendXhr_(path,
		goog.bind(this.handleXhrResponseText_, this,
			success, this.safeFail_(opt_fail)
		)
	);
};

// TODO(mpl): set a global timeout ?
// Brett, would it be worth to use the XhrIo send instance method, with listeners,
// instead of the send() utility function ?
// @param {Function} success Success callback.
// @param {?Function} fail Optional fail callback.
// @param {goog.events.Event} e Event that triggered this
cam.ServerConnection.prototype.handleXhrResponseJson_ = function(success, fail, e) {
	var xhr = e.target;
	var error = !xhr.isSuccess();
	var result = null;

	try {
		result = xhr.getResponseJson();
	} catch(err) {
		result = "Response was not valid JSON: " + xhr.getResponseText();
	}

	if (error) {
		fail(result.error || result);
	} else {
		success(result);
	}
};

// @param {Function} success callback with data.
// @param {?Function} opt_fail optional failure calback
cam.ServerConnection.prototype.discoSignRoot = function(success, opt_fail) {
	var path = goog.uri.utils.appendPath(this.config_.jsonSignRoot, '/camli/sig/discovery');
	this.sendXhr_(path, goog.bind(this.handleXhrResponseJson_, this, success, this.safeFail_(opt_fail)));
};

// @param {function(cam.ServerType.StatusResponse)} success.
// @param {?Function} opt_fail optional failure calback
cam.ServerConnection.prototype.serverStatus = function(success, opt_fail) {
	var path = goog.uri.utils.appendPath(this.config_.statusRoot, 'status.json');

	this.sendXhr_(path,
		goog.bind(this.handleXhrResponseJson_, this, success, function(msg) {
			console.log("serverStatus error: " + msg);
		}));
};

// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
// @param {goog.events.Event} e Event that triggered this
cam.ServerConnection.prototype.genericHandleSearch_ = function(success, opt_fail, e) {
	this.handleXhrResponseJson_(success, this.safeFail_(opt_fail), e);
};

// @param {string} blobref root of the tree
// @param {Function} success callback with data.
// @param {?Function} opt_fail optional failure calback
cam.ServerConnection.prototype.getFileTree = function(blobref, success, opt_fail) {

	// TODO(mpl): do it relatively to a discovered root?
	var path = "./tree/" + blobref;
	this.sendXhr_(path, goog.bind(this.genericHandleSearch_, this, success, this.safeFail_(opt_fail)));
};


// @param {string} blobref Permanode blobref.
// @param {number} thumbnailSize
// @param {function(cam.ServerType.DescribeResponse)} success.
// @param {Function=} opt_fail Optional fail callback.
cam.ServerConnection.prototype.describeWithThumbnails = function(blobref, thumbnailSize, success, opt_fail) {
	var path = goog.uri.utils.appendPath(
		this.config_.searchRoot, 'camli/search/describe?blobref=' + blobref);

	// TODO(mpl): should we URI encode the value? doc does not say...
	path = goog.uri.utils.appendParam(path, 'thumbnails', thumbnailSize);
	this.sendXhr_(path, goog.bind(this.genericHandleSearch_, this, success, this.safeFail_(opt_fail)));
};

// @param {string} blobref Permanode blobref.
// @param {number} thumbnailSize
cam.ServerConnection.prototype.describe = function(blobref, thumbnailSize, callback) {
	var constraint = {
		blobRefPrefix: blobref,
		camliType: 'permanode'
	};
	var describeReq = this.constructor.DESCRIBE_REQUEST;
	describeReq.thumbnailSize = thumbnailSize;
	var path = goog.uri.utils.appendPath(this.config_.searchRoot, 'camli/search/query');
	this.sendXhr_(path,
		goog.bind(this.genericHandleSearch_, this, callback, this.safeFail_()),
		"POST", JSON.stringify(this.buildQuery(constraint, describeReq)));
};

// @param {string} signer permanode must belong to signer.
// @param {string} attr searched attribute.
// @param {string} value value of the searched attribute.
// @param {Function} success.
// @param {Function=} opt_fail Optional fail callback.
cam.ServerConnection.prototype.permanodeOfSignerAttrValue = function(signer, attr, value, success, opt_fail) {
	var path = goog.uri.utils.appendPath(this.config_.searchRoot, 'camli/search/signerattrvalue');
	path = goog.uri.utils.appendParams(path,
		'signer', signer, 'attr', attr, 'value', value
	);

	this.sendXhr_(
		path,
		goog.bind(this.genericHandleSearch_, this,
			success, this.safeFail_(opt_fail)
		)
	);
};

// @param {string|object} query If string, will be sent as 'expression', otherwise will be sent as 'constraint'.
// @param {?object} opt_describe The describe property to send for the query
cam.ServerConnection.prototype.buildQuery = function(callerQuery, opt_describe, opt_limit, opt_continuationToken) {
	var query = {
		sort: "-created"
	};

	if (goog.isString(callerQuery)) {
		query.expression = callerQuery;
	} else {
		query.constraint = callerQuery;
	}

	if (opt_describe) {
		query.describe = opt_describe;
	}
	if (opt_limit) {
		query.limit = opt_limit;
	}
	if (opt_continuationToken) {
		query.continue = opt_continuationToken;
	}

	return query;
}

// @param {string|object} query If string, will be sent as 'expression', otherwise will be sent as 'constraint'.
// @param {?object} opt_describe The describe property to send for the query
cam.ServerConnection.prototype.search = function(query, opt_describe, opt_limit, opt_continuationToken, callback) {
	var path = goog.uri.utils.appendPath(this.config_.searchRoot, 'camli/search/query');
	this.sendXhr_(path,
		goog.bind(this.genericHandleSearch_, this, callback, this.safeFail_()),
		"POST", JSON.stringify(this.buildQuery(query, opt_describe, opt_limit, opt_continuationToken)));
};

// Where is the target accessed via? (paths it's at)
// @param {string} signer owner of permanode.
// @param {string} target blobref of permanode we want to find paths to
// @param {Function} success.
// @param {Function=} opt_fail Optional fail callback.
cam.ServerConnection.prototype.pathsOfSignerTarget = function(signer, target, success, opt_fail) {
	var path = goog.uri.utils.appendPath(
		this.config_.searchRoot, 'camli/search/signerpaths'
	);
	path = goog.uri.utils.appendParams(path, 'signer', signer, 'target', target);
	this.sendXhr_(path,
		goog.bind(this.genericHandleSearch_, this, success, this.safeFail_(opt_fail)));
};

// @param {string} permanode Permanode blobref.
// @param {Function} success.
// @param {Function=} opt_fail Optional fail callback.
cam.ServerConnection.prototype.permanodeClaims = function(permanode, success, opt_fail) {
	var path = goog.uri.utils.appendPath(
		this.config_.searchRoot, 'camli/search/claims?permanode=' + permanode
	);

	this.sendXhr_(
		path,
		goog.bind(this.genericHandleSearch_, this,
			success, this.safeFail_(opt_fail)
		)
	);
};

// @param {Object} clearObj Unsigned object.
// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.sign_ = function(clearObj, success, opt_fail) {
	var sigConf = this.config_.signing;
	if (!sigConf || !sigConf.publicKeyBlobRef) {
		this.safeFail_(opt_fail)("Missing Camli.config.signing.publicKeyBlobRef");
		return;
	}

		clearObj.camliSigner = sigConf.publicKeyBlobRef;
		var camVersion = clearObj.camliVersion;
		if (camVersion) {
			 delete clearObj.camliVersion;
		}
		var clearText = JSON.stringify(clearObj, null, "	");
		if (camVersion) {
			 clearText = "{\"camliVersion\":" + camVersion + ",\n" + clearText.substr("{\n".length);
		}

	this.sendXhr_(
		sigConf.signHandler,
		goog.bind(this.handlePost_, this,
			success, this.safeFail_(opt_fail)),
		"POST",
		"json=" + encodeURIComponent(clearText),
		{"Content-Type": "application/x-www-form-urlencoded"}
	);
};

// @param {Object} signed Signed JSON blob (string) to verify.
// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.verify_ = function(signed, success, opt_fail) {
	var sigConf = this.config_.signing;
	if (!sigConf || !sigConf.publicKeyBlobRef) {
		this.safeFail_(opt_fail)("Missing Camli.config.signing.publicKeyBlobRef");
		return;
	}
	this.sendXhr_(
		sigConf.verifyHandler,
		goog.bind(this.handlePost_, this,
			success, this.safeFail_(opt_fail)),
		"POST",
		"sjson=" + encodeURIComponent(signed),
		{"Content-Type": "application/x-www-form-urlencoded"}
	);
};

// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
// @param {goog.events.Event} e Event that triggered this
cam.ServerConnection.prototype.handlePost_ = function(success, opt_fail, e) {
	this.handleXhrResponseText_(success, opt_fail, e);
};


// @param {string} s String to upload.
// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.uploadString_ = function(s, success, opt_fail) {
	var blobref = cam.blob.refFromString(s);
	var parts = [s];
	var bb = new Blob(parts);
	var fd = new FormData();
	fd.append(blobref, bb);

	// TODO: hack, hard-coding the upload URL here.
	// Change the spec now that App Engine permits 32 MB requests
	// and permit a PUT request on the sha1?	Or at least let us
	// specify the well-known upload URL?	In cases like this, uploading
	// a new permanode, it's silly to even stat.
	this.sendXhr_(
		this.config_.blobRoot + "camli/upload",
		goog.bind(this.handleUploadString_, this,
			blobref,
			success,
			this.safeFail_(opt_fail)
		),
		"POST",
		fd
	);
};

// @param {string} blobref Uploaded blobRef.
// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
// @param {goog.events.Event} e Event that triggered this
cam.ServerConnection.prototype.handleUploadString_ = function(blobref, success, opt_fail, e) {
	this.handlePost_(
		function(resj) {
			if (!resj) {
				alert("upload permanode fail; no response");
				return;
			}
			var resObj = JSON.parse(resj);
			if (!resObj.received || !resObj.received[0] || !resObj.received[0].blobRef) {
				alert("upload permanode fail, expected blobRef not in response");
				return;
			}
			if (success) {
				success(blobref);
			}
		},
		this.safeFail_(opt_fail),
		e
	)
};

// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.createPermanode = function(success, opt_fail) {
	var json = {
		"camliVersion": 1,
		"camliType": "permanode",
		"random": ""+Math.random()
	};
	this.sign_(json,
		goog.bind(this.handleSignPermanode_, this, success, this.safeFail_(opt_fail)),
		function(msg) {
			this.safeFail_(opt_fail)("sign permanode fail: " + msg);
		}
	);
};

// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
// @param {string} signed Signed string to upload
cam.ServerConnection.prototype.handleSignPermanode_ = function(success, opt_fail, signed) {
	this.uploadString_(
		signed,
		success,
		function(msg) {
			this.safeFail_(opt_fail)("upload permanode fail: " + msg);
		}
	)
};


// @param {string} permanode Permanode to change.
// @param {string} claimType What kind of claim: "add-attribute", "set-attribute"...
// @param {string} attribute What attribute the claim applies to.
// @param {string} value Attribute value.
// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.changeAttribute_ = function(permanode, claimType, attribute, value, success, opt_fail) {
	var json = {
		"camliVersion": 1,
		"camliType": "claim",
		"permaNode": permanode,
		"claimType": claimType,
		// TODO(mpl): to (im)port.
		"claimDate": dateToRfc3339String(new Date()),
		"attribute": attribute,
		"value": value
	};
	this.sign_(json,
		goog.bind(this.handleSignClaim_, this, success, this.safeFail_(opt_fail)),
		function(msg) {
			this.safeFail_(opt_fail)("sign " + claimType + " fail: " + msg);
		}
	);
};

// @param {string} permanode Permanode to delete.
// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.newDeleteClaim = function(permanode, success, opt_fail) {
	var json = {
		"camliVersion": 1,
		"camliType": "claim",
		"target": permanode,
		"claimType": "delete",
		"claimDate": dateToRfc3339String(new Date())
	};
	this.sign_(json,
		goog.bind(this.handleSignClaim_, this, success, this.safeFail_(opt_fail)),
		function(msg) {
			this.safeFail_(opt_fail)("sign delete fail: " + msg);
		}
	);
};

// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
// @param {string} signed Signed string to upload
cam.ServerConnection.prototype.handleSignClaim_ = function(success, opt_fail, signed) {
	this.uploadString_(
		signed,
		success,
		function(msg) {
			this.safeFail_(opt_fail)("upload " + claimType + " fail: " + msg);
		}
	)
};

// @param {string} permanode Permanode blobref.
// @param {string} attribute Name of the attribute to set.
// @param {string} value Value to set the attribute to.
// @param {function(string)} success Success callback, called with blobref of uploaded file.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.newSetAttributeClaim = function(permanode, attribute, value, success, opt_fail) {
	this.changeAttribute_(permanode, "set-attribute", attribute, value,
		success, this.safeFail_(opt_fail)
	);
};


// @param {string} permanode Permanode blobref.
// @param {string} attribute Name of the attribute to add.
// @param {string} value Value of the added attribute.
// @param {function(string)} success Success callback, called with blobref of uploaded file.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.newAddAttributeClaim = function(permanode, attribute, value, success, opt_fail) {
	this.changeAttribute_(permanode, "add-attribute", attribute, value,
		success, this.safeFail_(opt_fail)
	);
};

// @param {string} permanode Permanode blobref.
// @param {string} attribute Name of the attribute to delete.
// @param {string} value Value of the attribute to delete.
// @param {function(string)} success Success callback, called with blobref of uploaded file.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.newDelAttributeClaim = function(permanode, attribute, value, success, opt_fail) {
	this.changeAttribute_(permanode, "del-attribute", attribute, value,
		success, this.safeFail_(opt_fail)
	);
};


// @param {File} file File to be uploaded.
// @param {function(string)} success Success callback, called with blobref of
// uploaded file.
// @param {?Function} opt_fail Optional fail callback.
// @param {?Function} opt_onContentsRef Optional callback to set contents during upload.
cam.ServerConnection.prototype.uploadFile = function(file, success, opt_fail, opt_onContentsRef) {
	this.getWorker_().sendMessage('ref', file, function(ref) {
		if (opt_onContentsRef) {
			opt_onContentsRef(ref);
		}
		this.camliUploadFileHelper_(file, ref, success, this.safeFail_(opt_fail));
	}.bind(this));
};

// camliUploadFileHelper uploads the provided file with contents blobref contentsBlobRef
// and returns a blobref of a file blob.	It does not create any permanodes.
// Most callers will use camliUploadFile instead of this helper.
//
// camliUploadFileHelper only uploads chunks of the file if they don't already exist
// on the server. It starts by assuming the file might already exist on the server
// and, if so, uses an existing (but re-verified) file schema ref instead.
// @param {File} file File to be uploaded.
// @param {string} contentsBlobRef Blob ref of file as sha1'd locally.
// @param {function(string)} success function(fileBlobRef) of the
// server-validated or just-uploaded file schema blob.
// @param {?Function} opt_fail Optional fail callback.
cam.ServerConnection.prototype.camliUploadFileHelper_ = function(file, contentsBlobRef, success, opt_fail) {
	if (!this.config_.uploadHelper) {
		this.safeFail_(opt_fail)("no uploadHelper available");
		return;
	}

	var doUpload = goog.bind(function() {
		var fd = new FormData();
		fd.append("TODO-some-uploadHelper-form-name", file);
		this.sendXhr_(
			this.config_.uploadHelper,
			goog.bind(this.handleUpload_, this,
				file, contentsBlobRef, success, this.safeFail_(opt_fail)
			),
			"POST",
			fd
		);
	}, this);

	this.findExistingFileSchemas_(
		contentsBlobRef,
		goog.bind(this.dupCheck_, this,
			doUpload, contentsBlobRef, success
		),
		this.safeFail_(opt_fail)
	)
}

// @param {File} file File to be uploaded.
// @param {string} contentsBlobRef Blob ref of file as sha1'd locally.
// @param {Function} success Success callback.
// @param {?Function} opt_fail Optional fail callback.
// @param {goog.events.Event} e Event that triggered this
cam.ServerConnection.prototype.handleUpload_ = function(file, contentsBlobRef, success, opt_fail, e) {
	this.handlePost_(
		goog.bind(function(res) {
			var resObj = JSON.parse(res);
			if (resObj.got && resObj.got.length == 1 && resObj.got[0].fileref) {
				var fileblob = resObj.got[0].fileref;
				console.log("uploaded " + contentsBlobRef + " => file blob " + fileblob);
				success(fileblob);
			} else {
				this.safeFail_(opt_fail)("failed to upload " + file.name + ": " + contentsBlobRef + ": " + JSON.stringify(res, null, 2))
			}
		}, this),
		this.safeFail_(opt_fail),
		e
	)
};


// @param {string} wholeDigestRef file digest.
// @param {Function} success callback with data.
// @param {?Function} opt_fail optional failure calback
cam.ServerConnection.prototype.findExistingFileSchemas_ = function(wholeDigestRef, success, opt_fail) {
	var path = goog.uri.utils.appendPath(this.config_.searchRoot, 'camli/search/files');
	path = goog.uri.utils.appendParam(path, 'wholedigest', wholeDigestRef);

	this.sendXhr_(
		path,
		goog.bind(this.genericHandleSearch_, this,
			success, this.safeFail_(opt_fail)
		)
	);
};


// @param {Function} doUpload fun that takes care of uploading.
// @param {string} contentsBlobRef Blob ref of file as sha1'd locally.
// @param {Function} success Success callback.
// @param {Object} res result from the wholedigest search.
cam.ServerConnection.prototype.dupCheck_ = function(doUpload, contentsBlobRef, success, res) {
	var remain = res.files;
	var checkNext = goog.bind(function(files) {
		if (files.length == 0) {
			doUpload();
			return;
		}
		// TODO: verify filename and other file metadata in the
		// file json schema match too, not just the contents
		var checkFile = files[0];
		console.log("integrity checking the reported dup " + checkFile);

		// TODO(mpl): see about passing directly a ref of files maybe instead of a copy?
		// just being careful for now.
		this.sendXhr_(
			this.config_.downloadHelper + checkFile + "/?verifycontents=" + contentsBlobRef,
			goog.bind(this.handleVerifycontents_, this,
				contentsBlobRef, files.slice(), checkNext, success),
			"HEAD"
		);
	}, this);
	checkNext(remain);
}

// @param {string} contentsBlobRef Blob ref of file as sha1'd locally.
// @param {Array.<string>} files files to check.
// @param {Function} checkNext fun, recursive call.
// @param {Function} success Success callback.
// @param {goog.events.Event} e Event that triggered this
cam.ServerConnection.prototype.handleVerifycontents_ = function(contentsBlobRef, files, checkNext, success, e) {
	var xhr = e.target;
	var error = !(xhr.isComplete() && xhr.getStatus() == 200);
	var checkFile = files.shift();

	if (error) {
		console.log("integrity check failed on " + checkFile);
		checkNext(files);
		return;
	}
	if (xhr.getResponseHeader("X-Camli-Contents") == contentsBlobRef) {
		console.log("integrity check passed on " + checkFile + "; using it.");
		success(checkFile);
	} else {
		checkNext(files);
	}
};

// Format |dateVal| as specified by RFC 3339.
function dateToRfc3339String(dateVal) {
	// Return a string containing |num| zero-padded to |length| digits.
	var pad = function(num, length) {
		var numStr = "" + num;
		while (numStr.length < length) {
			numStr = "0" + numStr;
		}
		return numStr;
	};

	return goog.string.subs("%s-%s-%sT%s:%s:%sZ",
		dateVal.getUTCFullYear(), pad(dateVal.getUTCMonth() + 1, 2), pad(dateVal.getUTCDate(), 2),
		pad(dateVal.getUTCHours(), 2), pad(dateVal.getUTCMinutes(), 2), pad(dateVal.getUTCSeconds(), 2));
};

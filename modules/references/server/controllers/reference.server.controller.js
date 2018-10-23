'use strict';

var mongoose = require('mongoose'),
    _ = require('lodash'),
    path = require('path'),
    async = require('async'),
    errorService = require(path.resolve('./modules/core/server/services/error.server.service')),
    emailService = require(path.resolve('./modules/core/server/services/email.server.service')),
    pushService = require(path.resolve('./modules/core/server/services/push.server.service')),
    userProfile = require(path.resolve('./modules/users/server/controllers/users.profile.server.controller')),
    Reference = mongoose.model('Reference'),
    User = mongoose.model('User');

/**
 * Validate the request body and data consistency
 * of Create a reference
 */
function validateCreate(req) {
  var valid = true;
  var details = [];

  // Can't create a reference to oneself
  if (req.user._id.toString() === req.body.userTo) {
    valid = false;
    details.push('Reference to self.');
  }

  // Some interaction must have happened
  var isInteraction = req.body.met || req.body.hostedMe || req.body.hostedThem;
  if (!isInteraction) {
    valid = false;
    details.push('No interaction.');
  }

  // Value of 'recommend' must be valid ('yes', 'no', 'unknown')
  if (req.body.recommend && !['yes', 'no', 'unknown'].includes(req.body.recommend)) {
    valid = false;
    details.push('Invalid recommendation.');
  }

  // Values of interactions must be boolean
  ['met', 'hostedMe', 'hostedThem'].forEach(function (interaction) {
    if (req.body.hasOwnProperty(interaction) && typeof req.body[interaction] !== 'boolean') {
      valid = false;
      details.push('Value of \'' + interaction + '\' should be a boolean.');
    }
  });

  // Value of userTo must exist and be a UserId
  if (!req.body.hasOwnProperty('userTo')) {
    valid = false;
    details.push('Missing userTo.');
  } else if (!mongoose.Types.ObjectId.isValid(req.body.userTo)) {
    valid = false;
    details.push('Value of userTo must be a user id.');
  }

  // No unexpected fields
  var allowedFields = ['userTo', 'met', 'hostedMe', 'hostedThem', 'recommend'];
  var fields = Object.keys(req.body);
  var unexpectedFields = _.difference(fields, allowedFields);
  if (unexpectedFields.length > 0) {
    valid = false;
    details.push('Unexpected fields.');
  }

  return { valid: valid, details: details };
}

var referenceFields = [
  '_id',
  'public',
  'userFrom',
  'userTo',
  'created',
  'met',
  'hostedMe',
  'hostedThem',
  'recommend'
];

function formatReference(reference) {
  // converts MongooseObject to Object and picks only defined fields
  var ref = _.pick(reference, referenceFields);
  return ref;
}

/**
 * Express response in callback of async.waterfall
 * @param {object} resOrErr - if this is a well specified object, it will trigger a response,
 *                                   otherwise 500 error
 * @param {integer} [resOrErr.status] - html status of the response
 * @param {any} [resOrErr.body] - response body
 * @param {string} [resOrErr.body.errType] - will be transformed to body.message by errorService by key
 */
function processResponses(res, next, resOrErr) {
  // send error responses
  if (resOrErr && resOrErr.status && resOrErr.body) {
    if (resOrErr.body.errType) {
      resOrErr.body.message = errorService.getErrorMessageByKey(resOrErr.body.errType);
      delete resOrErr.body.errType;
    }
    return res.status(resOrErr.status).json(resOrErr.body);
  }

  // take care of unexpected resOrErrors
  return next(resOrErr);
}

/**
 * Validate request with validator and call callback with prepared error response
 * @param {function} validator - function (parameter): { valid: boolean, details: string[] }
 * @param {object} req - Express Request object
 * @param {function} cb - callback function
 */
function validate(validator, req, cb) {
  var validation = validator(req);

  if (validation.valid) {
    return cb();
  }

  return cb({ status: 400, body: { errType: 'bad-request', details: validation.details } });
}

/**
 * Create a reference - express middleware
 */
exports.create = function (req, res, next) {

  var userTo; // not to have to pass found user in callbacks

  return async.waterfall([
    // Synchronous validation of the request data consistency
    validate.bind(this, validateCreate, req),
    // Check if the receiver of the reference exists and is public
    function isUserToPublic(cb) {
      User.findOne({ _id: req.body.userTo }).exec(function (err, foundUser) {
        if (err) return cb(err);

        userTo = foundUser;

        // Can't create a reference to a nonexistent user
        // Can't create a reference to a nonpublic user
        if (!userTo || !userTo.public) {
          return cb({
            status: 404,
            body: {
              errType: 'not-found',
              detail: 'User not found.'
            }
          });
        }

        return cb();
      });
    },
    // Check if the opposite direction reference exists
    // when it exists, we want to make both references public
    function getOtherReference(cb) {
      Reference.findOne({ userFrom: req.body.userTo, userTo: req.user._id }).exec(function (err, ref) {
        cb(err, ref);
      });
    },
    // save the reference...
    function saveNewReference(otherReference, cb) {

      // ... when the other reference is public, this one can only have value of recommend: yes ...
      if (otherReference && otherReference.public && req.body.recommend !== 'yes') {
        return cb({
          status: 400,
          body: {
            errType: 'bad-request',
            details: ['Only a positive recommendation is allowed in response to a public reference.']
          }
        });
      }

      // ...and make it public if it is a reference reply
      var reference = new Reference(_.merge(req.body, { userFrom: req.user._id, public: !!otherReference }));

      reference.save(function (err, savedReference) {

        // manage errors
        if (err) {

          // conflict
          var isConflict = err.errors && err.errors.userFrom && err.errors.userTo &&
            err.errors.userFrom.kind === 'unique' && err.errors.userTo.kind === 'unique';
          if (isConflict) {
            return cb({
              status: 409,
              body: { errType: 'conflict' }
            });
          }

          // any other error
          return cb(err);
        }

        return cb(null, savedReference, otherReference);

      });
    },
    // ...and if this is a reference reply, make the other reference public, too
    function publishOtherReference(savedReference, otherReference, cb) {
      if (otherReference && !otherReference.public) {
        otherReference.set({ public: true });
        return otherReference.save(function (err) {
          return cb(err, savedReference, otherReference);
        });
      }

      return cb(null, savedReference, otherReference);
    },
    // send email notification
    function sendEmailNotification(savedReference, otherReference, cb) {
      if (!otherReference) {
        return emailService.sendReferenceNotificationFirst(req.user, userTo, function (err) {
          cb(err, savedReference, otherReference);
        });
      } else {
        return emailService.sendReferenceNotificationSecond(req.user, userTo, savedReference, function (err) {
          cb(err, savedReference, otherReference);
        });
      }
    },
    // send push notification
    function sendPushNotification(savedReference, otherReference, cb) {
      return pushService.notifyNewReference(req.user, userTo, { isFirst: !otherReference }, function (err) {
        cb(err, savedReference);
      });
    },
    // finally, respond
    function respond(savedReference, cb) {
      return cb({
        status: 201,
        body: formatReference(savedReference)
      });
    }
  ], processResponses.bind(this, res, next));
};

/**
 * Validator for readMany controller
 */
function validateReadMany(req) {
  var valid = true;
  var details = [];

  // check that query contains userFrom or userTo
  var isQueryWithFilter = req.query.userFrom || req.query.userTo;
  if (!isQueryWithFilter) {
    valid = false;
    details.push('Missing query parameters userFrom or userTo.');
  }

  // check that userFrom and userTo is valid mongodb/mongoose ObjectId
  ['userFrom', 'userTo'].forEach(function (param) {
    if (!req.query[param]) return;

    var isParamValid = mongoose.Types.ObjectId.isValid(req.query[param]);
    if (!isParamValid) {
      valid = false;
      details.push('Invalid query parameter ' + param + '.');
    }
  });

  return { valid: valid, details: details };
}

/**
 * Read references filtered by userFrom or userTo
 */
exports.readMany = function readMany(req, res, next) {

  return async.waterfall([

    // validate the query
    validate.bind(this, validateReadMany, req),

    // build a query (synchronous)
    function buildQuery(cb) {
      var query = { };

      /**
       * Allow non-public references only when userFrom is self
       */
      var isSelfUserFrom = req.user._id.toString() === req.query.userFrom;
      if (!isSelfUserFrom) {
        query.public = true;
      }

      /**
       * Filter by userFrom
       */
      if (req.query.userFrom) {
        query.userFrom = req.query.userFrom;
      }

      /**
       * Filter by userTo
       */
      if (req.query.userTo) {
        query.userTo = req.query.userTo;
      }

      cb(null, query);
    },

    // find references by query
    function findReferences(query, cb) {
      Reference.find(query)
        .select(referenceFields)
        .populate('userFrom userTo', userProfile.userMiniProfileFields)
        .exec(cb);
    },

    // prepare success response
    function prepareSuccessResponse(references, cb) {
      cb({
        status: 200,
        body: references.map(formatReference)
      });
    }

  ], processResponses.bind(this, res, next));
};

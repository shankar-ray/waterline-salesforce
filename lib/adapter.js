'use strict';

var assert     = require('assert');
var Promise    = require('bluebird');
var jsforce    = require('jsforce');
var moment     = require('moment');
var assign     = require('object-assign');
var Errors     = require('waterline-errors').adapter;
var Connection = require('./connection');
var Query      = require('./query').Query;

// Keep track of all the connections used by the app
var connections = {};

module.exports = {
  // to track schema internally
  syncable: false,
  defaults: {
    maxConnectionAge: {unit: 'minutes', val: 30},
    picklistKey: 'picklist'
  },

  /**
   * regiserConnection
   */
  registerConnection: function (connection, collections, cb) {
    Promise
      .resolve()
      .then(function () {
        if (!connection.identity) {
          throw new Error(Errors.IdentityMissing);
        }
        if (connections[connection.identity]) {
          throw new Error(Errors.IdentityDuplicate);
        }

        connections[connection.identity] = new Connection({
          config: connection,
          collections: collections,
          connection: null,
          expiresOn: 0
        });

        return connections[connection.identity].getConnection();
      })
      .nodeify(cb);
  },

  /**
   * find
   */
  find: function (connectionName, collectionName, options, cb) {
    var collection = connections[connectionName].collections[collectionName];

    // Shim in required query params and parse any logical operators.
    options.select = (options.select || [])
      .map(function(def){
        return collection._transformer._transformations[def];
      })
      .filter(function(def){
        return !!def;
      });

    if (!options.select.length) {
      options.select = Object.keys(collection.definition);
    }

    connections[connectionName]
      .getConnection()
      .then(function (connection) {
        var query = new Query(
          connection.sobject(collectionName),
          options
        );
        return query.run();
      })
      .nodeify(cb);
  },

  /**
   * create
   */
  create: function (connectionName, collectionName, data, cb) {
    connections[connectionName]
      .getConnection()
      .then(function (connection) {
        return connection
          .sobject(collectionName)
          .create(data);
      })
      .then(errorNet)
      .nodeify(cb);
  },

  /**
   * update
   */
  update: function (connectionName, collectionName, options, values, cb) {
    connections[connectionName]
      .getConnection()
      .then(function (connection) {
        return connection
          .sobject(collectionName)
          .update(assign(options.where, values));
      })
      .then(errorNet)
      .nodeify(cb);
  },

  /**
   * join
   */
  join: function (connectionName, collectionName, options, cb) {
    var collection = connections[connectionName].collections[collectionName];

    options.select = Object.keys(collection.definition);

    Promise
      .all([
        connections[connectionName].getConnection(),
        connections[connectionName].joins(options.joins)
      ])
      .spread(function (connection, table) {
        var query = new Query(
          connection.sobject(collectionName),
          options,
          table
        );
        return query.run();
      })
      .nodeify(cb);
  },

  /**
   * native
   */
  native: function (connectionName, collectionName, cb) {
    return connections[connectionName]
      .getConnection()
      .then(function (connection) {
        return connection.sobject(collectionName);
      })
      .nodeify(cb);
  },

  // TODO: Implement teardown process.
  teardown: function(connectionName, cb) { cb(); },
  // TODO: Implement `Model.define()` functionality.
  define: function(connectionName, collectionName, definition, cb) { cb(); },
  // TODO: Implement `Model.describe()` functionality.
  describe: function(connectionName, collectionName, cb) { cb(); },
  // TODO: Implement `Model.drop` functionality.
  drop: function(connectionName, collectionName, relations, cb) { cb(); },
  // TODO: Implement `Model.destroy` functionality.
  destroy: function(connectionName, collectionName, options, cb) { cb(); },

  ///////////////////////////////////////////////////////////////////////////
  // Optional Overrides :: Methods defined here can override built in dynamic
  //                       finders such as `Model.findOrCreate`.

  ///////////////////////////////////////////////////////////////////////////
  // Custom Methods :: Methods defined here will be available on all models
  //                   which are hooked up to this adapter.
  rawConnection: function(connectionName, collectionName, cb) {
    var connection = connections[connectionName];
    return connection.getConnection().nodeify(cb);
  },

  picklists: function(connectionName, collectionName, name, cb) {
    var connection = connections[connectionName];
    var collection = connection.collections[collectionName];
    return connection
      .tableMeta(collectionName)
      .then(function (meta) {
        Object.keys(meta.picklists).forEach(function (key) {
          if (!collection.definition[key]) { delete meta.picklists[key]; }
        });
        return collection._transformer.unserialize(meta.picklists);
      })
      .then(function (picklists) {
        if (name) {
          assert(picklists[name], collectionName + '.' + name + ' is not a picklist');
          return picklists[name];
        }
        return picklists;
      })
      .nodeify(cb);
  },

  retrieveFull: function(connectionName, collectionName, values, cb) {
    var collection = connections[connectionName].collections[collectionName];
    return this.native(connectionName, collectionName)
      .then(function (sobject) {
        return sobject.retrieve(values.id);
      })
      .then(function (model) {
        Object.keys(values).forEach(function (key) {
          delete values[key];
        });
        Object.keys(model).forEach(function (key) {
          if (!collection.definition[key]) { delete model[key]; }
        });
        assign(values, collection._transformer.unserialize(model));
      })
      .nodeify(cb);
  }
};

function errorNet(result) {
  if (result.errors.length > 0) {
    throw new Error(result.errors.split(', '));
  }
  if (result.success !== true) {
    throw new Error('Was not successful');
  }
  return result;
}

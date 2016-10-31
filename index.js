// Shamelessly copied from:
// https://github.com/NathanRSmith/graphql-visualizer

var _ = require('lodash');
var graphql = require('graphql');

module.exports.query = graphql.introspectionQuery;
// console.log(module.exports.query);

// process a graphql type object
// returns simplified version of the type
function processType(item, entities, types) {
  var type = _.find(types, {name: item});

  var fields = _.map(type.fields, function (field) {
    var obj = {};
    obj.name = field.name;
    obj.isDeprecated = field.isDeprecated;
    obj.deprecationReason = field.deprecationReason;

    // process field type
    var effectiveType = field.type;
    if (field.type.ofType) {
      effectiveType = field.type.ofType;
      obj.isList = field.type.kind === 'LIST';
    }
    obj.type = effectiveType.name;
    obj.isObjectType = effectiveType.kind === 'OBJECT';
    obj.isInterfaceType = effectiveType.kind === 'INTERFACE';
    obj.isUnionType = effectiveType.kind === 'UNION';

    // process args
    if (field.args && field.args.length) {
      obj.args = _.map(field.args, function (arg) {
        var obj = {};
        obj.name = arg.name;
        if (arg.type.ofType) {
          obj.type = arg.type.ofType.name;
          obj.isRequired = arg.type.ofType.kind === 'NON_NULL';
        } else {
          obj.type = arg.type.name;
        }
        return obj;
      });
    }

    return obj;
  });

  entities[type.name] = {
    name: type.name,
    fields: fields,
    implements: [],
    possibleTypes: []
  };

  if (type.interfaces) {
    entities[type.name].implements = _.each(type.interfaces || [], function(i) { return i.name });
  }

  if (type.kind == 'UNION') {
    entities[type.name].possibleTypes= _.each(type.possibleTypes || [], function(t) { return t.name });
  }

  var linkeditems = _.chain(fields)
    .filter(function(item) { return item.isObjectType || item.isInterfaceType || item.isUnionType })
    .map('type')
    .union(_.map(type.interfaces, 'name'))
    .union(_.map(type.possibleTypes, 'name'))
    .uniq()
    .value();

  return linkeditems;
}

// walks the object in level-order
// invokes iter at each node
// if iter returns truthy, breaks & returns the value
// assumes no cycles
function walkBFS(obj, iter) {
  var q = _.map(_.keys(obj), function (k) {
    return {key: k, path: '["' + k + '"]'};
  });

  var current;
  var currentNode;
  var retval;
  var push = function (v, k) {
    q.push({key: k, path: current.path + '["' + k + '"]'});
  };
  while (q.length) {
    current = q.shift();
    currentNode = _.get(obj, current.path);
    retval = iter(currentNode, current.key, current.path);
    if (retval) {
      return retval;
    }

    if (_.isPlainObject(currentNode) || _.isArray(currentNode)) {
      _.each(currentNode, push);
    }
  }
}

module.exports.render = function (schema, opts) {
  opts = opts || {};

  if (_.isString(schema)) {
    schema = JSON.parse(schema);
  }

  if (!_.isPlainObject(schema)) {
    throw new Error('Must be plain object');
  }

  // find entry points
  var rootPath = walkBFS(schema, function (v, k, p) {
    if (k === '__schema') {
      return p;
    }
  });
  if (!rootPath) {
    throw new Error('Cannot find "__schema" object');
  }

  var root = _.get(schema, rootPath);

  // build the graph
  var q = [];
  if (root.queryType) {
    q.push(root.queryType.name);
  }
  // if(root.mutationType) q.push(root.mutationType.name);

  // walk the graph & build up nodes & edges
  var current;
  var entities = {};
  while (q.length) {
    current = q.shift();

    // if item has already been processed
    if (entities[current]) {
      continue;
    }

    // process item
    q = q.concat(processType(current, entities, root.types));
  }

  // build the dot
  var dotfile = 'digraph erd {\n' +
    'graph [\n' +
    '  rankdir = "TB"\n' +
    '];\n' +
    'node [\n' +
    '  fontsize = "16"\n' +
    '  shape = "plaintext"\n' +
    '];\n' +
    'edge [\n' +
    '];\n';

  // nodes
  dotfile += _.map(entities, function (v) {
    var rows = _.map(v.fields, function (v) {
      var str = v.name;

      // render args if desired & present
      if (!opts.noargs && v.args && v.args.length) {
        str += '(' + _.map(v.args, function (v) {
          return v.name + ':' + v.type;
        }).join(', ') + ')';
      }
      var deprecationReason = '';
      if (v.isDeprecated) {
        deprecationReason = ' <FONT color="red">';
        deprecationReason += (v.deprecationReason ? v.deprecationReason : 'Deprecated');
        deprecationReason += '</FONT>';
      }
      return {
        text: str + ': ' + (v.isList ? '[' + v.type + ']' : v.type) + deprecationReason,
        name: v.name + 'port'
      };
    });
    // rows.unshift("<B>" + v.name + "</B>");
    var isRelayGlue = (v.name.endsWith('Connection') || v.name.endsWith('Edge'));
    var result = 'gqltype_' + v.name + ' [';
    if (isRelayGlue) {
      result += 'fontsize=11 color=gray33 fontcolor=gray33 ';
    }
    result += 'label=<<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0">';
    result += '<TR><TD><B>' + v.name + '</B></TD></TR>';
    result += rows.map(function (row) {
      return '<TR><TD PORT="' + row.name + '">' + row.text + '</TD></TR>';
    });
    result += '</TABLE>>];';
    return result;
  //  return v.name + ' [label=<<TABLE BORDER="0" CELLBORDER="1" CELLSPACING="0"><TR><TD>' + rows.join('</TD></TR><TR><TD>') + '</TD></TR></TABLE>>];';
  }).join('\n');

  dotfile += '\n\n';

  // edges
  dotfile += _.chain(entities)
  .reduce(function (a, v) {
    _.each(v.fields, function (f) {
      if (!(f.isObjectType || f.isInterfaceType || f.isUnionType)) {
        return;
      }

      a.push('gqltype_' + v.name + ':' + f.name + 'port -> gqltype_' + f.type);
    });

    _.each(_.union(v.implements, v.possibleTypes), function(interface){
      a.push('gqltype_' + v.name + ' -> gqltype_' + interface.name + ' [style = dotted]');
    })
    return a;
  }, [])
  .uniq()
  .value()
  .join('\n');

  dotfile += '\n}';

  return dotfile;
};

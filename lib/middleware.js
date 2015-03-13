var crypto = require('crypto')
var Error  = require('http-errors')
var utils  = require('./utils')
var Logger = require('./logger')

module.exports.match = function match(regexp) {
  return function(req, res, next, value, name) {
    if (regexp.exec(value)) {
      next()
    } else {
      next('route')
    }
  }
}

module.exports.validate_name = function validate_name(req, res, next, value, name) {
  if (value.charAt(0) === '-') {
    // special case in couchdb usually
    next('route')
  } else if (utils.validate_name(value)) {
    next()
  } else {
    next( Error[403]('invalid ' + name) )
  }
}

module.exports.validate_package = function validate_package(req, res, next, value, name) {
  if (value.charAt(0) === '-') {
    // special case in couchdb usually
    next('route')
  } else if (utils.validate_package(value)) {
    next()
  } else {
    next( Error[403]('invalid ' + name) )
  }
}

function is_maintainer(maintainers, user) {
  var filter = function(user) {
    return function(maintainer) {
      if((typeof maintainer === 'string' && maintainer !== user) || (maintainer.name && maintainer.name !== user))
        return false;
      return true;
    }
  }

  if(!maintainers)
    return false
  if(typeof maintainers === 'string' && maintainers !== user)
    return false
  if(maintainers.name && maintainers.name !== user)
    return false
  if(Array.isArray(maintainers) && !maintainers.filter(filter(user)).length)
    return false

  return true
}

module.exports.validate_publisher = function validate_publisher(storage) {
  var log = Logger.logger.child({ sub: 'in' })

  return function(req, res, next) {
    var name = req.params.package
    var user = req.remote_user.name

    storage.get_package(name, function(err, pkg, extra) {
      
      if(!err && pkg) {

        var latest = pkg['dist-tags'].latest
        latest = pkg.versions[latest]

        var author = latest.author
        var maintainers = latest.maintainers

        if((typeof author === 'string' && author !== user) || (author.name && author.name !== user)) {

          if(is_maintainer(maintainers, user)) {
            next()
          }
          else {
            log.warn('user ' + user + ' not allowed to publish ' + name)
            next( Error[403]('user ' + user + ' not allowed to publish it') )
          }

        }
        else {
          next()
        }
      }
      else if(err.toString().indexOf('no such package available') === -1) {
        log.error(err)
        next( Error[500](err) )
      }
      else {
        next()
      }

    })
  }
}

module.exports.media = function media(expect) {
  return function(req, res, next) {
    if (req.headers['content-type'] !== expect) {
      next( Error[415]('wrong content-type, expect: ' + expect
                     + ', got: '+req.headers['content-type']) )
    } else {
      next()
    }
  }
}

module.exports.expect_json = function expect_json(req, res, next) {
  if (!utils.is_object(req.body)) {
    return next( Error[400]("can't parse incoming json") )
  }
  next()
}

module.exports.anti_loop = function(config) {
  return function(req, res, next) {
    if (req.headers.via != null) {
      var arr = req.headers.via.split(',')

      for (var i=0; i<arr.length; i++) {
        var m = arr[i].match(/\s*(\S+)\s+(\S+)/)
        if (m && m[2] === config.server_id) {
          return next( Error[508]('loop detected') )
        }
      }
    }
    next()
  }
}

// express doesn't do etags with requests <= 1024b
// we use md5 here, it works well on 1k+ bytes, but sucks with fewer data
// could improve performance using crc32 after benchmarks
function md5sum(data) {
  return crypto.createHash('md5').update(data).digest('hex')
}

module.exports.allow = function(config) {
  return function(action) {
    return function(req, res, next) {
      if (config['allow_'+action](req.params.package, req.remote_user)) {
        next()
      } else {
        if (!req.remote_user.name) {
          if (req.remote_user.error) {
            var message = "can't "+action+' restricted package, ' + req.remote_user.error
          } else {
            var message = "can't "+action+" restricted package without auth, did you forget 'npm set always-auth true'?"
          }
          next( Error[403](message) )
        } else {
          next( Error[403]('user ' + req.remote_user.name
                        + ' not allowed to ' + action + ' it') )
        }
      }
    }
  }
}

module.exports.final = function(body, req, res, next) {
  if (res.statusCode === 401 && !res.getHeader('WWW-Authenticate')) {
    // they say it's required for 401, so...
    res.header('WWW-Authenticate', 'Basic, Bearer')
  }

  try {
    if (typeof(body) === 'string' || typeof(body) === 'object') {
      if (!res.getHeader('Content-type')) {
        res.header('Content-type', 'application/json')
      }

      if (typeof(body) === 'object' && body != null) {
        if (typeof(body.error) === 'string') {
          res._sinopia_error = body.error
        }
        body = JSON.stringify(body, undefined, '  ') + '\n'
      }

      // don't send etags with errors
      if (!res.statusCode || (res.statusCode >= 200 && res.statusCode < 300)) {
        res.header('ETag', '"' + md5sum(body) + '"')
      }
    } else {
      // send(null), send(204), etc.
    }
  } catch(err) {
    // if sinopia sends headers first, and then calls res.send()
    // as an error handler, we can't report error properly,
    // and should just close socket
    if (err.message.match(/set headers after they are sent/)) {
      if (res.socket != null) res.socket.destroy()
      return
    } else {
      throw err
    }
  }

  res.send(body)
}

module.exports.log = function(req, res, next) {
  // logger
  req.log = Logger.logger.child({ sub: 'in' })

  var _auth = req.headers.authorization
  if (_auth != null) req.headers.authorization = '<Classified>'
  var _cookie = req.headers.cookie
  if (_cookie != null) req.headers.cookie = '<Classified>'

  var _url = req.url
  req.url = req.originalUrl
  req.log.info( { req: req, ip: req.ip }
              , '@{ip} requested \'@{req.method} @{req.url}\'' )
  req.originalUrl = req.url

  if (_auth != null) req.headers.authorization = _auth
  if (_cookie != null) req.headers.cookie = _cookie

  var bytesin = 0
  req.on('data', function(chunk) {
    bytesin += chunk.length
  })

  var bytesout = 0
  var _write = res.write
  res.write = function(buf) {
    bytesout += buf.length
    _write.apply(res, arguments)
  }

  function log() {
    var message = "@{status}, user: @{user}, req: '@{request.method} @{request.url}'"
    if (res._sinopia_error) {
      message += ', error: @{!error}'
    } else {
      message += ', bytes: @{bytes.in}/@{bytes.out}'
    }

    var _url = req.url
    req.url = req.originalUrl
    req.log.warn({
      request : { method: req.method, url: req.url },
      level   : 35, // http
      user    : req.remote_user && req.remote_user.name,
      status  : res.statusCode,
      error   : res._sinopia_error,
      bytes   : {
        in  : bytesin,
        out : bytesout,
      }
    }, message)
    req.originalUrl = req.url
  }

  req.on('close', function() {
    log(true)
  })

  var _end = res.end
  res.end = function(buf) {
    if (buf) bytesout += buf.length
    _end.apply(res, arguments)
    log()
  }
  next()
}


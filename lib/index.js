var express = require('express')
  , cookies = require('cookies')
  , utils = require('./utils')
  , Auth = require('./auth')
  , Storage = require('./storage')
  , Config = require('./config')
  , UError = require('./error').UserError
  , Middleware = require('./middleware')
  , Logger = require('./logger')
  , Cats = require('./status-cats')
  , basic_auth = Middleware.basic_auth
  , validate_name = Middleware.validate_name
  , media = Middleware.media
  , expect_json = Middleware.expect_json
  , Handlebars = require('handlebars')
  , fs = require('fs')
  , localList = require('./local-list')
  , search = require('./search')
  , marked = require('marked')

function match(regexp) {
	return function(req, res, next, value, name) {
		if (regexp.exec(value)) {
			next()
		} else {
			next('route')
		}
	}
}

module.exports = function(config_hash) {
	var config = new Config(config_hash)
      , auth = new Auth(config)
      , storage = new Storage(config, auth)

	search.configureStorage(storage);

	var can = function(action) {
		return function(req, res, next) {
            if (!req.authenticated_user) {
                if (req.remoteUserError) {
                    var msg = "can't "+action+' restricted package, ' + req.remoteUserError
                } else {
                    var msg = "can't "+action+" restricted package without auth, did you forget 'npm set always-auth true'?"
                }
                return next(new UError({
                    status: 403,
                    msg: msg,
                }))
            }

            req.authenticated_user.has_authorization_for_package(action, req.params.package, function(err, allowed) {
                if (allowed) {
    				next()
    			} else {
					next(new UError({
						status: 403,
						msg: 'user '+req.authenticated_user+' not allowed to '+action+' it'
					}))
				}
			});
		}
	}

	var app = express()

	// run in production mode by default, just in case
	// it shouldn't make any difference anyway
	app.set('env', process.env.NODE_ENV || 'production')

	function error_reporting_middleware(req, res, next) {
		var calls = 0
		res.report_error = res.report_error || function(err) {
			calls++
			if (err.status && err.status >= 400 && err.status < 600) {
				if (calls == 1) {
					res.status(err.status)
					res.send({error: err.message || 'unknown error'})
				}
			} else {
				Logger.logger.error({err: err}, 'unexpected error: @{!err.message}\n@{err.stack}')
				if (!res.status || !res.send) {
					Logger.logger.error('this is an error in express.js, please report this')
					res.destroy()
				} else if (calls == 1) {
					res.status(500)
					res.send({error: 'internal server error'})
				} else {
					// socket should be already closed
				}
			}
		}
		next()
	}

	app.use(error_reporting_middleware)
	app.use(Middleware.log_and_etagify)
	app.use(function(req, res, next) {
		res.setHeader('X-Powered-By', config.user_agent)
		next()
	})
	app.use(Cats.middleware)
    // I've no idea why, but if express.json is after basic_auth when
    // using an ldap backend, requests just hang in basic_auth - jasonrm
    app.use(express.json({strict: false, limit: config.max_body_size || '10mb'}))
    app.use(express.compress())
	app.use(basic_auth(function(user, password, next) {
       auth.authenticate(user, password, next)
    }))
	app.use(Middleware.anti_loop(config))

	// validate all of these params as a package name
	// this might be too harsh, so ask if it causes trouble
	app.param('package', validate_name)
	app.param('filename', validate_name)
	app.param('tag', validate_name)
	app.param('version', validate_name)
	app.param('revision', validate_name)

	// these can't be safely put into express url for some reason
	app.param('_rev', match(/^-rev$/))
	app.param('org_couchdb_user', match(/^org\.couchdb\.user:/))
	app.param('anything', match(/.*/))

/*  app.get('/-/all', function(req, res) {
		var https = require('https')
		var JSONStream = require('JSONStream')
		var request = require('request')({
			url: 'https://registry.npmjs.org/-/all',
		})
		.pipe(JSONStream.parse('*'))
		.on('data', function(d) {
			console.log(d)
		})
	})*/
	
	Handlebars.registerPartial('entry', fs.readFileSync(require.resolve('./GUI/entry.hbs'), 'utf8'));
	var template = Handlebars.compile(fs.readFileSync(require.resolve('./GUI/index.hbs'), 'utf8'));

	app.get('/', can('access'), function(req, res, next) {
		res.setHeader('Content-Type', 'text/html');

		storage.get_local(function(err, packages) {
			res.send(template({
				name:       config.title || "Sinopia",
				packages:   packages,
				baseUrl:    config.url_prefix || req.protocol + '://' + req.get('host') + '/'
			}));
		});
	});

	// TODO: anonymous user?
	app.get('/:package/:version?', can('access'), function(req, res, next) {
		storage.get_package(req.params.package, {req: req}, function(err, info) {
			if (err) return next(err)
			info = utils.filter_tarball_urls(info, req, config)

			var version = req.params.version
			  , t
			if (!version) {
				return res.send(info)
			}

			if ((t = utils.get_version(info, version)) != null) {
				return res.send(t)
			}

			if (info['dist-tags'] != null) {
				if (info['dist-tags'][version] != null) {
					version = info['dist-tags'][version]
					if ((t = utils.get_version(info, version)) != null) {
						return res.send(t)
					}
				}
			}

			return next(new UError({
				status: 404,
				message: 'version not found: ' + req.params.version
			}))
		})
	})

	app.get('/:package/-/:filename', can('access'), function(req, res, next) {
		var stream = storage.get_tarball(req.params.package, req.params.filename)
		stream.on('content-length', function(v) {
			res.header('Content-Length', v)
		})
		stream.on('error', function(err) {
			return res.report_error(err)
		})
		res.header('Content-Type', 'application/octet-stream')
		stream.pipe(res)
	})

	// searching packages
	app.get('/-/all/:anything?', function(req, res, next) {
		storage.search(req.param.startkey || 0, {req: req}, function(err, result) {
			if (err) return next(err)
			for (var pkg in result) {
				if (!config.allow_access(pkg, req.authenticated_user)) {
					delete result[pkg]
				}
			}
			return res.send(result)
		})
	})

	//app.get('/*', function(req, res) {
	//  proxy.request(req, res)
	//})

	// placeholder 'cause npm require to be authenticated to publish
	// we do not do any real authentication yet
	app.post('/_session', cookies.express(), function(req, res) {
		res.cookies.set('AuthSession', String(Math.random()), {
			// npmjs.org sets 10h expire
			expires: new Date(Date.now() + 10*60*60*1000)
		})
		res.send({'ok':true,'name':'somebody','roles':[]})
	})

	app.get('/-/user/:org_couchdb_user', function(req, res, next) {
		res.status(200)
		return res.send({
			ok: 'you are authenticated as "' + req.authenticated_user + '"',
		})
	})

	app.put('/-/user/:org_couchdb_user/:_rev?/:revision?', function(req, res, next) {
		if (req.authenticated_user != null) {
			res.status(201)
			return res.send({
				ok: 'you are authenticated as "' + req.authenticated_user + '"',
			})
		} else {
			if (typeof(req.body.name) !== 'string' || typeof(req.body.password) !== 'string') {
				return next(new UError({
					status: 400,
					message: 'user/password is not found in request (npm issue?)',
				}))
			}
			auth.add_user(req.body.name, req.body.password, function(err) {
				if (err) {
					if (err.status < 500 && err.message === 'this user already exists') {
						// with npm registering is the same as logging in
						// so we replace message in case of conflict
						return next(new UError({
							status: 409,
							message: 'bad username/password, access denied'
						}))
					}
					return next(err)
				}

				res.status(201)
				return res.send({
					ok: 'user "' + req.body.name + '" created',
				})
			})
		}
	})

	// Static
	app.get('/-/static/:file', function(req, res, next) {
		var file = __dirname + '/static/' + req.params.file;
		fs.exists(file, function(exists) {
			if(exists) {
				res.sendfile(file);
			}
			else {
				res.status(404);
				res.send("File Not Found");
			}
		});
	});

	app.get('/-/logo', function(req, res, next) {
		res.sendfile(config.logo ? config.logo : __dirname + "/static/logo.png");
	});

	// Search
	app.get('/-/search/:query', function(req, res, next) {
		var results = search.query(req.params.query),
			packages = [];

		var getData = function(i) {
			storage.get_package(results[i].ref, function(err, entry) {
				if(entry) {
					packages.push(entry.versions[entry['dist-tags'].latest]);
				}

				if(i >= results.length - 1) {
					res.send(packages);
				}
				else {
					getData(i + 1);
				}
			});
		};

		if(results.length) {
			getData(0);
		}
		else {
			res.send([]);
		}
	});

	// Readme
	marked.setOptions({
	  highlight: function (code) {
		return require('highlight.js').highlightAuto(code).value;
	  }
	});

	app.get('/-/readme/:name/:version', function(req, res, next) {
		storage.get_readme(req.params.name, req.params.version, function(readme) {
			res.send(marked(readme));
		});
	});

	// tagging a package
	app.put('/:package/:tag', can('publish'), media('application/json'), function(req, res, next) {
		if (typeof(req.body) !== 'string') return next('route')

		var tags = {}
		tags[req.params.tag] = req.body
		storage.add_tags(req.params.package, tags, function(err) {
			if (err) return next(err)
			res.status(201)
			return res.send({
				ok: 'package tagged'
			})
		})
	})

	// publishing a package
	app.put('/:package/:_rev?/:revision?', can('publish'), media('application/json'), expect_json, function(req, res, next) {
		var name = req.params.package

		if (Object.keys(req.body).length == 1 && utils.is_object(req.body.users)) {
			return next(new UError({
				// 501 status is more meaningful, but npm doesn't show error message for 5xx
				status: 404,
				message: 'npm star|unstar calls are not implemented',
			}))
		}

		try {
			var metadata = utils.validate_metadata(req.body, name)
		} catch(err) {
			return next(new UError({
				status: 422,
				message: 'bad incoming package data',
			}))
		}

		if (req.params._rev) {
			storage.change_package(name, metadata, req.params.revision, function(err) {
				after_change(err, 'package changed')
			})
		} else {
			storage.add_package(name, metadata, {req: req}, function(err) {
				after_change(err, 'created new package')
			})
		}

		function after_change(err, ok_message) {
			// old npm behaviour
			if (metadata._attachments == null) {
				if (err) return next(err)
				res.status(201)
				return res.send({
					ok: ok_message
				})
			}

			// npm-registry-client 0.3+ embeds tarball into the json upload
			// https://github.com/isaacs/npm-registry-client/commit/e9fbeb8b67f249394f735c74ef11fe4720d46ca0
			// issue #31, dealing with it here:

			if (typeof(metadata._attachments) != 'object'
			||  Object.keys(metadata._attachments).length != 1
			||  typeof(metadata.versions) != 'object'
			||  Object.keys(metadata.versions).length != 1) {

				// npm is doing something strange again
				// if this happens in normal circumstances, report it as a bug
				return next(new UError({
					status: 400,
					message: 'unsupported registry call',
				}))
			}

			if (err && err.status != 409) return next(err)

			// at this point document is either created or existed before
			var t1 = Object.keys(metadata._attachments)[0]
			create_tarball(t1, metadata._attachments[t1], function(err) {
				if (err) return next(err)

				var t2 = Object.keys(metadata.versions)[0]
				create_version(t2, metadata.versions[t2], function(err) {
					if (err) return next(err)

					add_tags(metadata['dist-tags'], function(err) {
						if (err) return next(err)

						res.status(201)
						return res.send({
							ok: ok_message
						})
					})
				})
			})
		}

		function create_tarball(filename, data, cb) {
			var stream = storage.add_tarball(name, filename)
			stream.on('error', function(err) {
				cb(err)
			})
			stream.on('success', function() {
				cb()
			})

			// this is dumb and memory-consuming, but what choices do we have?
			stream.end(new Buffer(data.data, 'base64'))
			stream.done()
		}

		function create_version(version, data, cb) {
			storage.add_version(name, version, data, null, cb)
		}

		function add_tags(tags, cb) {
			storage.add_tags(name, tags, cb)
		}
	})

	// unpublishing an entire package
	app.delete('/:package/-rev/*', can('publish'), function(req, res, next) {
		storage.remove_package(req.params.package, function(err) {
			if (err) return next(err)
			res.status(201)
			return res.send({
				ok: 'package removed'
			})
		})
	})

	// removing a tarball
	app.delete('/:package/-/:filename/-rev/:revision', can('publish'), function(req, res, next) {
		storage.remove_tarball(req.params.package, req.params.filename, req.params.revision, function(err) {
			if (err) return next(err)
			res.status(201)
			return res.send({
				ok: 'tarball removed'
			})
		})
	})

	// uploading package tarball
	app.put('/:package/-/:filename/*', can('publish'), media('application/octet-stream'), function(req, res, next) {
		var name = req.params.package

		var stream = storage.add_tarball(name, req.params.filename)
		req.pipe(stream)

		// checking if end event came before closing
		var complete = false
		req.on('end', function() {
			complete = true
			stream.done()
		})
		req.on('close', function() {
			if (!complete) {
				stream.abort()
			}
		})

		stream.on('error', function(err) {
			return res.report_error(err)
		})
		stream.on('success', function() {
			res.status(201)
			return res.send({
				ok: 'tarball uploaded successfully'
			})
		})
	})

	// adding a version
	app.put('/:package/:version/-tag/:tag', can('publish'), media('application/json'), expect_json, function(req, res, next) {
		var name = req.params.package
		  , version = req.params.version
		  , tag = req.params.tag

		storage.add_version(name, version, req.body, tag, function(err) {
			if (err) return next(err)
			res.status(201)
			return res.send({
				ok: 'package published'
			})
		})
	})

	app.use(app.router)
	app.use(function(err, req, res, next) {
		if (typeof(res.report_error) !== 'function') {
			// in case of very early error this middleware may not be loaded before error is generated
			// fixing that
			error_reporting_middleware(req, res, function(){})
		}
		res.report_error(err)
	})

	return app
}


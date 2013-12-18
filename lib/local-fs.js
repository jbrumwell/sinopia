var fs = require('fs')
  , fsExt = require('fs-ext')
  , Path = require('path')
  , mystreams = require('./streams')
  , Logger = require('./logger')
  , FSError = require('./error').FSError

function make_directories(dest, cb) {
	var dir = Path.dirname(dest)
	if (dir === '.' || dir === '..') return cb()
	fs.mkdir(dir, function(err) {
		if (err && err.code === 'ENOENT') {
			make_directories(dir, function() {
				fs.mkdir(dir, cb)
			})
		} else {
			cb()
		}
	})
}

function write(dest, data, cb) {
	var safe_write = function(cb) {
		var tmpname = dest + '.tmp' + String(Math.random()).substr(2)
		fs.writeFile(tmpname, data, function(err) {
			if (err) return cb(err)
                        
                        if (require('os').platform().indexOf('win') === -1) {                            
			    fs.rename(tmpname, dest, cb)
                        } else {
                            fs.writeFile(dest, data, function(err) {                                
                                fs.unlink(tmpname, function(err2) {
                                    cb(err ? err : err2);
                                });
                            });                            
                        }
		})
	}

	safe_write(function(err) {
		if (err && err.code === 'ENOENT') {
			make_directories(dest, function() {
				safe_write(cb)
			})
		} else {
			cb(err)
		}
	})
}

function write_stream(name) {
	var stream = new mystreams.UploadTarballStream()

	var _ended = 0
	stream.on('end', function() {
		_ended = 1
	})

	fs.exists(name, function(exists) {
		if (exists) return stream.emit('error', new FSError('EEXISTS'))

		var tmpname = name + '.tmp-'+String(Math.random()).replace(/^0\./, '')
		  , file = fs.createWriteStream(tmpname)
		  , opened = false
		stream.pipe(file)

		stream.done = function() {
			function onend() {
				file.on('close', function() {                                    
					fs.rename(tmpname, name, function(err) {
						if (err) stream.emit('error', err)
						stream.emit('success')
					})
				})
				file.destroySoon()
			}
			if (_ended) {
				onend()
			} else {
				stream.on('end', onend)
			}
		}
		stream.abort = function() {
			if (opened) {
				opened = false
				file.on('close', function() {
					fs.unlink(tmpname, function(){})
				})
			}
			file.destroySoon()
		}
		file.on('open', function() {
			opened = true
			// re-emitting open because it's handled in storage.js
			stream.emit('open')
		})
		file.on('error', function(err) {
			stream.emit('error', err)
		})
	})
	return stream
}

function read_stream(name, stream, callback) {
	return fs.createReadStream(name)
}

function create(name, contents, callback) {
	fs.exists(name, function(exists) {
		if (exists) return callback(new FSError('EEXISTS'))
		write(name, contents, callback)
	})
}

function update(name, contents, callback) {
	fs.exists(name, function(exists) {
		if (!exists) return callback(new FSError('ENOENT'))
		write(name, contents, callback)
	})
}

function read(name, callback) {
	fs.readFile(name, callback)
}

// open and flock with exponential backoff
function open_flock(name, opmod, flmod, tries, backoff, cb) {
	fs.open(name, opmod, function(err, fd) {
		if (err) return cb(err, fd)
                
                if (require('os').platform().indexOf('win') === -1) {
		    fsExt.flock(fd, flmod, function(err) {
		    	if (err) {
		    		if (!tries) {
		    			fs.close(fd, function() {
		    				cb(err)
		    			})
		    		} else {
		    			fs.close(fd, function() {
		    				setTimeout(function() {
		    					open_flock(name, opmod, flmod, tries-1, backoff*2, cb)
		    				}, backoff)
		    			})
		    		}
		    	} else {
		    		cb(null, fd)
		    	}
		    })
                } else {
                    fs.exists(name + '.lock', function(exists) {
                        if (exists) {
                            if ( !tries ) {
                                fs.close(fd, function() {
                                    cb(err)
                                })
                            } else {
                                fs.close(fd, function() {
                                    setTimeout(function() {
                                        open_flock(name, opmod, flmod, tries - 1, backoff * 2, cb)
                                    }, backoff)
                                })
                            }
                        } else {
                            fs.writeFile(name + '.lock', Date.now(), function(err) {
                               cb(err, fd); 
                            });                            
                        }
                    });                    
                }
                
	})
} 

function unlock_and_close(file, fd, callback) {
    if (require('os').platform().indexOf('win') === -1) {
        fs.close(fd,callback);
    } else {
        fs.exists(file + '.lock', function(exists) {
           if (exists) {
               fs.unlink(file + '.lock', function(err) {
                   callback(err);
               });
           } else {
               callback();
           } 
        });
    }
}
// this function neither unlocks file nor closes it
// it'll have to be done manually later
function lock_and_read(name, callback) {
	open_flock(name, 'r', 'exnb', 4, 10, function(err, fd) {
		if (err) return callback(err, fd)

		fs.fstat(fd, function(err, st) {
			if (err) return callback(err, fd)

			var buffer = new Buffer(st.size)
			fs.read(fd, buffer, 0, st.size, null, function(err, bytesRead, buffer) {
				if (bytesRead != st.size) return callback(new Error('st.size != bytesRead'), fd)

				callback(null, fd, buffer)
			})
		})
	})
}

function Storage(path) {
	this.path = path
	this.logger = Logger.logger.child({sub: 'fs'})
	try {
		fs.mkdirSync(path)
		this.logger.warn({path: path}, 'created new packages directory: @{path}')
	} catch(err) {
		if (err.code !== 'EEXIST') throw new Error(err)
	}
}

Storage.prototype.read = function(name, cb) {
	read(this.path + '/' + name, cb)
}

Storage.prototype.read_json = function(name, cb) {
	read(this.path + '/' + name, function(err, res) {
		if (err) return cb(err)

		var args = []
		try {
			args = [null, JSON.parse(res.toString('utf8'))]
		} catch(err) {
			args = [err]
		}
                
		cb.apply(null, args)
	})
}

Storage.prototype.unlock_and_close = function(name, fd, cb) {
    unlock_and_close(this.path + '/' +name, fd, cb);
};

Storage.prototype.lock_and_read = function(name, cb) {
	lock_and_read(this.path + '/' + name, cb)
}

Storage.prototype.lock_and_read_json = function(name, cb) {
	lock_and_read(this.path + '/' + name, function(err, fd, res) {
		if (err) return cb(err, fd)

		var args = []
		try {
			args = [null, fd, JSON.parse(res.toString('utf8'))]
		} catch(err) {
			args = [err, fd]
		}
		cb.apply(null, args)
	})
}

Storage.prototype.path_to = function(file) {
	return this.path + '/' + file
}

Storage.prototype.create = function(name, value, cb) {
	create(this.path + '/' + name, value, cb)
}

Storage.prototype.create_json = function(name, value, cb) {
	create(this.path + '/' + name, JSON.stringify(value, null, '\t'), cb)
}

Storage.prototype.update = function(name, value, cb) {
	update(this.path + '/' + name, value, cb)
}

Storage.prototype.update_json = function(name, value, cb) {
	update(this.path + '/' + name, JSON.stringify(value, null, '\t'), cb)
}

Storage.prototype.write = function(name, value, cb) {
	write(this.path + '/' + name, value, cb)
}

Storage.prototype.write_json = function(name, value, cb) {
	write(this.path + '/' + name, JSON.stringify(value, null, '\t'), cb)
}

Storage.prototype.write_stream = function(name, value, cb) {
	return write_stream(this.path + '/' + name, value, cb)
}

Storage.prototype.read_stream = function(name, cb) {
	return read_stream(this.path + '/' + name, cb)
}

Storage.prototype.unlink = function(name, cb) {
	fs.unlink(this.path + '/' + name, cb)
}

Storage.prototype.rmdir = function(name, cb) {
	fs.rmdir(this.path + '/' + name, cb)
}

module.exports = Storage


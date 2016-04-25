var fs = require('fs')
  , EventEmitter = require('events').EventEmitter
  , path = require('path')
  , mkdirp = require('mkdirp')
  , moment = require('moment')
  , util = require('./util');

module.exports = Rotator;

/*
  Stream-Rotate
  
  Returns a file stream that auto rotates based on size or date
  
  Options
  
    - `path`: {String}
    - `name`: {String}
    - `ext`: {String} (default: 'log')
    - `size`: {Number} Max file size in bytes (optional)
    - `freq`: {} (optional)
    - `retention`: {Number} (default: 2)
    - `poll`: {Number} (default: null) in seconds
    - `compress`: {Boolean} {default: false}
    - `flags`: {String} (default: 'a')
    - `encoding`: {Mixed} (default: null)
    - `mode`: {Number} (default: 0600)
    - `ts_format`: {String} (default: 'DDMMYY_HHmmss')
    - `boundary`: {String} (default:null choices:['daily','hourly','minutely','secondly'])
*/

function Rotator(options){
  
  //if(!(this instanceof Rotator)) return new Rotator(options);
  
  var self = this;
  this.eventedOpen = false; // Track if an open event has been sent, consumer will only
                            // get one open event per stream, regardless of rotations
  this.ready = false;       // ready is true when there is an open underlying stream
                            // otherwise is false
  this._queue = [];         // Internal cache, writes are saved here while underlying
                            // stream not ready
  this.options = util.merge({
    ext: 'log'
  , retention: 2
  , poll: null
  , flags: 'a'
  , encoding: null
  , mode: 0600
  , ts_format: 'DDMMYY_HHmmss'
  , boundary: null
  }, options);
  
  // max size for the file, converted to integer bytes
  this._size = util.getBytes(this.options.size);

  // This regex ensures that matching is compatible with whatever format is valued in the ts_format property.
  this._regex = new RegExp("^"+this.options.name+"[_].*\."+this.options.ext);
  
  // verify the path
  this._checkPath();
  
  this._filename = this._getName(); // cache the filename
}


Rotator.prototype.__proto__ = EventEmitter.prototype;

// Verify the base directory exists or is creatable
Rotator.prototype._checkPath = function(){
  var self = this;
  fs.stat(this.options.path, function(err, stat){
    if(err) mkdirp(self.options.path, function(err){
      if(err) self.error(err);
      else self._create();
    });
    else if(!stat.isDirectory()) 
      self.error(new Error("File exists, can't create Directory."));
    else self._create();
  });
};

// Function called internally when a need to open a new
// underlying stream has been identified.
// The very first stream opened will emit an 'open' event
// to the consumer, but subsequent streams will only emit 
// a 'rotated-on' event.
Rotator.prototype._create = function(){
  var self = this
    , opts = this.options
    , file = this._getName();

  this._checkRetention();

  try {
    // create the underlying stream... but notice that even though it
    // seems like a synchronous method, the stream will not be open
    // upon return of the call, you have to wait until open event
    // before you can call stat or write
    this.stream = fs.createWriteStream(file, {
      flags: opts.flags, encoding: opts.encoding, mode: opts.mode});
    // file may not be created immediately
    // call stat asynchronously
    this.stream.on('open',function(fd){
      fs.stat(file, function(err, stat){
        // we can't fail. creating a stream and checking the fd may not exist
        if(err) self._stat = { size: 0, ctime: new Date(), mtime: new Date() };
        else self._stat = stat;
        self._attachListeners();
        // don't set it back to ready until file has been created
        self.ready = true;
        // send the 'open' event to the consumer
        // only once for the whole stream 
        // and not on every 'open' for the 
        // underlying streams...
        // same thing with the 'close' event
        if(!self.eventedOpen){
            self.eventedOpen = true;
            self.emit('open',fd);
        }
        // do send the 'rotated-on' event
        // for every stream 'open'
        self.emit('rotated-on',file);
      });
    });
  } catch (err){
    this.error(err);
  }
};


Rotator.prototype._checkRetention = function(){
  var self = this;
  fs.readdir(this.options.path, function(err, files){
    if(err) return self.error(err);
    
    var matches = files.filter(function(file){
      return file.match(self._regex);
    }).sort();
    
    while(matches.length > self.options.retention){
      fs.unlink(path.join(self.options.path, matches.shift()), function(err){
        if(err) self.error(err);
      })
    }
  });
};

Rotator.prototype._attachListeners = function(){
  var self = this;
  ['drain', 'error', 'pipe'].forEach(function(event){
    self.stream.on(event, function(i){
      self.emit(event, i);
    });
  });
  
  if(self.options.poll){
    self._poll = setInterval(function(){
      fs.stat(self._getName(), function(err, stat){
        self._stat = (err) ? {size: 0, ctime: new Date(), mtime: new Date() } : stat;
      });
    }, self.options.poll * 1000);
  }
  
  if(self.options.freq){
    var freq = self.options.freq
      , parts = (isNaN(freq)) ? freq.trim().match(/([0-9]+)([smhdwMy])/) : [freq, freq, 's']
      , ctime = moment(self._stat.ctime)
      , later = moment(self._stat.ctime).add(parts[2], parts[1]);

    self._freq = setTimeout(function(){
      self._expired = true;
    }, later.diff(ctime));
  }
  
};


// _check returns true if it is ok to continue writing to
// the current stream, based on size, longevity, boundary crossing, etc.,
// and false if no more writing should occur, at which point this 
// function will start the rotation 
Rotator.prototype._check = function(size){
    var passed = true; // rotate the file if false

    // don't continue checking if stream is not ready
    // we haven't started yet, or we are in the middle of
    // a rotation already
    if(!this.ready) return false;
    // start with a fresh copy of stat
    this._stat = fs.statSync(this._getName());

    if(this._stat.size === 0) return true; // if the file doesn't have any bytes... keep writing to it

    // if size rotation, check if the current write will
    // make it go over
    if (this._size && ((this._stat.size + (size || 0)) > this._size))
        passed = false;
    
    // check boundary rotations
    if(passed && this.options.boundary){
        var now = moment();
        var thefiles = moment(this._stat.mtime);
        var difference = now - thefiles;
        if(this.options.boundary === 'daily' && 
            (difference > 86400000 || now.date() != thefiles.date() || now.month() != thefiles.month() || now.year() != thefiles.year())){
            passed = false;
        }
        if(this.options.boundary === 'hourly' &&
            (difference > 3600000 || now.date() != thefiles.date() || now.hour() != thefiles.hour())){
            passed = false;
        }
        if(this.options.boundary === 'minutely' &&
            (difference > 60000 || now.date() != thefiles.date() || now.hour() != thefiles.hour() || now.minute() != thefiles.minute())){
            passed = false;
        }
        if(this.options.boundary === 'secondly' &&
            (difference > 1000 || now.date() != thefiles.date() || now.hour() != thefiles.hour() || now.minute() != thefiles.minute() || now.seconds() != thefiles.seconds())){
            passed = false;
        }
    }

    // the timeout has expired for time rotation
    if(this._expired) passed = false;
    
    // if 
    if(!passed) this._move();

    return passed;
};

Rotator.prototype._move = function(){
  var self = this;
  this.ready = false;
  var stat = this._stat;
  this._stat = null;
  this.stream.on('close',function(i){
    
  // in case the requested file already 
  // exists, increment until one is available
  var varName = 0;
  var newName;
  while(true){
    newName = self._getName(stat.mtime,varName);
    try{
      fs.statSync(newName);
      varName++;
    }catch(err){
      if(err.code==='ENOENT')
        break;
    }
  }
  try
  {
      // Based on how quickly the called process runs, async rename does not always complete before
      fs.renameSync(self._getName(), newName);
  }
  catch (err)
  {
    self.error(err);
  };
  
  self.stream.removeAllListeners();

  self._create();
  self.emit('rotated-off',newName);;

  });
  this.flush();
  this.stream.destroy();

};

// close is the correct way to
// terminate the stream
Rotator.prototype.close = function(){
    var self = this;
    if(this._queue.length > 0 && this.ready){
        this.flush();
    }
    clearInterval(this._poll);
    clearTimeout(this._freq);
    this._expired = false;
    // protect the code in case a stream
    // hasn't been created yet
    if(this.stream){
        this.stream.on('close',function(i){
            self.emit('close',i);
        });
        this.stream.end();
    }
};

// flush will attempt to write any 
// pending items from the queue to
// the actual stream
Rotator.prototype.flush = function(){
    this.write('');
};

// _getName returns either the external stream
// filename or an appropriately built filename
// to rotate the current stream to.
// thetime is the mtime of the stream
// and variable is the next available number
// to avoid overwriting files with same names
// uses _getNameStatic for the functionality
Rotator.prototype._getName = function(thetime,variable){
    // thetime is the file timestamp to generate a name for
    // try the cache first
    if(typeof(thetime)==='undefined' && typeof(this._filename) !== 'undefined')
        return this._filename;
    return Rotator._getNameStatic(this.options,thetime,variable);
};

// _getNameStatic -- static implementation of _getName to facilitate unit testing 
Rotator._getNameStatic = function(options,thetime,variable){
    // generate the main part
    var file = path.join(options.path, options.name);
    // if thetime and/or variable have been passed, it wants
    // a filename to rotate the file to
    if(thetime) file += '_' + moment(thetime).format(options.ts_format);
    if(variable) file += '_' + variable;
    // add the extension
    file += "." + options.ext;
    return file;
};

Rotator.prototype.write = function(data, encoding){
  if(this.halt) return this.error(new Error('Stream is BROKEN'));
  if(data.length) this._queue.push([data, encoding]);
  if(!this.ready) return this;
  
  while(this.ready && this._queue.length){
    var item = this._queue.shift();
    
    if(this._check(item[0].length)){
      this.stream.write(item[0], item[1]);
    }
    else // put it back on the queue
      this._queue.unshift(item);
  }
};


Rotator.prototype.__defineGetter__('writable', function(){
  if(!this.stream) return false;
  return this.stream.writable;
});


['end', 'destroy', 'destroySoon'].forEach(function(method){
  Rotator.prototype[method] = function(){
    clearTimeout(this._freq);
    clearInterval(this._poll);
    this._freq = null;
    this._poll = null;
    if(this.stream && this.stream.apply ) return this.stream.apply(this.stream, arguments);
    return this;
  }
});


Rotator.prototype.error = function(err){
  this.halt = true;
  this.emit('error', err);
  return this;
};


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
*/

function Rotator(options){
  
  if(!(this instanceof Rotator)) return new Rotator(options);
  
  var self = this;
  
  this.ready = false;
  this._queue = [];
  this.options = util.merge({
    ext: 'log'
  , retention: 2
  , poll: null
  , flags: 'a'
  , encoding: null
  , mode: 0600
  , ts_format: 'DDMMYY_HHmmss'
  }, options);
  
  this._size = util.getBytes(this.options.size);

  // This regex ensures that matching is compatible with whatever format is valued in the ts_format property.
  this._regex = new RegExp("^"+this.options.name+"[_].*\."+this.options.ext);
  
  // Commented out original regex - will not work with all ts_format options
  //this._regex = new RegExp("^"+this.options.name+"[_0-9]{14}\."+this.options.ext);
  
  this._checkPath();
}


Rotator.prototype.__proto__ = EventEmitter.prototype;


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


Rotator.prototype._create = function(file){
  var self = this
    , opts = this.options
    , file = this._getName();

  //this._checkRetention();
  this._checkRetentionSync();

  try {
    this.stream = fs.createWriteStream(file, {
      flags: opts.flags, encoding: opts.encoding, mode: opts.mode});
    // file may not be created immediately
    // stat will fail, until open event
    this.stream.on('open',function(fd){
      fs.stat(file, function(err, stat){
        // we can't fail. creating a stream and checking the fd may not exist
        if(err) self._stat = { size: 0, ctime: new Date(), mtime: new Date() };
        else self._stat = stat;
        self._attachListeners();
        // don't set it back to ready until file has been created
        self.ready = true;    
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

Rotator.prototype._checkRetentionSync = function () {
    var self = this;
    var files = null;

    try
    {
        files = fs.readdirSync(this.options.path);
    }
    catch (exception)
    {
        return self.error(exception.message);
    }

    var matches = files.filter(function (file) {
        return file.match(self._regex);
    }).sort();

    while (matches.length > self.options.retention) {
        try
        {
            if (fs.existsSync(path.join(self.options.path, matches[0]))) {
                fs.unlinkSync(path.join(self.options.path, matches.shift()));
            }
        }
        catch (exception) {
            self.error(exception.message);
        }
    }
};

Rotator.prototype._attachListeners = function(){
  var self = this;
  ['drain', 'error', 'close', 'pipe'].forEach(function(event){
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


Rotator.prototype._check = function(size){
  var passed = true;
  // no point of checking it not ready
  if(!this.ready && this._stat.size === 0) return passed;
  
  if (this._size && ((this._stat.size + (size || 0)) > this._size))
      passed = false;
  else
  {
      this._stat.size += (size || 0);
      this._checkRotation();
  }
  
if(this.options.boundary){
  var now = moment();
  var thefiles = moment(this._stat.mtime);
  if(this.options.boundary === 'daily' && 
    (now.date() != thefiles.date() || now.month() != thefiles.month() || now.year() != thefiles.year())){
    passed = false;
  }
  if(this.options.boundary === 'hourly' &&
    (now.date() != thefiles.date() || now.hour() != thefiles.hour())){
    passed = false;
  }
  if(this.options.boundary === 'minutely' &&
    (now.date() != thefiles.date() || now.hour() != thefiles.hour() || now.minute() != thefiles.minute())){
    passed = false;
  }
  if(this.options.boundary === 'secondly' &&
    (now.date() != thefiles.date() || now.hour() != thefiles.hour() || now.minute() != thefiles.minute() || now.seconds() != thefiles.seconds())){
    passed = false;
  }
}


  if (this._expired)
      passed = false;
  
  if (!passed)
      this._moveSync();
  
  return passed;
};

Rotator.prototype._checkRotation = function(){
  
  // This code implements a check to determine if files need to be rotated upon initialization.
  // Current code in _attachListener provides the means to rotate files only if the process remains active
  // longer than the rotation threshold.  For short-lived processes such as maintenance jobs, log file
  // may never be rotated.  This check fixes this problem.
  if (this.options.freq)
  {
    var freq = this.options.freq
      , parts = (isNaN(freq)) ? freq.trim().match(/([0-9]+)([smhdwMy])/) : [freq, freq, 's']
      , ctime = moment(this._stat.ctime);

    var base = Date.now()
      , current = moment(base)
      , interval = moment(base).add(parts[2], parts[1]);

    var diffAbs = current.diff(ctime);
    var absIntv = interval.diff(base);
    var result = diffAbs / absIntv;

    if (Math.floor(result) > 0)
        this._expired = true;
  }
};

Rotator.prototype._moveSync = function(){
  var self = this;
  this.ready = false;
  var stat = this._stat;
  this._stat = null;
  this.stream.removeAllListeners();
  clearInterval(this._poll);
  clearTimeout(this._freq);
  this._expired = false;
  this.stream.destroy();

  // in case the requested file already 
  // exists, increment until one is available
  var varName = 0;
  var newName;
  while(true){
    newName = this._getName(stat,varName);
    try{
      fs.statSync(newName);
      varName++;
    }catch(err){
      if(err.errno===-2) // file doesn't exist
        break;
    }
  }
  try
  {
      // Based on how quickly the called process runs, async rename does not always complete before
      fs.renameSync(this._getName(), newName);
  }
  catch (err)
  {
    self.error(err);
  };

  self._create();
  self.emit('rotated');
};

// if time based, use the timestamp of the
// file, instead of now (it could be an old file)
Rotator.prototype._getName = function(ts,variable){
  var file = path.join(this.options.path, this.options.name);
  if(ts) file += '_' + moment(ts.mtime).format(this.options.ts_format);
  if(variable) file += '_' + variable;
  file += "." + this.options.ext;
  return file;
};


Rotator.prototype.write = function(data, encoding){
  if(this.halt) return this.error(new Error('Stream is BROKEN'));
  this._queue.push([data, encoding]);
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

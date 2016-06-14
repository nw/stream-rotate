var should = require('should');
var randomstring = require('randomstring');
var moment = require('moment');
var fs = require('fs');
var fspath = require('path');
var rotator = require('../lib/stream-rotate');
var fakeFS = require('mock-fs');
require('array.prototype.find').shim();

var isDebug = !! process.argv.find(function(element){return element==='-d';});

describe('Rotator internal', function(){
  var path = './log/';
  var fn = 'fn';
  var options = {path:path,name:fn,ts_format:'DDMMYY',ext:'log'};
  it('should return the plain filename',function(){
    rotator._getNameStatic(options).should.equal(fspath.join(path,fn + '.log'));
  });

  it('should return the rotated filename',function(){
    var t = moment("12-25-1995", "MM-DD-YYYY");
    rotator._getNameStatic(options,t).should.equal(fspath.join(path,fn + '_251295.log' ));
  });

  it('should return the rotated filename + variable', function(){
    var t = moment("12-25-1995", "MM-DD-YYYY");
    rotator._getNameStatic(options,t,456).should.equal(fspath.join(path,fn + '_251295_456.log'));
  });

});


describe('Rotator', function(){

  var path = './log/';

  beforeEach(function(){
    resetDirectory(path);
  });

  afterEach(function(){
    resetDirectory(path);
  })


  it('should rotate on small file size', function(done){
    executeTest(this,3000,path,'size',1000,150,20,100,0,done);
  });

  it('should rotate on large size', function(done){
    executeTest(this,3000,path,'size',20000,5000,10,100,0,done);
  });

  it('should only keep three files', function(done){
    executeTest(this,3000,path,'retention',300,75,20,3,0,done);
  });

  it('should rotate based on time');

  it('should rotate daily', function(done){
    executeTest(this,2000,path,'daily',300,50,10,100,86401,done);
  });

  it('should rotate hourly', function(done){
    executeTest(this,2000,path,'hourly',2000,300,10,100,3601,done); 
  });

  it('should rotate minutely', function(done){
    executeTest(this,2000,path,'minutely',2000,300,3,100,61,done); 
  });

  it('should rotate secondly', function(done){
    executeTest(this,10000,path,'secondly',100000,300,200,100,2,done); 
  });

  it('should not delete previous content', function(done){
    fs.mkdirSync(path);
    fs.writeFileSync(fspath.join(path,'notdelete.log'),'abcdefg');
    var options = {
      path: path,
      name: 'notdelete',
      freq: '1d',
      retention: 3,
      size: 1000000,
      boundary: 'daily'
    };
    var r = new rotator(options);
    r.on('rotated-on', function(x) {
      r.write("1234567890");
      r.close();
    });
    r.on('close', function(xx){
      setTimeout(function(){
        var r2 = new rotator(options);
        r2.on('close', function(x){
          var rc = analyzeFiles(path);
          //console.log(rc);
          (30).should.equal(rc.totalSize);
          done();
        });
        r2.on('rotated-on', function(x) {
          r2.write("1234567890123");
          r2.close();
        });

      },0);
    });

  });

  it('should not throw when attempting to write before the open event', function(done) {
    var options = {
      path: path,
      name: 'donotbreakifidontwait',
      freq: '1d',
      retention: 3,
      size: 20,
      boundary: 'hourly'
    };
    var r = new rotator(options);
    (function() {
      r.write("test");
      r.close();
      done();
    }).should.not.throw();
  });


  it('should reopen when another stream renames an open stream', function(done) {
    var options = {
      path: path,
      name: 'rotatethis',

      retention: 20,
      size: 20,
      boundary: 'hourly'
    };
    if(!isDebug) {
      done();
      return;
    }
    var r = new rotator(options);
    r.name = "r1";
    r.on('open', function(x) {
      r.write('1234567');
      setTimeout(function() {
        r.flush();
        var r2 = new rotator(options);
        r2.name = "r2";
        var round = 0;
        r2.on('rotated-on', function(x) {
          if (round == 0) {
            round++;
            r2.write('abcdefgh');
            r2.write(randomstring.generate(18));
          }
          else if (round == 1) {
            round++;
            r2.write('ABCDEFGH');
            setTimeout(function() {
              r2.flush();
              r.write('Z');
              setTimeout(function() {
                r.flush();
                var ready = 0;
                r2.on('close', function(x) {
                  ready++;
                });
                r.on('close', function(x) {
                  ready++;
                });
                r2.close();
                r.close();
                setInterval(function() {
                  var executed = false;
                  if (ready >= 2 && !executed) {
                    executed = true;
                    var rc = analyzeFiles(path);
                    //console.dir(rc);
                    rc.totalCount.should.equal(3);
                    rc.totalSize.should.equal(42);
                    //console.dir(r);
                    //console.dir(r2);
                    done();

                  }
                }, 200);

              }, 200);
            }, 200);

          }
        });
      }, 200);
    });

  });


});

function executeTest(self,timeout,filepath,testType,testSize,bufferSize,iterations,retention,offset,done){
  self.timeout(timeout);
  var filebase = testType + '-rotator';
  var filename = fspath.join(filepath , filebase + '.log');
  var stat;
  fs.mkdirSync(filepath);
  fs.writeFileSync(filename, randomstring.generate(200));
  if(offset){
    stat = fs.statSync(filename);
    stat.mtime = new Date(stat.mtime.getTime()-(offset*1000));
    fs.utimesSync(filename,stat.mtime,stat.mtime);
  }
  var options = {
    path: filepath,
    name: filebase,
    retention: retention,
    size: testSize
  };
  if(testType==='daily' || testType==='hourly' || testType==='minutely' || testType==='secondly')
    options.boundary = testType;
  var r = new rotator(options);
  r.should.be.an.instanceof(rotator);

  if(isDebug){
    r.on('open', function(x){
      console.log('open:' + x);
    });

    r.on('error', function(err){
      console.log(err);
    });
    r.on('drain', function(){
      console.log('DRAIN');
    });
    r.on('pipe', function(){
      console.log('PIPE');
    });
    r.on('close',function(){
      console.log("closed:" + filename);
    });
    r.on('rotated-on',function(x){
      console.log("rotated-on:" + x);
    });
    r.on('rotated-off', function(f){
      var fstat = fs.statSync(f);
      console.log("rotated-off:" + f + ' ' + fstat.size + ' ' + moment(fstat.mtime).format());
    });
  }
  var ii = 0;
  var countWrites = 0;
  function work(){
    ii++;
    if (ii === iterations) {
      r.flush();
      r.on('close',function(){
        var results = analyzeFiles(filepath);
        if(isDebug)
          console.log(results);
        results.maxSize.should.be.lessThan(testSize+1);
        var timeSpread = results.latest - results.earliest;
        var totalWriten = ( countWrites * bufferSize ) + 200;
        if(testType!=='retention')
          totalWriten.should.equal(results.totalSize);
        if(testType==='retention')
          results.totalCount.should.equal(retention + 1);
        if(testType==='daily')
          timeSpread.should.be.greaterThan(86400000);
        if(testType==='hourly')
          timeSpread.should.be.greaterThan(360000);
        if(testType==='minutely')
          timeSpread.should.be.greaterThan(60000);
        if(testType==='secondly')
          timeSpread.should.be.greaterThan(1000);
        return setTimeout(done,10);
      });
      r.close();
      return;
    }
    var rc = r.write(randomstring.generate(bufferSize));
    countWrites++;
    return setTimeout(work,5);
  }
  setTimeout(work,0);

}

function deleteFolderRecursive(path) {
  if( fs.existsSync(path) ) {
    fs.readdirSync(path).forEach(function(file,index){
      var curPath = fspath.join(path , file);
      if(fs.lstatSync(curPath).isDirectory()) { // recurse
        deleteFolderRecursive(curPath);
      } else { // delete file
        fs.unlinkSync(curPath);
      }
    });
    fs.rmdirSync(path);
  }
}

function analyzeFiles(path){
  var files = fs.readdirSync(path);
  var earliest = moment().add(1,'year');
  var latest = moment().subtract(1,'year');
  var stat;
  var minSize = 100000000;
  var maxSize = 0;
  var totalSize = 0;
  files.forEach(function(file){
    stat = fs.statSync(path+file);
    maxSize = Math.max(maxSize,stat.size);
    minSize = Math.min(minSize,stat.size);
    totalSize += stat.size;
    latest = Math.max(latest,moment(stat.mtime));
    earliest = Math.min(earliest,moment(stat.mtime));
    //var t = fs.readFileSync(path+file,'utf8');
    //console.log(t);
  });
  return {
    earliest:earliest,
    latest:latest,
    minSize:minSize,
    maxSize:maxSize,
    totalSize:totalSize,
    totalCount:files.length
  };
}

function resetDirectory(filepath){
  if(isDebug)
    deleteFolderRecursive(filepath);
  else
    fakeFS({'.':{}});
}
